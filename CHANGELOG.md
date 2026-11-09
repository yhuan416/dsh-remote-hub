# Changelog

## 0.5.0 — 2026-11-09

### Added

- **Workspace selection for remote sessions.** `remote_subagent` takes `workspace` (a workspace id
  or its absolute path) and `/api/remote-hosts/session/create` accepts `workspace`; the new
  session joins that remote workspace (`session/create` `workspaceId`) instead of owning a bare
  `cwd`. `workspace` and `cwd` are mutually exclusive at every layer.
- `resolveRemoteWorkspace()` resolves a workspace path to its id by reading the backend's
  `workspace.json` store over ssh; the tool/admin errors list the known paths when a path misses.

### Notes

- The upstream subagent seam (`SubagentStartRequest`) still only carries `cwd`, so the native
  `remote-dsh-<id>` provider rows cannot take a workspace argument; `remote_subagent` is the
  surface that does.
- A `cwd`-created session is not recorded in the workspace store (the hub shows it as an orphan);
  only `workspaceId` creation joins the workspace.

## 0.4.0 — 2026-11-09

### Added

- Native `remote-dsh-<id>` provider parity with local subagents where the external-provider seam
  allows: `agentPreset` forwarding, `agentOptions.provider/model/reasoningEffort` via
  `session/selectModel`, prompt-enforced `outputSchema` with local validation, and session rename
  from the subagent label.

### Known limits

- Remote children remain one-shot: no continuable children, live tool/event streaming into the
  parent, shared parent context, or depth-limit inheritance.

## 0.3.1 — 2026-11-09

### Fixed

- `remote_subagent` / `remote-dsh-<id>` returned the ~120-character `turnOutline` preview instead
  of the full assistant answer. The result is now read from the durable transcript with
  `session/page` (`assistant/message` events), falling back to the preview only when the
  transcript is unavailable.

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