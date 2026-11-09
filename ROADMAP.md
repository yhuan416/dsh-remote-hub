# Roadmap

> Chinese: [docs/ROADMAP.zh.md](docs/ROADMAP.zh.md) · Tactical list: [TODO.md](TODO.md)
> Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)

## Positioning

This project is the **transport and control surface** for remote dsh backends: proxy, tunnels,
token exchange, environment switching, and lightweight session control. It deliberately does not
bridge the model stream, duplicate dsh session storage, or fake native workspace rows with
DOM/iframe layering.

Two rules guide the roadmap:

1. **Same-origin proxy first** — the browser only talks to the hub; remote dsh keeps its own UI.
2. **Upstream seams over UI hacks** — native integration waits for a real dsh workspace/session
   provider seam, not for a more elaborate overlay.

## Milestones

### M1 — Multi-backend remote control (done, v0.2.0)

| Area | Delivered |
|---|---|
| Hub host | Reverse proxy (HTTP/WS/SSE), same-origin auth gate, per-remote cookie isolation, index rewriting |
| Transport | Managed per-remote `ssh -L` supervisor: port allocation, backoff, reallocation, cleanup |
| Credentials | Token resolver (inline / file / ssh-read agent file), server-side cookie exchange |
| Admin UI/API | Plugins-page section, host CRUD, probe, workspace/session aggregation |
| UX | Top-bar environment switcher, per-remote **＋ 在 … 新建会话**, cwd chooser |
| Remote control | `session/create` + `session/prompt` APIs through the tunnel |
| Agent | `dsh-remote-agent` publishes token/identity (0600, heartbeat, shutdown cleanup) |
| Packaging | Independent semver `0.2.0`, `engines.dsh`, docs (architecture/compatibility/changelog) |

Known gaps: native workspace/session merge is not implemented (upstream blocker); remote session
lifecycle actions are minimal; transport is ssh/direct only.

### M2 — Reusable remote console (next, no upstream dependency)

1. **Session lifecycle**: archive/delete/pin/rename, running badge, prompt from the hub section,
   completion notification, cwd recents per backend.
2. **Reliability**: offline integration tests with a fake upstream (proxy rewrite, cookie exchange,
   RPC envelope, tunnel failure), version handshake between hub and backend, diagnostics export.
3. **Transport**: reverse WebSocket / agent channel for hubs that cannot dial the backend; explicit
   `transport` abstraction behind the existing proxy.
4. **Multi-host polish**: m65-style fleet rollout, host labels/order, health polling, cached
   workspace aggregation with invalidation.
5. **Security**: token rotation/audit, optional read-only remotes, explicit permission notes in the
   admin section.

Acceptance: two backends, one unavailable; switching, creating, prompting and recovery work from
the hub without manual ssh; `npm run check` plus an integration test suite pass.

### M3 — Native integration (upstream-dependent)

This is the milestone that makes remote workspaces first-class instead of pane-based. It needs a
dsh core/workspace-plugin seam, not hub-side layering. Candidate upstream shapes:

- **Workspace/session provider interface**: the workspace registry accepts external sources that
  expose workspaces, sessions, history and events; the native sidebar groups by source.
- **Remote session runtime**: native conversation can attach to a remote session (history read,
  prompt, cancel, approvals) through a provider.
- **Per-session execution world** (alternative): local session with remote `fs`/`shell` providers.

Then the hub becomes a provider implementation (transport + auth + metadata) and the embedded
pane remains only as an escape hatch.

Acceptance: remote workspace appears in the native sidebar; a new session created there runs on the
remote; conversation renders without an iframe; approvals/questions route correctly.

### M4 — Ecosystem

- Unified backend registry for dsh and opencode remotes (same switcher, type-specific adapters).
- Published packaging / private registry install, version matrix, upgrade hints.
- Fleet dashboard: health, versions, last error, session counts per backend.

## Not planned

- LLM bridging (proxying model/agent streams) — loses dsh-native content.
- Merging remote rows into the native tree via DOM/iframe hacks — rejected after exploration.
- Multi-tenant authz — current model is a single-owner hub.
