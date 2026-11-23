# 从星型 Hub 到多点对多点（P2P）的演进设计

> 2026-11-23。范围：`dsh-remote-hub`（viewer 侧反代）与 `dsh-remote-agent`（backend 侧身份发布）。

## 1. 现状与瓶颈

今天的形态是**星型**：一个 `dsh web`（Hub）通过 `ssh -L` 把每个 backend 反代到 `/remotes/<id>/`，
backend 侧用 `dsh-remote-agent` 把 launch token 写到 `$DSH_HOME/remote-agent.json` 供 Hub 经 ssh 读取。

星型的瓶颈不在代理代码，而在三处**隐式中枢**：

| 中枢 | 表现 | 0.7.0 的处理 |
|---|---|---|
| 共享可变状态 | 隧道登记文件按 `DSH_HOME` 单例，多 Hub 互清隧道 | 改为**每进程一个登记文件** + 启动清理只按归属判断 |
| 单写者假设 | 同 `DSH_HOME` 两个 Hub 抢端口、同写 session 存储 | 加 `remote-hub.lock`，第二个实例明确报错而不是互杀 |
| ssh 依赖 | backend 必须被 Hub `ssh` 登录 | 尚未解决（M2/M3） |

## 2. 目标形态

**每个 dsh 实例都是节点（node）**，没有中心：任一节点既能被人当面板用（viewer），也能被别人访问（backend），
两个节点互为 viewer/backend 也合法。连接是节点间直连或经中继，注册表是**每个节点自己的**，没有全局文件、没有全局端口。

```
   n100 ──────── wsl ──────── e5          ← 任意两节点之间可建立"看/被看"关系
     │            │            │
     └── 各自的 DSH_HOME、会话、工单、凭据 ──┘   （状态永不出节点）
```

## 3. 分层设计

### 3.1 身份（M2）

- 每个节点生成一对 ed25519 节点密钥，`nodeId = base32(pubkey)`，存在 `$DSH_HOME/node-identity.json`（0600）。
- 访问凭证：launch token 由节点私钥签发短期 JWT（`aud=nodeId`、`ttl≤10min`、`scope=panel|session-create`），
  替代今天"读文件拿明文 token"的方式；旧 `remote-agent.json` 保留为兼容路径。
- 配对：一次性短码（`XXXX-XXXX`）交换并固定对端公钥；撤销 = 删除对端公钥。信任关系只在本节点注册表里。

### 3.2 传输（M2–M3，连接层抽象）

把"怎么到达对端"抽象成 connector，Hub 的代理代码不变：

| connector | 说明 | 场景 |
|---|---|---|
| `ssh-tunnel` | 现状，`ssh -L` 到 `127.0.0.1:<port>` | 已有 ssh 信任 |
| `direct-http` | 直连 `http://<host>:<port>` + 签名 token | 同 LAN、Tailscale/WireGuard 内 |
| `agent-channel` | **backend 主动出站** WebSocket/QUIC 到对端，反向承载 HTTP | 无 ssh、NAT 后、跨网段 |
| `overlay` | 交给 WireGuard/Tailscale 提供 IP 可达，connector 退化为 `direct-http` | 最省事，推荐长期方案 |

每条连接状态（localPort/通道/重连计数）**只属于建立它的进程**——0.7.0 的 per-pid 登记就是这个方向的第一步。

### 3.3 发现（M4）

- 静态：`remote-hosts.json`（现状）继续支持，字段扩展 `transport` / `identity`。
- LAN：mDNS 广播 `_dsh._tcp` + `nodeId`，自动出现在候选列表（仍需配对才能连）。
- 广域：可选 rendezvous 只做**地址交换**（不代理数据、不存会话），失败不影响直连；避免把 rendezvous 变成新的单点。

### 3.4 Viewer 语义

- 面板只是本节点的 UI 聚合：顶栏列出"本节点 + 已配对 peers"，每个 peer 的会话/工单仍是 peer 自己的。
- 多个 viewer 同时看同一 backend：读多写少；操作（新建会话、prompt）走 backend 的 gateway，天然串行；
  viewer 之间不共享 cookie，各自 exchange。
- 不做"全局会话列表服务"：那会把状态重新集中，违背 P2P 前提。

## 4. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1（0.7.0，已完成）** | 单写者资源治理：per-pid 隧道登记、`DSH_HOME` 锁、优雅退出清理 | 同 home 第二实例被拒；不同 home 两个 Hub 互不干扰；本文件 §5 |
| M2 | 节点身份 + 签名 token；Hub 不再经 ssh 读明文 token | 无 `remote-agent.json` 也能代理；token 过期/撤销可验证 |
| M3 | `agent-channel` connector（backend 出站） | 两台 NAT 后机器，无 ssh/无公网端口可互相打开面板 |
| M4 | mDNS 发现 + 配对码 | 新节点 30 秒内出现在候选列表，一条命令完成配对 |
| M5 | 多 viewer 一致性、连接可观测（延迟/重连/悬挂）、审计 | 两个 viewer 同时操作同一 backend 无重复会话；面板可见连接健康 |

## 5. M1 的实测记录（2026-11-23，WSL）

