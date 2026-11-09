# 路线图（中文）

> 英文版：[ROADMAP.md](../ROADMAP.md) ｜ 即时待办：[TODO.md](../TODO.md)
> 架构：[ARCHITECTURE.zh.md](ARCHITECTURE.zh.md) ｜ 变更记录：[CHANGELOG.md](../CHANGELOG.md)

## 定位

本项目的职责是**远端 dsh 后端的传输与控制面**：代理、隧道、token、环境切换、轻量会话控制。
刻意不做：模型流桥接、复制 dsh 会话存储、用 DOM/iframe 假装原生工作区。

两条原则：

1. **同源代理优先**：浏览器只连 Hub，远端保留自己的 UI；
2. **优先等上游接缝**：原生整合等 dsh 的 workspace/session provider，而不是继续叠 UI 层。

## 里程碑

### M1 — 多后端远端控制（已完成，v0.2.0）

| 领域 | 已交付 |
|---|---|
| Hub host | 反向代理（HTTP/WS/SSE）、同源鉴权、远端 Cookie 隔离、index 重写 |
| 传输 | 每远端托管 `ssh -L`：端口分配、退避重连、重新分配、卸载清理 |
| 凭据 | token 解析（inline / file / ssh 读 agent 文件）、服务端 Cookie 交换 |
| 管理 UI/API | 插件页区块、远端 CRUD、probe、workspace/session 聚合 |
| 交互 | 顶栏环境切换、每远端「＋ 在 … 新建会话」、cwd 选择 |
| 远端控制 | 经隧道的 `session/create` + `session/prompt` |
| Agent | `dsh-remote-agent` 发布 token/身份（0600、心跳、退出清理） |
| 打包 | 独立 semver `0.2.0`、`engines.dsh`、架构/兼容/变更文档 |

已知缺口：原生工作区/会话合并没有做（上游阻塞）；远端会话生命周期动作很少；传输只有
ssh/直连。

### M2 — 可复用的远端控制台（进行中，不依赖上游）

0. **远端子代理——本轮已完成**：`remote_subagent` 工具（新建/续用远端会话、等 turn 结束、
   返回最终答案）+ 原生 `remote-dsh-<id>` provider（供 `dsh-tool-subagent` 行使用），并尽量对齐
   本地子代理（agentPreset、模型覆盖、outputSchema、label）。
   这是 M2 里性价比最高的一项，因为交互式操作已经由远端完整页面承担。
1. **会话生命周期——有意延后**：归档/删除/置顶/重命名、运行徽标、发 prompt 在远端页面里已有；
   只有出现明确需求时再做 Hub 侧控制。
2. **可靠性**：离线集成测试（代理重写、Cookie 交换、RPC 信封、隧道失败）、远端子代理轮询/续用
   测试、Hub/Backend 版本握手、诊断导出。
3. **传输**：Hub 无法主动 dial 时的反向 WebSocket / agent 通道；在现有代理后面抽 `transport` 接口。
4. **多机完善**：m65 类似机器的批量部署、host 顺序/标签、健康轮询、工作区聚合缓存与失效。
5. **安全**：token 轮换/审计、只读远端选项、管理页权限说明。

验收：两台后端、其中一台不可用时，切换/新建/发 prompt/恢复都不需要手工 ssh；
`npm run check` + 集成测试通过。

### M3 — 原生整合（依赖上游）

让远端工作区成为"一等公民"，而不是 pane/iframe。需要 dsh 核心/workspace 插件的接缝，
候选形态：

- **workspace/session provider 接口**：workspace registry 接受外部来源，原生侧边栏按来源分组；
- **远端会话 runtime**：原生 conversation 能 attach 远端会话（读历史、prompt、cancel、审批）；
- **per-session 执行世界**（备选）：本地会话 + 远端 `fs`/`shell` provider。

届时 Hub 插件退化为 provider 实现（传输 + 鉴权 + 元数据），iframe pane 只作为兜底。

验收：原生侧边栏出现远端工作区；在其下新建会话确实跑在远端；conversation 不经过 iframe；
审批/提问正确路由。

### M4 — 生态

- dsh 与 opencode 远端统一注册表（同一套切换器，按类型适配）；
- 发布到 npm/私有仓库、版本矩阵、升级提示；
- 机群面板：健康、版本、最近错误、会话数。

## 明确不做

- LLM 桥接（代理模型/agent 流）——会丢 dsh 原生内容；
- 用 DOM/iframe 把远端行合进原生树——已尝试并回退；
- 多租户鉴权——当前是单 owner Hub 模型。