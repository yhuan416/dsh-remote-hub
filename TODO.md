# TODO

## Next

- **Native remote workspaces**: upstream DSH needs a workspace/session provider seam (multi-source
  workspace list + remote session provider). Do not re-implement with DOM/iframe layering; see
  `ARCHITECTURE.md`.
- Remote session lifecycle actions in the hub: archive/delete, pin, rename, running-state badge.
- Prompt from the hub admin section (currently create + deep-link only).
- Cwd recents per backend in the top-bar action (currently remembered by the browser only).
- Offline tests with a fake upstream: proxy rewrite, cookie exchange, RPC envelope, failure modes.
- Version handshake: warn when the remote's `dsh --version` differs from the hub's.

## Upstream (blocked on dsh, see ROADMAP.md → M5)

- External subagent provider: continuable remote children, event stream, parent-context snapshot,
  depth propagation and maxTokens.
- Remote session / execution provider for native attach or transparent remote fs/shell.
- Remote capability advertisement from dsh-remote-agent.

## Later

- Transport abstraction: reverse WebSocket / agent channel when the hub cannot reach the backend.
- Token hardening: short-lived credentials, explicit rotation, audit log.
- Locale dictionaries for the client section (currently Chinese-first copy).
- CI: `npm run check` + a headless smoke matrix (hub + fake remote).
- Richer remote workspace metadata (last activity per workspace, branch, dirty state).