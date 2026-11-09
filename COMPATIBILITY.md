# Compatibility

## Supported versions

| Component | Version |
|---|---|
| dsh | `>=0.2.1-rc.2` (declared in `engines.dsh`; tested against `0.2.1-rc.2`) |
| Node.js | `>=22.19.0` |
| Remote dsh | `dsh web` reachable over HTTP; same major/minor recommended |
| Transport | ssh client with `BatchMode`/local forwarding, or any reachable HTTP upstream |

The plugin manager enforces `engines.dsh` at profile startup. An incompatible remote is not
fatal: it is reported as a probe/host error and can be fixed independently.

## DSH API assumptions

The plugin talks to a backend through the DSH gateway:

- `POST /api/<namespace>/<method>` with
  `{ type: 'client-request', rpcId, method: '<ns>/<method>', payload: { args } }`;
  the response is `{ type: 'server-response', rpcId, result: { ok, value | error } }`.
- Session methods used: `session/list` (args key `_request`), `session/create` (args key
  `request`, optional `cwd`), `session/prompt` (args key `request`).
- The remote workspace store is read over ssh from `<dshHome>/storages/workspace.json`
  (`tables.workspaces`, `global.workspaceIds`, `sessionIds`); when unreadable, sessions are
  grouped by `cwd` instead.
- Client seams: `webserver/index-inject` (host), `plugins.detail.section` (client),
  `uiWorkspace.openSession()` inside the remote page.
- Client bundle format: `window.__ModuleLoader__.load({ id, factory(require) })`,
  `exports.apply(ctx)`, `exports.inject`.

These are adapter points, not a stable public protocol. A DSH release that changes the gateway
envelope, session method names, workspace store shape, or client slot names requires updating
this plugin (usually `lib/index.js` only). Symptoms: 404/400 from `/api/...`, empty session
lists, or a missing admin section.

## UI/UX scope

- The top-bar environment switcher and the per-remote **＋ 在 <remote> 新建会话** action are the
  supported multi-backend UX.
- Remote sessions are opened inside the backend's own proxied page; they are not native local
  sessions.
- Earlier embedded overviews (sidebar mirror, iframe page, hero row) were removed on purpose;
  see `ARCHITECTURE.md → Deliberately not implemented`.

## Checking a build

```sh
npm run check        # offline: module exports + markup/script parse checks
```

End-to-end validation needs a running hub and a reachable backend; see `docs/DEPLOY.zh.md`
and `docs/ROBUSTNESS.zh.md`.
