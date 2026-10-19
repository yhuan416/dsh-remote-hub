# dsh-remote-hub

> English | [中文](README.zh.md)
>
> Deployment guide (Chinese): [docs/DEPLOY.zh.md](docs/DEPLOY.zh.md)
> Robustness notes (Chinese): [docs/ROBUSTNESS.zh.md](docs/ROBUSTNESS.zh.md)

Hub-side DSH host plugin. One `dsh web` (the hub) serves the browser at its own origin and
reverse-proxies every registered remote backend under `/remotes/<id>/`. The browser therefore
only ever talks to the hub origin — which is what DSH's same-origin fences require
(Host/Origin equality, `SameSite=Strict` cookies, no CORS).

Transport is deliberately out of scope: a remote is just an HTTP base URL the hub can reach.
That URL can come from a manual `ssh -L`, a later auto-managed tunnel, or a future agent
channel — the proxy code does not change.

## Status

P0, validated end-to-end against a real remote over `ssh -L`:

| Check | Result |
|---|---|
| `/remotes/` without the hub cookie | 401 |
| `/remotes/` fallback entry page | 200 |
| `/remotes/<id>/` remote index | 200, own `<base href="./">` |
| `/remotes/<id>/assets/*` | 200 |
| `/remotes/<id>/plugins/**` | 200 |
| `POST /remotes/<id>/api/<ns>/<method>` | 200 (real gateway envelope) |
| `GET /remotes/<id>/plugins/events` (SSE) | 200 |
| `Upgrade /remotes/<id>/api/remote.mux` | 101 |
| cross-origin `Origin` | 403 |
| unknown remote | 404 |
| two remotes at once | both 200/101, independent boot graphs |

## Management UI

Remote management lives in the unified **Plugins** page: **Settings → Plugins → dsh-remote-hub**
(the plugin's detail page). The plugin contributes two pieces there:

- a generated **configuration form** (from its exported `Config`): `upstreamTimeoutMs`,
  `probeIntervalMs`, `switcher.mode`, `switcher.dropdown`;
- a **远端链路** section (`plugins.detail.section`, registered by the hand-written client bundle
  `lib/client.js`): table of remotes with state dot / label / transport / token source / latency
  / last error, per-row **打开 / 测试 / 删除**, and an add form (label, ssh host, user, remote port).

`/remotes/` is now only a fallback entry page (plain links, no admin console). `/api/remote-hosts/*`
remains the API behind the Plugins section.

## Store

Runtime configuration lives in `$DSH_HOME/remote-hosts.json` (0600, atomic write):

```jsonc
{
  "version": 1,
  "removed": ["old-id"],     // tombstones: a seed in cordis.patch.yml stays deleted
  "hosts": [ { "id": "...", "label": "...", "ssh": {...}, "tokenFile": {...} } ]
}
```

- First start: the `remotes` array from `cordis.patch.yml` is imported into the store.
- Later starts: the store is authoritative; new seed ids are imported unless tombstoned.
- Deleting in the UI adds a tombstone, so the seed does not come back.

## Admin API (owner-only, same-origin cookie)

| Route | Method | Body | Result |
|---|---|---|---|
| /api/remote-hosts/list | GET | — | sanitized remotes + state/health/latency/tunnel/token/stats |
| /api/remote-hosts/save | POST | label, transport, ssh{host,user,port}, remotePort, localPort, upstream, tokenMode, token, tokenPath | { ok, id } |
| /api/remote-hosts/remove | POST | { id } | { ok } |
| /api/remote-hosts/probe | POST | { id } | { ok, result: { status, latencyMs, tokenResolved, hasCookie } } |

These routes are registered through `ctx.connection.fetch.register`, so the framework enforces
the owner Peer and the browser trust fence for them.

## Entry link on the default UI

The plugin injects one floating pill into the hub's own index page via the official
`webserver/index-inject` hook (`kind: "html"`, body placement):

- default mode `bar`: a persistent top bar lists 本机 + every remote. Picking a remote shows
  that backend in an iframe below the bar (mounted once, kept alive); 本机 hides the pane again
  and reveals the **same** local page — never a reload. The bar reserves 34px through
  `body{padding-top}` so the app layout does not shift.
- colors come from the app's own theme tokens (`--dsw-alias-bg-base`, `--dsw-alias-label-primary`,
  `--dsw-alias-border-l2`, `--dsw-alias-interactive-bg-*`), so the bar follows light/dark mode.
- every remote tab carries a status dot polled from `/api/remote-hosts/list` every 5s:
  green online, amber pending/starting, red offline, grey unknown; hovering shows
  state / tunnel state / last error.
- the sidebar dropdown below the "new session" control is **off by default** now that the bar is
  always visible; set `switcher.dropdown: true` to re-enable it (it uses the same theme tokens).
- config:

  ```yaml
  config:
    switcher:
      mode: sidebar        # sidebar (default) | floating
      corner: bottom-right # floating mode only
      offsetX: 14
      offsetY: 14
  ```
- content: a dropdown listing 本机 + every remote (current one highlighted) and a "管理远端…"
  link;
- picking a remote opens a **fullscreen overlay with that backend in an iframe**, so switching never
  reloads the page you are on; iframes stay mounted once opened and switching between backends is
  instant. 本机 / 关闭 / Escape hide the overlay; a remote page rendered inside the overlay posts a
  message to the parent instead of navigating the top window;
