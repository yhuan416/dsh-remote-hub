# Changelog

## 0.3.0 — 2026-11-09

### Added

- `remote_subagent` tool: create or continue a remote dsh session, wait for the turn to settle,
  and return the final assistant text plus the remote session id.
- Native dsh subagent providers `remote-dsh-<host id>` for `dsh-tool-subagent` rows.
- Remote dsh providers/tools are registered independently of OpenCode configuration.

### Changed

- `remote_sessions` is now available even when no OpenCode server is configured.
- M2 roadmap updated: remote subagents are the priority; hub-side session lifecycle is deferred
  because the remote page already provides it.

## 0.2.0 — 2026-11-09

### Added

- Remote session control APIs: `POST /api/remote-hosts/session/create` (optional `cwd`) and
  `POST /api/remote-hosts/session/prompt`.
- Per-remote **＋ 在 <remote> 新建会话** in the top-bar switcher, with a cwd chooser that lists
  known workspace paths, supports a custom path, and remembers the last used directory.
- Remote session list aggregation (workspace store over ssh + `session/list` RPC) in the
  Plugins page, with per-session deep link into the backend pane.
- `ARCHITECTURE.md`, `COMPATIBILITY.md`, `TODO.md`, offline `scripts/check.mjs`, plugin icon,
  `engines.dsh`, and a documented admin/API surface.

### Removed

- Embedded remote workspace views (sidebar mirror, sidebar page with an iframe, new-session
  hero row). They layered UI over the native shell without a native data seam; the top-bar
  environment switcher remains the supported UX.

### Changed

- Switcher dropdown/top bar wording and layout; README restructured with links to architecture,
  compatibility and roadmap docs.

## 0.1.0 — 2026-11-06

### Added

- Hub-side reverse proxy for remote `dsh web` backends under `/remotes/<id>/` (HTTP, SSE,
  WebSocket, index rewriting, auth gate, cookie isolation).
- Admin API and persistent store: list/save/remove/probe plus workspace/session aggregation.
- Managed per-remote `ssh -L` supervisor: port allocation, backoff, reallocation, cleanup.
- Remote token resolution (inline, local file, ssh-read agent file) and server-side cookie
  exchange.
- Top-bar backend switcher and optional sidebar dropdown; Plugins-page management section.
- `remote_sessions` agent tool and robustness notes.