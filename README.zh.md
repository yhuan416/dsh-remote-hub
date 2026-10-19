# dsh-remote-hub

> [English](README.md) | 中文
>
> 部署步骤见 [docs/DEPLOY.zh.md](docs/DEPLOY.zh.md) ｜ 鲁棒性说明见 [docs/ROBUSTNESS.zh.md](docs/ROBUSTNESS.zh.md)。

Hub 侧的 DSH 宿主插件。一台 `dsh web`（Hub）以自己的 origin 服务浏览器，并把每个已注册的远端后端
反向代理到 `/remotes/<id>/` 下。因此浏览器始终只与 Hub 这一个 origin 通信——这正是 DSH 的同源限制
所要求的（Host/Origin 必须一致、`SameSite=Strict` Cookie、全站没有 CORS）。

传输方式刻意放在插件之外：一个远端只是一个 Hub 能访问的 HTTP 基址。这个地址可以来自手动 `ssh -L`、
插件托管的 ssh 隧道，或未来某种 agent 通道——代理代码本身不变。

## 当前状态

P0 已完成，并用真实的远端经 `ssh -L` 端到端验证：

| 检查项 | 结果 |
|---|---|
| 无 Hub Cookie 访问 `/remotes/` | 401 |
| `/remotes/` 兜底入口页 | 200 |
| `/remotes/<id>/` 远端首页 | 200，带自己的 `<base href="./">` |
| `/remotes/<id>/assets/*` | 200 |
| `/remotes/<id>/plugins/**` | 200 |
| `POST /remotes/<id>/api/<ns>/<method>` | 200（真实 gateway 信封） |
| `GET /remotes/<id>/plugins/events`（SSE） | 200 |
| `Upgrade /remotes/<id>/api/remote.mux` | 101 |
| 跨源 `Origin` | 403 |
| 未知远端 | 404 |
| 同时挂两个远端 | 均 200/101，各自的 boot 图互不干扰 |

## 管理界面

远端管理已并入统一的 **Plugins** 页面：**设置 → 插件 → dsh-remote-hub**（该插件的详情页）。插件在那里贡献两块内容：

- 由导出的 `Config` 生成的**配置表单**：`upstreamTimeoutMs`、`probeIntervalMs`、`switcher.mode`、`switcher.dropdown`；
- **远端链路**区块（`plugins.detail.section`，由手写客户端 bundle `lib/client.js` 注册）：
  远端表格（状态点 / 名称 / 传输 / token 来源 / 延迟 / 最近错误）、每行 **打开 / 测试 / 删除**、
  以及添加表单（名称、ssh host、user、远端端口）。

`/remotes/` 现在只是**兜底入口页**（纯链接，不再有管理台）；`/api/remote-hosts/*` 仍是插件页区块使用的 API。

## 存储

运行期配置存放在 `$DSH_HOME/remote-hosts.json`（0600，原子写）：

```
{
  "version": 1,
  "removed": ["old-id"],     // 墓碑：配置里的种子被删除后不会复活
  "hosts": [ { "id": "...", "label": "...", "ssh": {...}, "tokenFile": {...} } ]
}
```

- 首次启动：把 `cordis.patch.yml` 里的 `remotes` 数组导入 store；
- 之后启动：store 是权威来源；配置里新增的 id 会被导入，除非被墓碑标记；
- 在 UI 里删除会写入墓碑，因此配置里的种子不会重新出现。

## 管理 API（owner-only，同源 Cookie）

| 路由 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| /api/remote-hosts/list | GET | — | 脱敏后的远端列表 + 隧道/token 状态 |
| /api/remote-hosts/save | POST | label, transport, ssh{host,user,port}, remotePort, localPort, upstream, tokenMode, token, tokenPath | { ok, id } |
| /api/remote-hosts/remove | POST | { id } | { ok } |
| /api/remote-hosts/probe | POST | { id } | { ok, result: { status, latencyMs, tokenResolved, hasCookie } } |

这些路由通过 `ctx.connection.fetch.register` 注册，框架会强制 owner Peer 与浏览器信任围栏。

## 默认入口上的切换器

插件通过官方 `webserver/index-inject` 钩子（`kind: "html"`，body 位置）向 Hub 自己的首页注入一个切换器：

