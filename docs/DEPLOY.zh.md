# 部署指南（中文）

> 适用版本：dsh 0.2.1-rc.2 及以上 ｜ Node 22.19+ ｜ 2026-10

本指南把两件事部署起来：

- **Hub**：你日常打开的那台 dsh web。浏览器只连它。
- **Backend**：每台要被管理的 dsh web。只装一个很小的 agent 插件。

```
浏览器 ──► Hub dsh (:3080) ──┬─ /remotes/n100/  ──ssh -N -L──► n100:3080
                              └─ /remotes/x/     ──direct────► 其它地址
```

## 0. 前提

| 项 | 要求 |
|---|---|
| dsh | 0.2.1-rc.2+（Hub 与每个 Backend 版本可以不同） |
| Node | 22.19+（Hub 与 Backend 各自满足即可） |
| Hub → Backend | **能 SSH 登录**（托管隧道与读取 token 都用它）；或你自己先把 upstream 打通 |
| 端口 | 所有 dsh web 保持默认只监听 `127.0.0.1`，**不需要**对外开放 |

## 1. 部署 Backend（每台都做）

### 1.1 安装 agent 插件

```
git clone https://github.com/yhuan416/dsh-remote-agent ~/.dsh/plugins/dsh-remote-agent
cd ~/.dsh/plugins/dsh-remote-agent
./scripts/install.sh web
```

脚本会做三件事：软链进 `~/.dsh/profiles/node_modules` 与 `~/.dsh/profiles/web/node_modules`，
并向 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行 `remote-agent`（已有则跳过，改动前会自动备份）。

如果不想用脚本，手动等价操作见该仓库的 README。

### 1.2 重启 Backend 的 dsh web

```
# 前台：Ctrl-C 后重新执行
dsh web --no-open --port 3080

# 或者 systemd 用户服务
systemctl --user restart dsh-web
```

### 1.3 验证

```
cat ~/.dsh/remote-agent.json
# 应包含 "token"、"hostname"、"webPort"、"updatedAt"（每分钟刷新）
```

文件不存在或 token 过期，通常是插件没加载（检查 patch 行 / 是否重启）。

## 2. 部署 Hub

### 2.1 安装 hub 插件

```
git clone https://github.com/yhuan416/dsh-remote-hub ~/.dsh/plugins/dsh-remote-hub
cd ~/.dsh/plugins/dsh-remote-hub
./scripts/install.sh web
```

### 2.2 重启（或等热加载）

profile 默认 `patchReload: live`，新增的插件行通常会被热加载；不确定时直接重启 dsh web。

### 2.3 验证

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/remotes/
# 401 = 插件已加载（只是没认证）；404 = 没加载，检查软链与 patch 行后重启
```

然后打开 Hub 启动行里打印的 `http://127.0.0.1:3080/?token=...`：

- 页面顶部会出现常驻切换栏：`[本机] [● 远端…]`，每个远端带状态点；
- 远端管理在 **设置 → 插件 → dsh-remote-hub**（详情页里的「远端链路」区块）；
- `/remotes/?token=...` 只是兜底入口页（纯链接），用于顶栏不可用时排查。

## 3. 添加后端

### 3.1 插件页（推荐，改完即生效）

打开 **设置 → 插件 → dsh-remote-hub** → 「远端链路」区块 → 填表：

| 字段 | 例子 |
|---|---|
| 显示名称 | yhuan@192.168.4.50 |
| 传输方式 | ssh 隧道 |
| ssh 主机 / 用户 | 192.168.4.50 / yhuan（端口默认 22） |
| 远端 dsh 端口 | 3080 |
| token 来源 | ssh 读取 agent 文件 |

保存后插件会立刻注册路由、启动 `ssh -N -L` 隧道，并出现在顶栏里。**不需要重启。**

### 3.2 配置文件种子（可选）

在 `~/.dsh/profiles/web/cordis.patch.yml` 里：

```
- insert:
    - id: remote-hub
      name: dsh-remote-hub
      config:
        remotes:
          - id: n100
            label: yhuan@192.168.4.50
            ssh: { host: 192.168.4.50, user: yhuan }
            remotePort: 3080
            tokenFile: { kind: ssh, host: 192.168.4.50, user: yhuan, path: ~/.dsh/remote-agent.json }
```