- it only ever appears on the hub's authenticated index response — the 401 page and proxied
  remote pages never contain it, and no token is embedded in the link (the hub cookie already
  authorizes it);
- the launcher page carries a "← 本机" link back to the local UI.

The top bar is plain HTML injected by the host plugin. Remote management uses a hand-written
client bundle (`lib/client.js`, declared through `dsh.client`) that only registers a Plugins-page
section — no build step for either half.

## Entry points

- `/remotes/?token=<hub launch token>` — one-shot entry: the plugin relays the token to the
  hub's own `/?token=` exchange, sets the hub cookie, then 303s to the clean `/remotes/`.
  Use the **same hostname** you used in the token URL (127.0.0.1 vs localhost are different cookie hosts).
- `/remotes/` — fallback entry page (plain links); management moved to the Plugins page.
- `/remotes/<id>/` — a remote's own SPA, proxied.
- `/remotes/_status` — JSON diagnostics: per remote `hasToken / hasCookie / lastError`.

## How it works

1. The hub authenticates the browser exactly like any dsh page (its own token/cookie).
2. For each remote the plugin keeps a **server-side** cookie: on first use it performs the
   remote's `GET /?token=<token>` exchange itself and caches the pair. The browser never sees
   the remote token or the remote cookie.
3. Requests are forwarded with:
   - path prefix stripped (`/remotes/n100/api/x` -> `/api/x`),
   - `Host` and `Origin` rewritten to the upstream authority (`127.0.0.1:3182`),
     which the remote's Host/Origin fence accepts as loopback,
   - the cached remote cookie.
4. Because every remote has its own local port, the rewritten authority is unique per remote,
   so cookies minted upstream never collide — no cookie renaming is needed.
5. WebSocket upgrades are registered per remote (exact route) and piped socket-to-socket.

## Config

```yaml
- insert:
    - id: remote-hub
      name: dsh-remote-hub
      config:
        remotes:
          - id: n100                       # [A-Za-z0-9_-]+, unique, stable
            label: yhuan@192.168.4.50
            upstream: http://127.0.0.1:3182 # whatever the hub can reach
            token: <remote dsh launch token> # option A: inline (rotates on every remote restart)

          - id: n100
            upstream: http://127.0.0.1:3182
            tokenFile:                       # option B: read the token automatically
              kind: ssh                      #   ssh | file
              host: 192.168.4.50
              user: yhuan
              path: ~/.dsh/remote-agent.json #   written by dsh-remote-agent on the backend

          - id: local2
            upstream: http://127.0.0.1:3183
            tokenFile: /home/yhuan/.dsh/remote-agent.json   # option B, same host
```

The token is a credential: keep the profile file at 0600 and never log it.

Tuning keys live in the same config block:

```yaml
config:
  upstreamTimeoutMs: 30000   # response-header timeout; expired requests answer 504
  probeIntervalMs: 30000     # periodic health probe (GET /); 0 disables it
```

## Transport

Two forms, per remote:

```yaml
# A. the hub can already reach it (manual ssh -L, LAN, wg, ...)
- id: local2
  upstream: http://127.0.0.1:3183

# B. the plugin manages the tunnel itself
- id: n100
  ssh: { host: 192.168.4.50, user: yhuan }   # optional: port, identityFile, proxyJump
  remotePort: 3080                            # remote dsh port, default 3080
  # localPort: 32000                          # optional; default = 32000 + index (stable),
                                              # falls back to a free port when taken
```

Managed tunnel behaviour:

- spawns `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>` with
  `BatchMode=yes ConnectTimeout=8 ExitOnForwardFailure=yes ServerAliveInterval=15 StrictHostKeyChecking=accept-new`;
- waits up to 8s for the local port to accept, then reports `tunnel.state=up`;
- on exit reconnects with exponential backoff (1s -> 30s); after 3 consecutive failures it
  reallocates the local port (unless `localPort` was configured explicitly);
- kills the child on plugin unload, so no orphan `ssh` and no leaked listening port;
- when the tunnel is down, `/remotes/<id>/...` answers 502 with the last ssh error.

## Manual transport (first step)

```sh
# on the remote
dsh web --no-open --port 3080          # prints http://127.0.0.1:3080/?token=...

# on the hub
ssh -N -L 3182:127.0.0.1:3080 yhuan@192.168.4.50

# then put the remote token into config.remotes[].token
```

## Install into a profile

```sh
# 1) make the plugin resolvable from the profile
ln -s /home/yhuan/workspace/gitlab/dsh-remote-hub ~/.dsh/profiles/node_modules/dsh-remote-hub
ln -s /home/yhuan/workspace/gitlab/dsh-remote-hub ~/.dsh/profiles/web/node_modules/dsh-remote-hub

# 2) append the insert row above to ~/.dsh/profiles/web/cordis.patch.yml

# 3) restart dsh web (the GUI reconnects on reload)
```

## Roadmap

- ✅ Reverse proxy (HTTP / WebSocket / SSE), auth gate, cookie isolation
- ✅ Admin console + persistent store + owner-only API (list / save / remove / probe)
- ✅ Per-remote `ssh -L` supervisor (port allocation, backoff, cleanup)
- ✅ Agent plugin publishing `~/.dsh/remote-agent.json`; the hub reads the token over ssh
- ✅ Sidebar switcher on the default UI
- ⬜ Transport abstraction: `ssh-reverse` / WebSocket dial when the hub is reachable
- ✅ Client half: Plugins-page section (远端链路) + generated config form
- ⬜ Unified workspace/session list across backends