- 默认 `bar` 模式：顶部**常驻切换栏**，列出「本机」+ 每个远端。选中远端后，栏下方用 iframe
  显示该后端（只挂载一次、之后保持）；点「本机」只是隐藏 iframe，露出**同一个**本地页面——
  **不会重载**。切换栏通过 `body{padding-top:34px}` 占位，应用排版不跳动。
- 配色使用应用自己的主题变量（`--dsw-alias-bg-base`、`--dsw-alias-label-primary`、
  `--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-*`），因此跟随明暗主题，不再出现夜间模式下的白块。
- 每个远端标签前有**状态点**，每 5 秒从 `/api/remote-hosts/list` 轮询：
  绿=online、黄=pending/启动中、红=offline、灰=unknown；悬停可看到 state / 隧道状态 / 最近错误。
- 顶栏常驻后，侧边栏「新会话」下方的下拉框**默认关闭**；需要时用 `switcher.dropdown: true` 打开。
- 同时会插入侧边栏「新会话」按钮**正下方**的下拉框（作为第二个入口）
  （通过 CSS Module 类名后缀 `_newSession` 定位），并用 MutationObserver 在 React 重渲染后
  重新插回；侧边栏折叠时自动隐藏。找不到锚点时会退化为悬浮 pill。
- 配置：

```
  config:
    switcher:
      mode: sidebar        # sidebar（默认）| floating
      corner: bottom-right # 仅 floating 模式生效
      offsetX: 14
      offsetY: 14
```
- 选择某个远端会打开**全屏覆盖层**，用 iframe 承载该后端，因此切换**不会重载当前页面**；
  iframe 一旦打开就保持挂载，来回切换是瞬间的。「本机 / 关闭 / Esc」收起覆盖层；
  覆盖层里的远端页面通过 postMessage 通知父页面切换，而不是跳转顶层窗口；
- 内容：列出「本机」+ 每个远端（当前项高亮）以及「管理远端…」；链接带 `target="_top"`，
  因此从启动器 iframe 里点也能切到外层窗口；
- 它只出现在 Hub **已认证**的首页响应里——401 页面和被代理的远端页面都不会有，链接里也不含 token
  （靠已有的 Hub Cookie 授权）；
- 启动器页自带「← 本机」返回本地 UI。

顶栏是宿主插件注入的纯 HTML；远端管理用一段手写的客户端 bundle（`lib/client.js`，通过 `dsh.client` 声明），
只做 Plugins 页区块注册——两边都不需要构建步骤。

## 入口点

- `/remotes/?token=<hub launch token>` —— 一次性入口：插件把 token 转交给 Hub 自己的 `/?token=`
  交换流程、种下 Hub Cookie，然后 303 到干净的 `/remotes/`。
  注意 token URL 与后续访问要使用**同一个主机名**（127.0.0.1 和 localhost 是两个 Cookie 域）。
- `/remotes/` —— 兜底入口页（纯链接）；管理已迁到 Plugins 页。
- `/remotes/<id>/` —— 某个远端自己的 SPA（被代理）。
- `/remotes/_status` —— JSON 诊断：每个远端的 `hasToken / hasCookie / lastError`。

## 工作原理

1. Hub 像普通 dsh 页面一样认证浏览器（自己的 token/Cookie）。
2. 对每个远端，插件在**服务端**保存一份 Cookie：首次使用时由插件自己完成远端的
   `GET /?token=<token>` 交换并缓存。浏览器永远看不到远端 token 和远端 Cookie。
3. 转发请求时：
   - 剥掉路径前缀（`/remotes/n100/api/x` → `/api/x`）；
   - 把 `Host` 与 `Origin` 一起改写为上游 authority（如 `127.0.0.1:3182`），
     远端的 Host/Origin 围栏会把它当作 loopback 放行；
   - 带上缓存的服务端 Cookie。
4. 因为每个远端在 Hub 上独占一个本地端口，改写后的 authority 天然唯一，上游铸出的 Cookie
   不会互相覆盖——不需要重命名 Cookie。
5. WebSocket 升级按远端逐条注册（exact 路由），然后 socket 对 socket 透传。