首次启动会把这里的 `remotes` 导入运行期 store（`~/.dsh/remote-hosts.json`，0600）。
**之后以 store 为准**；配置里新增的 id 仍会被导入，被 UI 删除过的不会复活。

### 3.3 已有隧道 / 直连地址

```
- id: local2
  label: local-3183
  upstream: http://127.0.0.1:3183
  tokenFile: { kind: file, path: /home/you/.dsh/remote-agent.json }
```

适用于你先手动 `ssh -L 3182:127.0.0.1:3080 user@host` 的情况。

## 4. 日常使用

| 场景 | 操作 |
|---|---|
| 切后端 | 顶部常驻切换栏 → 选目标 |
| 管远端 | 设置 → 插件 → dsh-remote-hub → 「远端链路」 |
| 看状态 | 顶栏状态点（悬停看详情），或 `/remotes/_status`（JSON） |
| 测试连通 | 插件页每行的「测试」（隧道 + token + HTTP 全链路，返回延迟） |
| 单开某后端 | 直接访问 `/remotes/<id>/` |

## 5. 运维

### 5.1 常驻（systemd，后端与 Hub 通用）

```
[Unit]
Description=DeepSeek Harness Web
After=network-online.target

[Service]
Type=simple
Environment=DSH_HOME=%h/.dsh
ExecStart=%h/.nvm/versions/node/v22.20.0/bin/dsh web --no-open --port 3080
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

### 5.2 token 与 Cookie 的生命周期

- Backend 的 launch token：**每进程随机**，agent 启动时写入、每 60 秒心跳；进程退出删文件。
- Hub 需要时经 ssh 读取；读到的 token 缓存在内存里，遇到 401 会重新读取。
- 浏览器里的 Hub Cookie：30 天；Backend 的 Cookie 只存在 Hub 进程内（不下发浏览器）。

### 5.3 升级

```
cd ~/.dsh/plugins/dsh-remote-hub && git pull
# 重启 dsh web
```

Backend 上的 agent 同理。

### 5.4 卸载 / 回滚

```
# 1) 删掉 cordis.patch.yml 里对应的 - insert: 行
# 2) 删软链
rm -f ~/.dsh/profiles/web/node_modules/dsh-remote-hub
rm -f ~/.dsh/profiles/node_modules/dsh-remote-hub
# 3) 重启 dsh web
# 可选：删除运行期 store（会丢失 UI 里配置的远端清单）
rm -f ~/.dsh/remote-hosts.json
```

## 6. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `/remotes/` 返回 404 | 插件未加载 | 检查软链与 patch 行；重启 dsh web |
| 401 提示页 | 未认证 | 用启动行的 token URL 打开，或访问 `/remotes/?token=...` |
| 管理页显示 offline / 502 | ssh 失败、端口占用、对端未运行 | 看 `_status.lastError`；手动执行一次 `ssh -o BatchMode=yes host true` |
| 显示 auth-required | token 文件缺失/过期 | 确认 Backend 的 agent 插件在跑，`cat ~/.dsh/remote-agent.json` |
| 侧边栏没有下拉框，右下角出现浮动 pill | UI 改版导致 `_newSession` 锚点失效 | 先用浮动 pill；或配置 `switcher.mode: floating` |
| 下拉框出现但点外面不关 | 旧版本 | 升级到包含点外关闭的提交 |
| iframe 里点切换没反应 | 链接缺 `target="_top"` | 升级 |

## 7. 安全

- Hub 保持 `--host 127.0.0.1`；隧道只监听 loopback；
- 每个 Backend 也保持 loopback，不需要开放 3080；
- `~/.dsh/remote-agent.json`、`~/.dsh/remote-hosts.json` 都是 0600；
- `/remotes/**` 全部经过 Hub 的 Cookie 鉴权，未认证请求不会打到后端；
- 当前是**单用户模型**：所有浏览器共享同一个 owner Peer。

## 8. 已知限制

- 每个后端是一套完整的 SPA（iframe 承载），不做跨后端的会话/工作区聚合；
- 同一 origin 下 iframe 共享 localStorage（主题、宽度等偏好可能互相影响）；
- 侧边栏下拉依赖 Backend/Hub 页面里的 CSS Module 类名后缀 `_newSession`，UI 大改时可能退化为浮动 pill。