| 场景 | 结果 |
|---|---|
| Hub A（独立 `DSH_HOME`）| 锁文件含 pid+startTicks；`remote-hub-tunnels.<pid>.json` 自己一份；32000 被占时回退随机端口；`/remotes/n100/` 200 |
| B：同 `DSH_HOME` 再起一个 Hub（不同端口）| 无 `/remotes` 路由（404）、无隧道登记、**A 的隧道存活**；stderr 明确提示"another hub instance owns …" |
| C：另一个 `DSH_HOME` 起 Hub | 自己的登记与隧道；**A 的隧道在 C 启动后仍存活**（不再互杀）|
| A 优雅退出 | 锁与登记文件自动清理；遗留 ssh 隧道按记录回收 |
| 老版本遗留 `remote-hub-tunnels.json` | 启动时按孤儿处理一次并删除，之后只用 per-pid 文件 |

## 6. 非目标

- 不做分布式一致性（会话不复制、不迁移）；节点各自拥有自己的状态。
- 不做"中央控制台"：任何节点都可以当 viewer，但没有必须存在的中心。
- 不在 M1–M3 阶段支持跨节点工单（mining-superagent 的单项目单实例语义不变）。

## 7. 包与命名：星型的名字应当合并

现状是两个包，名字本身就编码了角色（hub = 中心，agent = 被控端），到了 P2P 就没有这个区分了：

| 现状 | P2P 下 |
|---|---|
| `dsh-remote-hub`（viewer + 反代）| 不存在独立角色：**viewer 是任何节点的一个能力** |
| `dsh-remote-agent`（backend 发布身份）| 不存在独立角色：**serve 是任何节点的一个能力** |
| 插件 id `remote-hub` / `remote-agent` | 一个插件 id：`remote` |
| URL `/remotes/<id>/` | `/peers/<nodeId>/`（保留 `/remotes` 301 别名一个版本）|
| 存储 `remote-hosts.json` | `peers.json`（启动时读旧文件并迁移）|

**推荐：合并为单包 `dsh-remote`，单插件 id `remote`**，内部按能力分模块：

```
src/index.js        cordis 插件入口：同时挂 viewer 与 backend 能力
src/identity.js     节点密钥、签名 token、配对（M2）
src/registry.js     peers.json —— 本节点自己的对端列表（无全局文件）
src/transport/      ssh-tunnel.js / direct-http.js / agent-channel.js（M2–M3）
src/viewer.js       /peers/<nodeId>/ 反代、顶栏切换、会话创建
src/backend.js      暴露本节点 gateway、发布身份与 endpoints（吸收 remote-agent）
```

**改名成本很低**：这两个包不是 npm 发布物（git clone + `install.sh` 装进 profile），没有外部 npm 消费者，
所以不涉及 npm 弃用流程；影响面只有：文档、`install.sh`、profile 的 bundle 列表（`dsh-remote-hub` → `dsh-remote`）、
以及我们自己的 mining 部署文档。旧仓库发最后一个 `0.7.x`，README 指向新仓库即可；插件 id 改名时保留旧 id 识别一个版本。

## 8. 目标形态（1.0）

每个节点都是「`dsh` + 同一个 `dsh-remote` 插件」，节点之间只有成对的 link，没有中心：

```
        ┌──────────────── 任一节点的面板（本地聚合）────────────────┐
        │  本机 │ peer: n100 │ peer: e5 │ + 配对 / 发现            │
        └───────────────────────────┬──────────────────────────────┘
                                    │ viewer 能力（本地，在谁打开就在谁那）
     WSL 节点 ◄─── link ───► n100 节点 ◄─── link ───► e5 节点
     身份 ed25519-A         身份 -B             身份 -C
     serve + view           serve + view        serve + view
```

- **link 是成对的**：任一侧发起配对，互存公钥；一条 link 可承载多个 viewer，token 按 viewer 短签（`aud/ttl/scope`）。
- **角色是能力不是配置**：有浏览器/需要看图 = viewer；被配对 = serve；同一节点可以同时两者（n100 既是 mining 实例又是别人的面板）。
- **发现**：同 LAN 用 mDNS 出现「可配对节点」；跨网用出站 channel，rendezvous 只交换地址（不代理数据）。
- **状态**：会话、工单、凭据永不出节点；面板只是本地聚合；不做全局会话服务。
- **安全**：配对即互信；每个 peer 有 ACL（只读面板 / 可建会话 / 可注入 prompt）；token TTL；操作审计。

## 9. 从今天迁到 P2P 的步骤

| 步骤 | 动作 | 破坏性 |
|---|---|---|
| 1（已完成）| 0.7.x：单写者资源治理（per-pid 登记 + `DSH_HOME` 锁）| 无 |
| 2 | 合并为 `dsh-remote` 单包；旧 id / URL / 文件名保留兼容；两个旧仓库归档并指向新仓库 | profile bundle 列表改一行 |
| 3 | M2：节点身份 + 签名 token，脱离「ssh 读明文 token」| 需配对一次 |
| 4 | M3：`agent-channel` 出站传输（NAT 后、无 ssh 可互通）| 无 |
| 5 | M4：mDNS 发现 + 配对 UX；`/remotes` → `/peers` 别名一个版本后移除 | 书签更新 |

对 mining 部署的影响：目前只体现在 profile 的 `bundles` 与 `deploy/provision-instance.sh` 里的插件 id；
mining 实例本身（一个项目一个 `DSH_HOME`）的语义不变。