## 配置

```
- insert:
    - id: remote-hub
      name: dsh-remote-hub
      config:
        remotes:
          - id: n100                       # 仅 [A-Za-z0-9_-]+，唯一且稳定
            label: yhuan@192.168.4.50
            upstream: http://127.0.0.1:3182 # Hub 能访问到的地址
            token: <远端 dsh 的 launch token> # 方案 A：内联（远端每次重启都会变）

          - id: n100
            upstream: http://127.0.0.1:3182
            tokenFile:                       # 方案 B：自动读取 token
              kind: ssh                      #   ssh | file
              host: 192.168.4.50
              user: yhuan
              path: ~/.dsh/remote-agent.json #   由后端的 dsh-remote-agent 写入

          - id: local2
            upstream: http://127.0.0.1:3183
            tokenFile: /home/yhuan/.dsh/remote-agent.json   # 方案 B，同机读文件
```

token 是凭据：profile 文件保持 0600，并且不要写进日志。

可调参数（与 remotes 同一层配置）：

```yaml
config:
  upstreamTimeoutMs: 30000   # 响应头超时；超时返回 504
  probeIntervalMs: 30000     # 周期健康探测（GET /）；0 关闭
```

## 传输方式

每个远端二选一：

```
# A. Hub 已经能访问到它（手动 ssh -L、局域网、wg 等）
- id: local2
  upstream: http://127.0.0.1:3183

# B. 由插件自己管理隧道
- id: n100
  ssh: { host: 192.168.4.50, user: yhuan }   # 可选：port、identityFile、proxyJump
  remotePort: 3080                            # 远端 dsh 端口，默认 3080
  # localPort: 32000                          # 可选；默认 32000 + 序号（稳定），
                                              # 被占用时退回随机空闲端口
```

托管隧道的行为：

- 启动 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>`，参数包含
  `BatchMode=yes ConnectTimeout=8 ExitOnForwardFailure=yes ServerAliveInterval=15 StrictHostKeyChecking=accept-new`；
- 最多等 8 秒确认本地端口可连接，然后标记 `tunnel.state=up`；
- 进程退出后按指数退避重连（1s → 30s）；连续失败 3 次会重新分配本地端口（除非显式配置了 `localPort`）；
- 插件卸载时杀掉子进程，不留下孤儿 `ssh`，也不泄漏监听端口；
- 隧道不可用时，`/remotes/<id>/...` 返回 502，并带上最后一次 ssh 错误。

## 手动传输（第一步）

```
# 在远端
dsh web --no-open --port 3080          # 会打印 http://127.0.0.1:3080/?token=...

# 在 Hub 上
ssh -N -L 3182:127.0.0.1:3080 yhuan@192.168.4.50

# 再把远端 token 填进 config.remotes[].token
```

## 安装到 profile

```
git clone https://github.com/yhuan416/dsh-remote-hub ~/.dsh/plugins/dsh-remote-hub
cd ~/.dsh/plugins/dsh-remote-hub
./scripts/install.sh web
```

脚本会：软链包 → 在 profile 的 `package.json` 里登记为 **dependency** 并加入 **bundle 选择**
（Plugins 页只列 dependency，纯 patch 行不会出现）→ 如存在旧的手工 patch 行则删除 →
改动前自动备份。之后必须重启 `dsh web`（bundle 选择在启动期组合）。

管理入口：**设置 → 插件 → 已安装插件 → dsh-remote-hub**。

## 路线图

- ✅ 反向代理（HTTP / WebSocket / SSE）、鉴权门、Cookie 隔离
- ✅ 管理台 + 持久化 store + owner-only API（list / save / remove / probe）
- ✅ 每个远端的 ssh 隧道托管（端口分配、退避重连、清理）
- ✅ 后端 agent 插件：发布 `~/.dsh/remote-agent.json`，Hub 经 ssh 读取 token
- ✅ 默认入口的侧边栏切换器
- ⬜ 传输抽象：`ssh-reverse` / WebSocket 拨号（当 Hub 可被拨入时）
- ✅ 客户端半：Plugins 页「远端链路」区块 + 生成的配置表单
- ⬜ 跨后端的统一工作区/会话列表
