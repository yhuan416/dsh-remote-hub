# 鲁棒性检查（Remote Hub）

> 适用版本：dsh 0.2.1-rc.2 ｜ 2026-10

本文记录远端接入链路的失效模型、当前行为，以及这一轮针对性的加固。

## 1. 链路与失效点

```
浏览器 ──► Hub dsh ──► 代理(本插件) ──► [ssh -L 隧道] ──► 后端 dsh
             │              │                 │                │
          Hub Cookie     store/token       ssh 子进程        remote-agent
```

| 失效点 | 现象 | 检测方式 | 当前行为 | 恢复 |
|---|---|---|---|---|
| 后端 dsh 停止 | 隧道在、请求 ECONNREFUSED | 上游错误 + 周期探测 | 502 + 状态点变红 + lastError；探测把 health 置 offline | 后端恢复后自动可用 |
| 后端 dsh 重启（token 变化） | 旧 Cookie 可能失效 → 401 | 401 | 清 cookie/token，经 ssh 重读 token 后重试一次 | 自动 |
| ssh 断连 | 本地端口失联 | ssh 退出事件 | 指数退避重连（1s→30s），连续 3 次失败换端口 | 自动 |
| 网络黑洞（TCP 建连但无响应） | 请求挂起 | 上游响应头超时 | **504**（默认 30s，可配） | 下次请求重试 |
| 上游半途断开 | 响应中断 | upRes error | 连接销毁，lastError 记录 | 客户端重试 |
| 客户端中途关闭 | 上游请求泄漏 | res close | 主动 destroy 上游请求 | — |
| token 文件缺失/损坏 | 无法换 Cookie | JSON 解析/读取失败 | lastError + 502 | 后端 agent 恢复写文件后自动 |
| ssh 读取 token 阻塞 | Hub 事件循环卡住 | 代码审查 | **已改为异步 execFile（10s 超时）** | — |
| 并发首访 | 重复 ssh 读取/重复换 Cookie | 并发请求 | **同一远端共享一个 in-flight Promise** | — |
| 压缩响应被注入 | 页面乱码 | content-encoding 检查 | **带 content-encoding 的响应不注入**；可能返回 HTML 的请求剥掉 accept-encoding | — |
| 超大 HTML | 内存占用 | 4MB 上限 | 超限后改为**流式透传（不注入）** | — |
| store 损坏 | 远端清单丢失 | JSON 解析失败 | **备份为 .corrupt-<ts> 并从配置种子重建** | — |
| 端口被占 | ssh -L 启动失败 | ssh 退出 + ExitOnForwardFailure | 换端口重试（最多 3 次后重新分配） | 自动 |
| Hub 重启 | 全部隧道重建 | 启动流程 | 重新拉起隧道，Cookie 由 token 重新获取 | 自动（浏览器 Cookie 30 天，通常无感） |
| Hub 被 SIGKILL | ssh 子进程可能残留 | 隧道注册表 | 启动时清扫：pid 仍存活且 cmdline 匹配的 ssh 被 SIGTERM/SIGKILL | 自动（依赖同一 PID 命名空间；建议 systemd 托管） |

## 2. 本轮加固的代码点

- `readTokenFile` 改为异步 `execFile`（10s 超时、64KB 上限），不再阻塞事件循环；
- `ensureCookie` 增加 per-remote in-flight 去重，避免并发首访重复 ssh/重复交换；
- 上游**响应头超时**：`upstreamTimeoutMs`（默认 30000），超时返回 **504** 并记录 `lastError`；
- 客户端断开（`res close`）时中止上游请求；
- 上游流式中断（`upRes error`）时销毁响应，避免悬挂；
- HTML 注入缓冲上限 4MB，超限切换为流式透传（放弃注入，但保证页面可用）；
- 压缩安全：只要 `Accept` 可能是 HTML（为空、`*/*`、包含 `text/html`），就剥掉 `accept-encoding`；带 `content-encoding` 的响应一律不注入；
- store 解析失败时先重命名为 `.corrupt-<timestamp>`，再从配置种子重建，避免静默丢数据；
- **主动健康探测**：`probeIntervalMs`（默认 30000，0 关闭）对每个远端做一次 `GET /`（200/401 视为可达），
  记录 `health` / `latencyMs` / `lastProbeAt`，并参与 `state` 推导；探测有 5s 超时且不会与请求重复探测；
- **隧道注册表 + 启动清扫**：子进程 pid/端口写入 `$DSH_HOME/remote-hub-tunnels.json`（0600），
  正常退出/卸载时清除；Hub 启动先清扫上一进程遗留的、cmdline 匹配的 ssh；
- **请求级指标**：每个远端累计 `requests / ok / errors / timeouts / avgLatencyMs / maxLatencyMs / lastRequestAt`，
  通过 `/api/remote-hosts/list` 与 `/remotes/_status` 暴露（进程内，重启清零）。

## 3. 仍然存在的设计边界

1. **状态是近似值**：健康探测默认 30s 一次、顶栏 5s 轮询，不是实时事件；两次探测之间发生的故障最多滞后一个周期。
2. **清扫依赖同一 PID 命名空间**：正常情况下 Hub 的多次启动共享系统 PID 空间；如果 Hub 跑在容器/独立命名空间里，pid 记录可能失效（此时靠 systemd 的 `KillMode=control-group` 回收整组进程）。
3. **单用户模型**：所有浏览器共享 owner Peer；没有多用户隔离。
4. **凭据**：内联 token 保存在 `~/.dsh/remote-hosts.json`（0600）；agent 文件同样是 0600。注意不要进日志/仓库。
5. **iframe 同源**：同一 origin 下多个后端共享 localStorage（主题、宽度等偏好可能互相影响）。
6. **状态点**是 5s 轮询的近似值，不是实时事件。

## 4. 观测手段

| 手段 | 用途 |
|---|---|
| 顶栏状态点（绿/黄/红/灰） | 一眼看在线状态，悬停看 state / tunnel / lastError |
| `/remotes/_status` | 完整 JSON：transport、tunnel、localPort、tokenSource、lastError |
| `/remotes/` 管理页 | 增删改、测试、状态表 |
| Hub 的 stdout | 插件加载、隧道起停、错误 |

## 5. 建议的后续（尚未实现）

- 指标的聚合/看板与告警（当前只有每远端的进程内计数）；
- 后端不可用时给浏览器一个友好的降级页（而不是纯文本 502）；
- 多 Hub 场景下的 store 一致性（目前是单机文件）。
