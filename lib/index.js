/**
 * dsh-remote-hub — hub-side host plugin.
 *
 * One dsh web (the "hub") serves the browser at its own origin and reverse
 * proxies every registered remote backend under /remotes/<id>/. The browser
 * therefore only ever talks to the hub origin, which is what dsh's same-origin
 * fences (Host/Origin equality, SameSite=Strict cookies, no CORS) require.
 *
 * A remote is either a plain HTTP base URL the hub can already reach, or an
 * SSH target this plugin tunnels itself: it spawns "ssh -N -L 127.0.0.1:<local>
 * :127.0.0.1:<remotePort>", allocates the local port, reconnects with backoff
 * and kills the child when the plugin unloads.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'

export const name = 'remote-hub'
export const inject = ['webServer', 'connection', 'tools']

/**
 * Resolve schemastery from the dsh profile rather than this package: the plugin
 * is installed as a bare symlink and carries no dependencies of its own.
 * Returning undefined leaves the plugin fully usable, just without a generated
 * settings form.
 */
function loadSchema() {
  const candidates = []
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    candidates.push(path.join(process.env.DSH_PROFILE_DIR, 'noop.js'))
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    candidates.push(path.join(process.env.DSH_HOME, 'profiles', 'noop.js'))
  }
  if (process.argv[1] !== undefined) candidates.push(process.argv[1])
  for (const file of candidates) {
    try {
      const req = createRequire(file)
      const loaded = req('@deepseek-ai/schemastery')
      if (typeof loaded === 'function' && typeof loaded.object === 'function') return loaded
      if (loaded !== null && typeof loaded === 'object' && typeof loaded.default === 'function') return loaded.default
    } catch {}
  }
  return undefined
}

const Schema = loadSchema()

const dshToolsAttempts = []

/** dsh-tools is ESM: load its entry by file URL (the plugin itself carries no dependencies). */
async function loadDshTools() {
  const globalPrefix = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai')
  const anchors = [
    path.join(globalPrefix, 'dsh', 'package.json'),
    path.join(globalPrefix, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
    path.join(globalPrefix, 'dsh-tools', 'package.json'),
  ]
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') anchors.push(path.join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'))
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') anchors.push(path.join(process.env.DSH_PROFILE_DIR, 'package.json'))
  if (process.argv[1] !== undefined) anchors.push(process.argv[1])
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-tools')
      const loaded = await import(pathToFileURL(resolved).href)
      const mod = loaded !== null && typeof loaded === 'object' && loaded.default !== undefined && typeof loaded.default.defineTool === 'function' ? loaded.default : loaded
      if (mod !== null && typeof mod === 'object' && typeof mod.defineTool === 'function') {
        dshToolsAttempts.push({ anchor: anchor, resolved: resolved, ok: true })
        return mod
      }
      dshToolsAttempts.push({ anchor: anchor, resolved: resolved, ok: false, error: 'no defineTool export' })
    } catch (error) {
      dshToolsAttempts.push({ anchor: anchor, ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error).slice(0, 160) })
    }
  }
  return undefined
}

/** Generated settings form in Plugins → dsh-remote-hub (dynamic remotes are managed in the plugin's section). */
export const Config = Schema === undefined ? undefined : Schema.object({
  upstreamTimeoutMs: Schema.number().default(30000)
    .description('Proxied request response-header timeout in milliseconds.'),
  probeIntervalMs: Schema.number().default(30000)
    .description('Periodic health-probe interval in milliseconds; 0 disables probing.'),
  switcher: Schema.object({
    mode: Schema.union([Schema.const('bar'), Schema.const('floating')]).default('bar')
      .description('Persistent top bar, or the legacy floating pill.'),
    dropdown: Schema.boolean().default(false)
      .description('Also insert the sidebar dropdown below the new-session control.'),
    sidebarTree: Schema.boolean().default(true)
      .description('Show every remote as one workspace row under the native sidebar workspace list.'),
  }).description('Top-bar backend switcher.'),
})

const PREFIX = '/remotes'
/** Responses larger than this are streamed without switcher injection. */
const HTML_INJECT_MAX_BYTES = 4 * 1024 * 1024

function normalizeRemotes(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  const list = Array.isArray(config.remotes) ? config.remotes : []
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id === undefined ? '' : item.id).trim()
    const upstream = String(item.upstream === undefined ? '' : item.upstream).trim()
    if (id === '' || !/^[A-Za-z0-9_-]+$/.test(id)) continue
    let ssh
    if (item.ssh !== null && typeof item.ssh === 'object' && typeof item.ssh.host === 'string') {
      ssh = {
        host: item.ssh.host,
        user: typeof item.ssh.user === 'string' ? item.ssh.user : undefined,
        port: typeof item.ssh.port === 'number' ? item.ssh.port : undefined,
        identityFile: typeof item.ssh.identityFile === 'string' ? item.ssh.identityFile : undefined,
        proxyJump: typeof item.ssh.proxyJump === 'string' ? item.ssh.proxyJump : undefined,
      }
    }
    let url
    if (upstream !== '') {
      try {
        url = new URL(upstream)
      } catch {
        continue
      }
    }
    if (url === undefined && ssh === undefined) continue
    let tokenFile
    if (typeof item.tokenFile === 'string' && item.tokenFile !== '') {
      tokenFile = { kind: 'file', path: item.tokenFile }
    } else if (item.tokenFile !== null && typeof item.tokenFile === 'object') {
      const spec = item.tokenFile
      if (spec.kind === 'ssh' && typeof spec.host === 'string') {
        tokenFile = {
          kind: 'ssh',
          host: spec.host,
          user: typeof spec.user === 'string' ? spec.user : undefined,
          port: typeof spec.port === 'number' ? spec.port : undefined,
          path: typeof spec.path === 'string' ? spec.path : '~/.dsh/remote-agent.json',
        }
      } else if (typeof spec.path === 'string' && spec.path !== '') {
        tokenFile = { kind: 'file', path: spec.path }
      }
    }
    out.push({
      id,
      label: String(item.label === undefined ? id : item.label),
      url,
      upstreamText: upstream === '' ? undefined : upstream,
      token: typeof item.token === 'string' && item.token !== '' ? item.token : undefined,
      tokenFile: tokenFile,
      tokenOrigin: typeof item.token === 'string' && item.token !== '' ? 'inline' : (tokenFile === undefined ? null : tokenFile.kind),
      cookie: undefined,
      ssh,
      remotePort: typeof item.remotePort === 'number' ? item.remotePort : 3080,
      localPort: typeof item.localPort === 'number' ? item.localPort : undefined,
      localPortFixed: typeof item.localPort === 'number',
      index,
      ready: undefined,
      tunnel: undefined,
    })
  }
  return out
}

function escapeHtml(text) {
  return String(text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
}

function upstreamPort(url) {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function expandHome(value) {
  if (value.startsWith('~/')) return os.homedir() + value.slice(1)
  return value
}

/** Ask the OS for a free loopback port (bind :0, read it, release). */
function pickFreePort() {
  return new Promise(function (resolve) {
    const probe = net.createServer()
    probe.once('error', function () { resolve(undefined) })
    probe.listen(0, '127.0.0.1', function () {
      const address = probe.address()
      const port = address !== null && typeof address === 'object' ? address.port : undefined
      probe.close(function () { resolve(port) })
    })
  })
}

function portFree(port) {
  return new Promise(function (resolve) {
    const probe = net.createServer()
    probe.once('error', function () { resolve(false) })
    probe.listen(port, '127.0.0.1', function () {
      probe.close(function () { resolve(true) })
    })
  })
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise(function (resolve) {
    function attempt() {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', function () { socket.destroy(); resolve(true) })
      socket.once('error', function () {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function sshArgs(remote) {
  const ssh = remote.ssh
  const args = ['-N',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new']
  if (ssh.port !== undefined) args.push('-p', String(ssh.port))
  if (ssh.identityFile !== undefined) args.push('-i', expandHome(ssh.identityFile))
  if (ssh.proxyJump !== undefined) args.push('-J', ssh.proxyJump)
  args.push('-L', '127.0.0.1:' + String(remote.localPort) + ':127.0.0.1:' + String(remote.remotePort))
  args.push((ssh.user === undefined ? '' : ssh.user + '@') + ssh.host)
  return args
}

function startTunnel(remote) {
  remote.tunnel = { state: 'starting', attempts: 0, stderr: '', child: undefined, timer: undefined, disposed: false }
  remote.ready = spawnTunnel(remote)
  return remote.ready
}

function remoteHubHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function tunnelRegistryFile() {
  return path.join(remoteHubHome(), 'remote-hub-tunnels.json')
}

function readTunnelRecords() {
  try {
    const value = JSON.parse(fs.readFileSync(tunnelRegistryFile(), 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeTunnelRecords(records) {
  try {
    const file = tunnelRegistryFile()
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp-' + String(process.pid)
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
}

function recordTunnel(remote) {
  const tunnel = remote.tunnel
  if (tunnel === undefined || tunnel.child === undefined || tunnel.child.pid === undefined) return
  const records = readTunnelRecords().filter(function (record) { return record.id !== remote.id })
  records.push({ id: remote.id, pid: tunnel.child.pid, port: remote.localPort, args: sshArgs(remote) })
  writeTunnelRecords(records)
}

function forgetTunnel(id) {
  writeTunnelRecords(readTunnelRecords().filter(function (record) { return record.id !== id }))
}

/** Kill ssh children left behind by a previous Hub process that was killed hard. */
function sweepTunnels() {
  const records = readTunnelRecords()
  for (const record of records) {
    try {
      process.kill(record.pid, 0)
      const cmdline = fs.readFileSync('/proc/' + String(record.pid) + '/cmdline', 'utf8').split(String.fromCharCode(0)).join(' ')
      if (cmdline.indexOf('ssh') === -1 || cmdline.indexOf('-L') === -1 || cmdline.indexOf(String(record.port)) === -1) continue
      process.kill(record.pid, 'SIGTERM')
      setTimeout(function () { try { process.kill(record.pid, 'SIGKILL') } catch {} }, 1000)
    } catch {}
  }
  writeTunnelRecords([])
}

function spawnTunnel(remote) {
  const tunnel = remote.tunnel
  if (tunnel === undefined || tunnel.disposed) return Promise.resolve(undefined)
  return (remote.localPort === undefined
    ? portFree(32000 + remote.index).then(function (free) { return free ? 32000 + remote.index : pickFreePort() })
    : Promise.resolve(remote.localPort)).then(function (port) {
    if (tunnel.disposed) return undefined
    if (port === undefined) {
      tunnel.state = 'down'
      remote.lastError = 'ssh tunnel: no free loopback port'
      return undefined
    }
    if (remote.localPort !== port) {
      remote.localPort = port
      remote.cookie = undefined
      remote.token = undefined
    }
    remote.url = new URL('http://127.0.0.1:' + String(port))
    const child = spawn('ssh', sshArgs(remote), { stdio: ['ignore', 'ignore', 'pipe'] })
    tunnel.child = child
    recordTunnel(remote)
    tunnel.stderr = ''
    if (child.stderr !== null) {
      child.stderr.on('data', function (chunk) { tunnel.stderr = (tunnel.stderr + chunk.toString()).slice(-2000) })
    }
    child.on('error', function (error) {
      remote.lastError = 'ssh spawn: ' + error.message
    })
    child.on('exit', function (code, signal) {
      tunnel.child = undefined
      tunnel.state = 'down'
      forgetTunnel(remote.id)
      const reason = code === null ? String(signal) : String(code)
      const first = tunnel.stderr === '' ? '' : ': ' + tunnel.stderr.trim().split(String.fromCharCode(10))[0]
      remote.lastError = 'ssh tunnel exited (' + reason + ')' + first
      if (tunnel.disposed) return
      tunnel.attempts += 1
      if (tunnel.attempts >= 3 && !remote.localPortFixed) remote.localPort = undefined
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(tunnel.attempts - 1, 5)))
      tunnel.timer = setTimeout(function () { spawnTunnel(remote) }, delay)
    })
    return waitForPort(port, 8000).then(function (up) {
      if (tunnel.disposed) return undefined
      if (up) {
        tunnel.state = 'up'
        tunnel.attempts = 0
        remote.lastError = undefined
        remote.health = undefined
        healthCheck(remote)
        return remote.url
      }
      tunnel.state = 'down'
      remote.lastError = 'ssh tunnel did not open 127.0.0.1:' + String(port)
      return undefined
    })
  })
}

function stopTunnel(remote) {
  const tunnel = remote.tunnel
  if (tunnel === undefined) return
  forgetTunnel(remote.id)
  tunnel.disposed = true
  if (tunnel.timer !== undefined) clearTimeout(tunnel.timer)
  const child = tunnel.child
  if (child !== undefined) {
    try { child.kill('SIGTERM') } catch {}
    setTimeout(function () { try { child.kill('SIGKILL') } catch {} }, 3000)
  }
  tunnel.state = 'off'
}

/** opencode servers declared in config.opencode: independent HTTP APIs, not dsh remotes. */
function normalizeOpencode(raw) {
  if (!Array.isArray(raw)) return []
  const servers = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const base = typeof item.url === 'string' ? item.url.trim().replace(/\/+$/, '') : ''
    if (id === '' || base === '') continue
    servers.push({
      id: id,
      label: typeof item.label === 'string' && item.label !== '' ? item.label : id,
      url: base,
      password: typeof item.password === 'string' && item.password !== '' ? item.password : undefined,
      directory: typeof item.directory === 'string' && item.directory !== '' ? item.directory : undefined,
      snapshot: undefined,
    })
  }
  return servers
}

function opencodeRequest(server, target, options) {
  return new Promise(function (resolve) {
    let url
    try { url = new URL(server.url + target) } catch { resolve(undefined); return }
    const headers = { accept: 'application/json' }
    if (server.password !== undefined) {
      headers.authorization = 'Basic ' + Buffer.from('opencode:' + server.password).toString('base64')
    }
    if (options !== undefined && typeof options.directory === 'string' && options.directory !== '') {
      headers['x-opencode-directory'] = options.directory
    }
    const body = options !== undefined && options.body !== undefined ? JSON.stringify(options.body) : undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const request = http.request({
      host: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      method: options !== undefined && options.method !== undefined ? options.method : 'GET',
      path: url.pathname + url.search,
      timeout: 8000,
      headers: headers,
      ...options !== undefined && options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
    }, function (response) {
      const chunks = []
      response.on('data', function (chunk) { chunks.push(chunk) })
      response.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8')
        let value
        try { value = text === '' ? undefined : JSON.parse(text) } catch { value = undefined }
        resolve({ status: response.statusCode, value: value })
      })
    })
    request.on('timeout', function () { request.destroy(new Error('opencode timeout')) })
    request.on('error', function () { resolve(undefined) })
    if (options !== undefined && options.signal !== undefined && options.signal !== null) {
      const signal = options.signal
      const onAbort = function () { request.destroy(new Error('opencode aborted')) }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        request.on('close', function () { signal.removeEventListener('abort', onAbort) })
      }
    }
    request.end(body)
  })
}

function summarizeOpencodeSession(session) {
  const time = session !== null && typeof session === 'object' && session.time !== null && typeof session.time === 'object' ? session.time : undefined
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title !== '' ? session.title : (typeof session.slug === 'string' ? session.slug : session.id),
    directory: typeof session.directory === 'string' ? session.directory : null,
    updatedAt: time !== undefined && typeof time.updated === 'number' ? time.updated : null,
  }
}

/** Projects and sessions of one opencode server; health decides the state dot. */
function collectOpencode(server) {
  if (server.snapshot !== undefined && Date.now() - server.snapshot.at < 10000) {
    return Promise.resolve(server.snapshot.value)
  }
  return Promise.all([
    opencodeRequest(server, '/global/health'),
    opencodeRequest(server, '/project'),
    opencodeRequest(server, '/session'),
  ]).then(function (results) {
    const health = results[0] !== undefined && results[0].value !== undefined ? results[0].value : undefined
    const projects = results[1] !== undefined && Array.isArray(results[1].value) ? results[1].value : []
    const sessions = results[2] !== undefined && Array.isArray(results[2].value) ? results[2].value : []
    const projectById = new Map(projects.map(function (project) { return [project.id, project] }))
    const groups = new Map()
    function realWorktree(project) {
      return project !== undefined && typeof project.worktree === 'string' && project.worktree !== '' && project.worktree !== '/'
    }
    for (const project of projects) {
      if (realWorktree(project)) groups.set(project.id, { id: project.id, worktree: project.worktree, sessions: [] })
    }
    for (const session of sessions) {
      const summary = summarizeOpencodeSession(session)
      const projectId = typeof session.projectID === 'string' ? session.projectID : ''
      const project = projectById.get(projectId)
      let group
      if (realWorktree(project)) {
        group = groups.get(project.id)
      } else {
        const directory = summary.directory === null ? '(unknown directory)' : summary.directory
        const key = 'dir:' + directory
        group = groups.get(key)
        if (group === undefined) {
          group = { id: key, worktree: directory, sessions: [] }
          groups.set(key, group)
        }
      }
      if (group !== undefined) group.sessions.push(summary)
    }
    const ordered = Array.from(groups.values())
    ordered.forEach(function (group) { group.sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) }) })
    ordered.sort(function (a, b) { return (b.sessions[0] === undefined ? 0 : b.sessions[0].updatedAt || 0) - (a.sessions[0] === undefined ? 0 : a.sessions[0].updatedAt || 0) })
    const value = {
      state: health !== undefined && health.healthy === true ? 'online' : 'offline',
      version: health !== undefined && typeof health.version === 'string' ? health.version : null,
      projects: ordered,
      ungrouped: [],
    }
    server.snapshot = { at: Date.now(), value: value }
    return value
  })
}

/** Cheap liveness probe: one GET / and accept 200/401 as reachable. */
function healthCheck(host) {
  const started = Date.now()
  return ensureUpstream(host).then(function (url) {
    if (url === undefined) {
      host.health = 'offline'
      host.lastProbeAt = Date.now()
      return undefined
    }
    return new Promise(function (resolve) {
      const req = http.request({
        host: url.hostname,
        port: upstreamPort(url),
        method: 'GET',
        path: '/',
        timeout: 5000,
        headers: { host: url.host, cookie: host.cookie === undefined ? '' : host.cookie, accept: 'text/html' },
      }, function (res) {
        res.resume()
        res.on('end', function () {
          host.health = res.statusCode === 200 || res.statusCode === 401 ? 'online' : 'offline'
          if (host.health === 'online') host.lastError = undefined
          host.latencyMs = Date.now() - started
          host.lastProbeAt = Date.now()
          resolve(undefined)
        })
      })
      req.on('timeout', function () { req.destroy(new Error('probe timeout')) })
      req.on('error', function () {
        host.health = 'offline'
        host.lastProbeAt = Date.now()
        resolve(undefined)
      })
      req.end()
    })
  })
}

/** Read one file from a backend over ssh, when this remote has an ssh endpoint. */
function readRemoteFile(remote, remotePath) {
  const ssh = remote.tokenFile !== undefined && remote.tokenFile.kind === 'ssh' ? remote.tokenFile : remote.ssh
  if (ssh === undefined) return Promise.resolve(undefined)
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new']
  if (ssh.port !== undefined) args.push('-p', String(ssh.port))
  const target = (ssh.user === undefined ? '' : ssh.user + '@') + ssh.host
  args.push(target, 'cat', remotePath)
  return new Promise(function (resolve) {
    execFile('ssh', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, function (error, stdout) {
      resolve(error !== null ? undefined : stdout)
    })
  })
}

/** One unary Remote call against a backend, through the managed tunnel. */
function remoteRpc(remote, method, args, timeoutMs) {
  return ensureUpstream(remote).then(function (url) {
    if (url === undefined) return undefined
    return ensureCookie(remote).then(function (cookie) {
      return new Promise(function (resolve) {
        const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: method, payload: { args: args } })
        const request = http.request({
          host: url.hostname,
          port: upstreamPort(url),
          method: 'POST',
          path: '/api/' + method,
          timeout: timeoutMs === undefined ? 8000 : timeoutMs,
          headers: {
            host: url.host,
            cookie: cookie === undefined ? '' : cookie,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        }, function (response) {
          const chunks = []
          response.on('data', function (chunk) { chunks.push(chunk) })
          response.on('end', function () {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              resolve(parsed === null || typeof parsed !== 'object' ? undefined : parsed.result)
            } catch {
              resolve(undefined)
            }
          })
        })
        request.on('timeout', function () { request.destroy(new Error('rpc timeout')) })
        request.on('error', function () { resolve(undefined) })
        request.end(body)
      })
    })
  })
}

function summarizeSession(session, fallbackId) {
  const projections = session !== undefined && session.projections !== null && typeof session.projections === 'object' ? session.projections : undefined
  const values = projections !== undefined && projections.values !== null && typeof projections.values === 'object' ? projections.values : undefined
  return {
    id: session === undefined ? fallbackId : session.sessionId,
    title: values !== undefined && typeof values.title === 'string' && values.title !== '' ? values.title : null,
    updatedAt: session === undefined || typeof session.updatedAt !== 'number' ? null : session.updatedAt,
    cwd: session === undefined || typeof session.cwd !== 'string' ? null : session.cwd,
    running: session !== undefined && session.running === true,
    blank: session !== undefined && session.blank === true,
  }
}

/** Workspaces + sessions of one backend: ssh workspace store when available, session RPC for metadata. */
function collectWorkspaces(remote) {
  if (remote.workspaceSnapshot !== undefined && Date.now() - remote.workspaceSnapshot.at < 10000) {
    return Promise.resolve(remote.workspaceSnapshot.value)
  }
  const dshHome = typeof remote.dshHome === 'string' && remote.dshHome !== '' ? remote.dshHome : '~/.dsh'
  const sessionsPromise = remoteRpc(remote, 'session/list', { _request: {} }).then(function (result) {
    if (result === undefined || result.ok !== true || result.value === undefined) return undefined
    return Array.isArray(result.value.items) ? result.value.items : []
  })
  const storePromise = readRemoteFile(remote, dshHome + '/storages/workspace.json').then(function (text) {
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' && parsed.tables !== undefined ? parsed : undefined
    } catch {
      return undefined
    }
  })
  return Promise.all([sessionsPromise, storePromise]).then(function (pair) {
    const sessions = pair[0]
    const store = pair[1]
    const byId = new Map()
    if (sessions !== undefined) for (const session of sessions) byId.set(session.sessionId, session)
    const workspaces = []
    const accounted = new Set()
    if (store !== undefined && store.tables !== undefined && store.tables.workspaces !== undefined && store.global !== undefined && Array.isArray(store.global.workspaceIds)) {
      for (const workspaceId of store.global.workspaceIds) {
        const workspace = store.tables.workspaces[workspaceId]
        if (workspace === undefined) continue
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        const items = sessionIds.map(function (sessionId) {
          accounted.add(sessionId)
          return summarizeSession(byId.get(sessionId), sessionId)
        })
        workspaces.push({
          id: workspaceId,
          title: typeof workspace.title === 'string' ? workspace.title : workspaceId,
          path: typeof workspace.path === 'string' ? workspace.path : null,
          updatedAt: typeof workspace.updatedAt === 'string' ? workspace.updatedAt : null,
          sessions: items,
        })
      }
    }
    const orphans = []
    if (sessions !== undefined) {
      for (const session of sessions) {
        if (accounted.has(session.sessionId)) continue
        orphans.push(summarizeSession(session, session.sessionId))
      }
    }
    if (workspaces.length === 0 && orphans.length > 0) {
      // No workspace store readable (direct transport): group by cwd as a fallback.
      const groups = new Map()
      for (const session of orphans) {
        const key = session.cwd === null ? '未分组' : session.cwd
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(session)
      }
      for (const [key, items] of groups) {
        workspaces.push({ id: 'cwd:' + key, title: key === '未分组' ? key : key.split('/').filter(Boolean).pop() || key, path: key === '未分组' ? null : key, updatedAt: null, sessions: items })
      }
      orphans.length = 0
    }
    const value = {
      workspaces: workspaces,
      orphans: orphans,
      sessionCount: sessions === undefined ? null : sessions.length,
      storeAvailable: store !== undefined,
    }
    remote.workspaceSnapshot = { at: Date.now(), value: value }
    return value
  })
}

/** Wait for a managed tunnel's first attempt, then hand back the upstream URL. */
function ensureUpstream(remote) {
  if (remote.ready === undefined) return Promise.resolve(remote.url)
  return Promise.resolve(remote.ready).then(function () { return remote.url })
}

/** Rewrite the upstream Set-Cookie Path=/ to the proxy path so it scopes there. */
function rewriteSetCookie(value, remoteId) {
  const scope = PREFIX + '/' + remoteId
  const list = Array.isArray(value) ? value : [value]
  return list.map(function (one) {
    const parts = String(one).split(';')
    return parts.map(function (part) {
      const trimmed = part.trim()
      if (trimmed === 'Path=/' || trimmed === 'path=/') return ' Path=' + scope
      if (trimmed.startsWith('Path=') || trimmed.startsWith('path=')) return ' Path=' + scope
      return part
    }).join(';')
  })
}

/** Strip an absolute Location that points at the upstream so the browser stays on the hub. */
function rewriteLocation(value, url) {
  if (typeof value !== 'string') return value
  if (value.startsWith(url.origin + '/')) return value.slice(url.origin.length)
  if (value === url.origin) return '/'
  return value
}

function exchangeCookie(remote) {
  return new Promise(function (resolve) {
    const url = remote.url
    const req = http.request({
      host: url.hostname,
      port: upstreamPort(url),
      method: 'GET',
      path: '/?token=' + encodeURIComponent(remote.token),
      headers: { host: url.host, accept: 'text/html' },
    }, function (res) {
      const set = res.headers['set-cookie']
      res.resume()
      res.on('end', function () {
        const first = Array.isArray(set) ? set[0] : set
        if (!first) return resolve(undefined)
        const pair = first.split(';')[0]
        if (pair.indexOf('=') <= 0) return resolve(undefined)
        resolve(pair)
      })
    })
    req.on('error', function () { resolve(undefined) })
    req.end()
  })
}

/** Resolve the launch token asynchronously: ssh is a subprocess and must never block the loop. */
function readTokenFile(remote) {
  const source = remote.tokenFile
  if (source === undefined) return Promise.resolve(undefined)
  if (source.kind !== 'ssh') {
    try {
      return Promise.resolve(JSON.parse(fs.readFileSync(source.path, 'utf8')))
    } catch (error) {
      remote.lastError = 'token source (file): ' + error.message
      return Promise.resolve(undefined)
    }
  }
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new']
  if (source.port !== undefined) args.push('-p', String(source.port))
  const target = (source.user === undefined ? '' : source.user + '@') + source.host
  args.push(target, 'cat', source.path)
  return new Promise(function (resolve) {
    execFile('ssh', args, { timeout: 10000, maxBuffer: 64 * 1024 }, function (error, stdout) {
      if (error !== null) {
        remote.lastError = 'token source (ssh): ' + error.message
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (parseError) {
        remote.lastError = 'token source: ' + parseError.message
        resolve(undefined)
      }
    })
  })
}

function resolveToken(remote) {
  if (remote.token !== undefined) return Promise.resolve(remote.token)
  return readTokenFile(remote).then(function (record) {
    if (record === undefined) return undefined
    if (typeof record.token !== 'string' || record.token === '') {
      remote.lastError = 'token source: file has no token'
      return undefined
    }
    remote.token = record.token
    if (typeof record.hostname === 'string') remote.hostname = record.hostname
    if (typeof record.webPort === 'number') remote.webPort = record.webPort
    if (typeof record.dshHome === 'string' && record.dshHome !== '') remote.dshHome = record.dshHome
    return remote.token
  })
}

/** One in-flight token exchange per remote: concurrent first hits share it. */
function ensureCookie(remote) {
  if (remote.cookie !== undefined) return Promise.resolve(remote.cookie)
  if (remote.pendingCookie !== undefined) return remote.pendingCookie
  const pending = resolveToken(remote).then(function (token) {
    if (token === undefined) return undefined
    return exchangeCookie(remote).then(function (cookie) {
      if (cookie !== undefined) {
        remote.cookie = cookie
        remote.lastError = undefined
      } else {
        remote.lastError = 'token exchange returned no cookie'
      }
      return cookie
    })
  })
  remote.pendingCookie = pending
  const clear = function () { if (remote.pendingCookie === pending) remote.pendingCookie = undefined }
  pending.then(clear, clear)
  return pending
}

/**
 * Floating backend switcher injected into the hub's own index page and into every
 * proxied remote index page. A details/summary dropdown keeps it script-free and
 * therefore safe to splice into pages this plugin does not own.
 */
/** Switcher placement: top-left (default, right of the sidebar) or bottom-right. */
/** Switcher placement: a sidebar dropdown (default) or the old floating pill. */
/** Switcher placement: a sidebar dropdown (default) or the old floating pill. */
/** Switcher placement: a persistent top bar (default), a sidebar dropdown, or the old floating pill. */
/** Switcher placement and extras. */
function normalizeSwitcher(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    mode: cfg.mode === 'floating' ? 'floating' : 'bar',
    dropdown: cfg.dropdown === true,
    sidebarTree: cfg.sidebarTree !== false,
    corner: cfg.corner === 'bottom-right' ? 'bottom-right' : 'top-left',
    offsetX: typeof cfg.offsetX === 'number' ? cfg.offsetX : 10,
    offsetY: typeof cfg.offsetY === 'number' ? cfg.offsetY : 8,
  }
}

/**
 * Backend switcher. A persistent top bar lists 本机 + every remote; picking a
 * remote swaps the area below the bar to an iframe of that backend (mounted
 * once and kept alive), and 本机 hides the pane again to reveal the same local
 * page — never a reload. The bar reserves 34px through body padding so the app
 * layout does not shift. Colors come from the app's own theme tokens
 * (--dsw-alias-*), so the bar follows light/dark mode instead of system colors.
 * The optional sidebar dropdown is off by default; the top bar replaces it.
 */
export function switcherMarkup(hosts, currentId, options) {
  const opts = options === undefined ? normalizeSwitcher(undefined) : options
  const items = [{ id: 'local', label: '本机 (local)', href: '/' }]
  for (const host of hosts) items.push({ id: host.id, label: host.label, href: PREFIX + '/' + host.id + '/' })
  let current = '本机'
  for (const item of items) if (item.id === currentId) current = item.label
  const data = {
    current: current,
    mode: opts.mode,
    dropdown: opts.dropdown,
    sidebarTree: opts.sidebarTree,
    items: items.map(function (item) {
      return { id: item.id, label: item.label, href: item.href, active: item.id === currentId }
    }),
  }
  const payload = encodeURIComponent(JSON.stringify(data))
  const css = 'body{padding-top:34px !important;box-sizing:border-box !important}' +
    '#dsh-hub-bar{position:fixed;top:0;left:0;right:0;height:34px;display:flex;align-items:center;gap:6px;padding:0 10px;' +
    'background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);' +
    'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));z-index:2147483200;' +
    'font:12px/1 system-ui,sans-serif;box-sizing:border-box;overflow-x:auto;white-space:nowrap}' +
    '#dsh-hub-bar button{padding:5px 10px;border-radius:6px;border:1px solid transparent;background:transparent;' +
    'color:inherit;cursor:pointer;font:inherit;white-space:nowrap}' +
    '#dsh-hub-bar button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}' +
    '#dsh-hub-bar button[data-active="1"]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2));' +
    'border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}' +
    '#dsh-hub-bar a{color:var(--dsw-alias-label-secondary,CanvasText);text-decoration:none;padding:5px 10px;' +
    'border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));white-space:nowrap}' +
    '#dsh-hub-pane{position:fixed;top:34px;left:0;right:0;bottom:0;display:none;' +
    'background:var(--dsw-alias-bg-base,#fff);z-index:2147483199}' +
    '#dsh-hub-pane iframe{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base,#fff)}' +
    '#dsh-hub-bar .dsh-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;' +
    'vertical-align:middle;background:#8a8a8a}' +
    '#dsh-hub-bar .dsh-dot[data-state="online"]{background:#37b24d}' +
    '#dsh-hub-bar .dsh-dot[data-state="pending"]{background:#f59f0b;box-shadow:0 0 0 2px rgba(245,159,11,.25)}' +
    '#dsh-hub-bar .dsh-dot[data-state="offline"]{background:#e03131}' +
    '#dsh-hub-bar .dsh-dot[data-state="unknown"]{background:#8a8a8a}'
  const script = '<script>(function(){' +
    'var holder=document.getElementById("dsh-hub-switch-data");if(!holder)return;' +
    'var DATA=JSON.parse(decodeURIComponent(holder.getAttribute("data-json")));' +
    'var framed=window.self!==window.top;' +
    'var onRemotes=location.pathname.indexOf("/remotes/")===0;' +
    'var bar=null,pane=null,frames={},dots={},activeId="local";' +
    'function el(tag,css,text){var e=document.createElement(tag);if(css)e.style.cssText=css;if(text!==undefined)e.textContent=text;return e;}' +
    'function post(id){try{parent.postMessage({type:"dsh-hub-open",id:id},"*");}catch(e){}}' +
    'function installStyle(){if(document.getElementById("dsh-hub-style"))return;var s=document.createElement("style");s.id="dsh-hub-style";s.textContent=' + JSON.stringify(css) + ';document.head.appendChild(s);}' +
    'function build(){' +
    'if(bar)return;installStyle();' +
    'bar=el("div");bar.id="dsh-hub-bar";' +
    'DATA.items.forEach(function(it){var b=el("button");b.setAttribute("data-id",it.id);' +
    'if(it.id!=="local"){var d=el("span");d.className="dsh-dot";d.setAttribute("data-state","unknown");dots[it.id]=d;b.appendChild(d);}' +
    'b.appendChild(document.createTextNode(it.label));' +
    'b.onclick=function(){if(it.id==="local"){showLocal();}else{showRemote(it.id);}};bar.appendChild(b);});' +
    'bar.appendChild(el("span","flex:1"));' +
    'var nb=el("button","display:none");nb.id="dsh-hub-new-session";' +
    'nb.onclick=function(){if(activeId!=="local")chooseCwdAndCreate(activeId);};' +
    'bar.appendChild(nb);' +
    'document.body.appendChild(bar);' +
    'pane=el("div");pane.id="dsh-hub-pane";document.body.appendChild(pane);' +
    'sync();poll();setInterval(poll,5000);}' +
    'function applyStatus(rows){rows.forEach(function(r){var d=dots[r.id];if(!d)return;d.setAttribute("data-state",r.state||"unknown");' +
    'var b=d.parentElement;if(!b)return;' +
    'var parts=[r.state||"unknown"];if(r.tunnel&&r.tunnel.state)parts.push("tunnel "+r.tunnel.state);if(r.lastError)parts.push(r.lastError);' +
    'b.title=parts.join(" | ");});}' +
    'function poll(){fetch("/api/remote-hosts/list",{headers:{accept:"application/json"}}).then(function(r){return r.json();})' +
    '.then(function(d){if(d&&d.remotes)applyStatus(d.remotes);}).catch(function(){});}' +
    'function sync(){if(!bar)return;Array.prototype.forEach.call(bar.querySelectorAll("button[data-id]"),function(b){' +
    'if(b.getAttribute("data-id")===activeId){b.setAttribute("data-active","1");}else{b.removeAttribute("data-active");}});' +
    'var nb=document.getElementById("dsh-hub-new-session");' +
    'if(nb){var lab=null;DATA.items.forEach(function(it){if(it.id===activeId)lab=it.label;});' +
    'if(activeId==="local"||lab===null){nb.style.display="none";}else{nb.style.display="";nb.textContent="＋ 在 "+lab+" 新建会话";}}}' +
    'function showRemote(id){' +
    'if(framed){post(id);return;}' +
    'if(onRemotes){location.href="/remotes/"+id+"/";return;}' +
    'build();' +
    'if(!frames[id]){var f=el("iframe");f.src="/remotes/"+id+"/";f.onload=function(){deliverPending();};pane.appendChild(f);frames[id]=f;}' +
    'Object.keys(frames).forEach(function(k){frames[k].style.display=(k===id)?"block":"none";});' +
    'pane.style.display="block";activeId=id;sync();}' +
    'function showLocal(){' +
    'if(framed){post("local");return;}' +
    'if(onRemotes){location.href="/";return;}' +
    'build();pane.style.display="none";activeId="local";sync();}' +
    'var pendingOpen=null;' +
    'function deliverPending(){if(pendingOpen===null)return;var frame=frames[pendingOpen.id];if(frame===undefined||frame.contentWindow===null)return;' +
    'try{frame.contentWindow.postMessage({type:"dsh-hub-open-session",sessionId:pendingOpen.sessionId},"*");}catch(e){}}' +
    'function scheduleDelivery(){var attempts=0;var timer=setInterval(function(){if(pendingOpen===null||++attempts>20){clearInterval(timer);return;}deliverPending();},500);deliverPending();}' +
    'function openRemoteSession(id,sessionId){if(framed){post(id);return;}if(onRemotes){location.href="/remotes/"+id+"/";return;}pendingOpen={id:id,sessionId:sessionId};showRemote(id);scheduleDelivery();}' +
    'function createRemoteSession(id,cwd){' +
    'var body={id:id};if(typeof cwd==="string"&&cwd!=="")body.cwd=cwd;' +
    'fetch("/api/remote-hosts/session/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})' +
    '.then(function(r){return r.json();}).then(function(d){' +
    'if(d&&d.ok&&typeof d.sessionId==="string"){openRemoteSession(id,d.sessionId);}' +
    'else{window.alert("新建远端会话失败："+((d&&d.error)||"unknown"));}' +
    '}).catch(function(e){window.alert("新建远端会话失败："+e);});}' +
    'function lastCwd(id){try{return localStorage.getItem("dsh-hub-cwd:"+id)||"";}catch(e){return "";}}' +
    'function saveCwd(id,cwd){try{if(cwd)localStorage.setItem("dsh-hub-cwd:"+id,cwd);}catch(e){}}' +
    'var treeBox=null,treeAt=0,treeRows=[],treeExpanded={};' +
    'function fetchTree(){' +
    'if(Date.now()-treeAt<8000)return;treeAt=Date.now();' +
    'Promise.all([fetch("/api/remote-hosts/list",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).catch(function(){return{};}),' +
    'fetch("/api/remote-hosts/workspaces",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).catch(function(){return{};})])' +
    '.then(function(pair){var hosts=(pair[0]&&pair[0].remotes)||[],snaps=(pair[1]&&pair[1].remotes)||[];' +
    'treeRows=hosts.filter(function(h){return h.id!=="local";}).map(function(h){' +
    'var snap=null;for(var i=0;i<snaps.length;i++)if(snaps[i].id===h.id)snap=snaps[i];' +
    'var sessions=[];if(snap){((snap.workspaces)||[]).forEach(function(w){((w&&w.sessions)||[]).forEach(function(s){sessions.push(s);});});((snap.orphans)||[]).forEach(function(s){sessions.push(s);});}' +
    'sessions.sort(function(a,b){return(b.updatedAt||0)-(a.updatedAt||0);});' +
    'return{id:h.id,label:h.label||h.id,state:h.state,sessions:sessions};});renderTree();' +
    '}).catch(function(){});}' +
    'function renderTree(){' +
    'if(!treeBox)return;treeBox.innerHTML="";' +
    'treeBox.appendChild(el("div","font-size:11px;font-weight:600;opacity:.65;padding:4px 6px;letter-spacing:.02em","远端工作区"));' +
    'treeRows.forEach(function(remote){' +
    'var det=el("details","margin-top:1px");det.open=treeExpanded[remote.id]!==false;' +
    'det.addEventListener("toggle",function(){treeExpanded[remote.id]=det.open;});' +
    'var sum=el("summary","display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;list-style:none");' +
    'var dot=el("span","display:inline-block;width:7px;height:7px;border-radius:50%;flex:0 0 auto");' +
    'dot.style.background=remote.state==="online"?"#37b24d":remote.state==="pending"?"#f59f0b":remote.state==="offline"?"#e03131":"#8a8a8a";' +
    'sum.appendChild(dot);' +
    'sum.appendChild(el("span","flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",remote.label));' +
    'sum.appendChild(el("span","opacity:.55;font-size:11px",String(remote.sessions.length)));' +
    'var plus=el("button","border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 4px;opacity:.75","+");' +
    'plus.title="在 "+remote.label+" 新建会话";' +
    'plus.onclick=function(ev){ev.preventDefault();ev.stopPropagation();chooseCwdAndCreate(remote.id);};' +
    'sum.appendChild(plus);det.appendChild(sum);' +
    'remote.sessions.forEach(function(session){' +
    'var row=el("div","padding:2px 6px 2px 20px;border-radius:4px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");' +
    'row.title=(session.cwd||"")+"\\n"+session.id;' +
    'row.appendChild(el("span",null,session.title===null||session.title===undefined?session.id.slice(0,30):session.title));' +
    'if(session.running)row.appendChild(el("span","opacity:.55"," ●"));' +
    'row.onmouseenter=function(){row.style.background="var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))";};' +
    'row.onmouseleave=function(){row.style.background="transparent";};' +
    'row.onclick=function(){openRemoteSession(remote.id,session.id);};' +
    'det.appendChild(row);});' +
    'treeBox.appendChild(det);});' +
    'treeBox.style.display=treeRows.length===0?"none":"";}' +
    'function ensureSidebarTree(){' +
    'if(framed||!DATA.sidebarTree)return;' +
    'var region=document.querySelector(String.fromCharCode(91)+"class*="+String.fromCharCode(34)+"regionArea"+String.fromCharCode(34)+String.fromCharCode(93));' +
    'if(!region)return;if(region.clientWidth<90)return;' +
    'if(!treeBox||!treeBox.isConnected){treeBox=el("div",null);treeBox.id="dsh-hub-sidebar-tree";' +
    'treeBox.style.cssText="flex:0 0 auto;max-height:45%;overflow:auto;padding:4px 6px 10px;margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));font:12px/1.4 system-ui,sans-serif;color:var(--dsw-alias-label-primary,inherit);";' +
    'region.appendChild(treeBox);renderTree();}' +
    'fetchTree();}' +
    'function chooseCwdAndCreate(id){' +
    'if(!id||id==="local")return;var label=id;DATA.items.forEach(function(it){if(it.id===id)label=it.label;});' +
    'fetch("/api/remote-hosts/workspaces",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).then(function(d){' +
    'var paths=[],row=null;((d&&d.remotes)||[]).forEach(function(x){if(x.id===id)row=x;});' +
    'function add(p){if(typeof p==="string"&&p!==""&&paths.indexOf(p)<0)paths.push(p);}' +
    'if(row){((row.workspaces)||[]).forEach(function(w){add(w&&w.path);});((row.orphans)||[]).forEach(function(o){add(o&&o.cwd);});}' +
    'var rec=lastCwd(id);if(rec)add(rec);showCwdDialog(id,label,paths,rec);' +
    '}).catch(function(){showCwdDialog(id,label,[],lastCwd(id));});}' +
    'function showCwdDialog(id,label,paths,prefill){' +
    'var bs="padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font:inherit";' +
    'var shade=el("div","position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif");' +
    'var box=el("div","width:440px;max-width:92vw;padding:14px;border-radius:10px;box-shadow:0 12px 32px #0006;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))");' +
    'box.appendChild(el("div","font-weight:600;margin-bottom:10px","在 "+label+" 新建会话"));' +
    'var sel=el("select","width:100%;padding:6px;margin-bottom:8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit");' +
    'var opts=[{v:"",t:"默认目录（远端默认）"}];paths.forEach(function(p){opts.push({v:p,t:p});});opts.push({v:"__custom",t:"自定义路径…"});' +
    'opts.forEach(function(o){var op=el("option",null,o.t);op.value=o.v;sel.appendChild(op);});' +
    'if(prefill){for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===prefill){sel.selectedIndex=i;break;}}}' +
    'var inp=el("input","width:100%;box-sizing:border-box;padding:6px;margin-bottom:10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:inherit;display:"+(sel.value==="__custom"?"block":"none"));' +
    'inp.placeholder="/home/yhuan/workspace/…";inp.value=prefill||"";sel.onchange=function(){inp.style.display=sel.value==="__custom"?"block":"none";};' +
    'box.appendChild(sel);box.appendChild(inp);' +
    'var rowEl=el("div","display:flex;justify-content:flex-end;gap:8px");' +
    'var cancel=el("button",bs,"取消");cancel.onclick=function(){shade.remove();};' +
    'var ok=el("button",bs,"创建");ok.onclick=function(){var cwd=sel.value==="__custom"?inp.value.trim():sel.value;saveCwd(id,cwd);shade.remove();createRemoteSession(id,cwd);};' +
    'rowEl.appendChild(cancel);rowEl.appendChild(ok);box.appendChild(rowEl);shade.appendChild(box);document.body.appendChild(shade);' +
    'setTimeout(function(){if(sel.value==="__custom")inp.focus();},30);}' +
    'window.addEventListener("message",function(ev){if(ev.origin!==location.origin)return;var d=ev.data;if(!d||typeof d!=="object")return;' +
    'if(d.type==="dsh-hub-open"){if(d.id&&d.id!=="local"){showRemote(d.id);}else{showLocal();}return;}' +
    'if(d.type==="dsh-hub-opened"){if(pendingOpen!==null&&pendingOpen.sessionId===d.sessionId){pendingOpen=null;}return;}});' +
    'window.addEventListener("dsh-hub-open-session",function(ev){var d=ev&&ev.detail;if(!d||typeof d.remoteId!=="string")return;' +
    'openRemoteSession(d.remoteId,typeof d.sessionId==="string"&&d.sessionId!==""?d.sessionId:null);});' +
    'document.addEventListener("keydown",function(ev){if(ev.key==="Escape")showLocal();});' +
    'function panel(){' +
    'var p=el("div","position:absolute;left:0;right:0;top:38px;z-index:2147483000;padding:6px;border-radius:8px;box-shadow:0 8px 24px #0008;' +
    'background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));max-height:60vh;overflow:auto");' +
    'DATA.items.forEach(function(it){var a=el("a","display:block;padding:6px 10px;border-radius:6px;text-decoration:none;color:inherit;",it.label);' +
    'a.href=it.href;' +
    'a.onclick=function(ev){if(ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;ev.preventDefault();' +
    'if(framed){post(it.id);return;}' +
    'if(onRemotes){location.href=it.href;return;}' +
    'if(it.id==="local"){showLocal();}else{showRemote(it.id);}};' +
    'if(it.id===activeId){a.style.background="var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))";}' +
    'p.appendChild(a);});' +
    'var sep=el("div","border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));margin:6px 0");' +
    'p.appendChild(sep);' +
    'DATA.items.forEach(function(it){if(it.id==="local")return;' +
    'var b=el("button","display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit","＋ 在 "+it.label+" 新建会话");' +
    'b.onclick=function(ev){ev.preventDefault();ev.stopPropagation();chooseCwdAndCreate(it.id);};' +
    'p.appendChild(b);});' +
    'return p;}' +
    'function buildDropdown(btn){' +
    'var cs=btn?getComputedStyle(btn):null;' +
    'var bh=(cs&&cs.height)||"32px";' +
    'var d=el("details","position:relative;width:100%;box-sizing:border-box;margin-top:6px");d.id="dsh-hub-switch";' +
    'var s=el("summary",null,"⇄ "+DATA.current+" ▾");' +
    'var st="list-style:none;display:flex;align-items:center;gap:6px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-sizing:border-box;width:100%;";' +
    'st+="height:"+bh+";border-radius:"+(cs?cs.borderRadius:"8px")+";";' +
    'if(cs){st+="font-family:"+cs.fontFamily+";font-size:"+cs.fontSize+";font-weight:"+cs.fontWeight+";line-height:"+cs.lineHeight+";padding-left:"+cs.paddingLeft+";padding-right:"+cs.paddingRight+";";}' +
    'st+="color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));";' +
    'st+="border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));";' +
    's.style.cssText=st;' +
    's.onmouseenter=function(){s.style.background="var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))";};' +
    's.onmouseleave=function(){s.style.background="var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))";};' +
    'var p=panel();p.style.top=((parseInt(bh,10)||32)+6)+"px";' +
    'd.appendChild(s);d.appendChild(p);return d;}' +
    'function anchor(){var b=document.querySelector(String.fromCharCode(91)+"class*="+String.fromCharCode(34)+"_newSession"+String.fromCharCode(34)+String.fromCharCode(93));return (b&&b.parentElement)?b:null;}' +
    'function mounted(){return document.getElementById("dsh-hub-switch");}' +
    'function collapsed(){return document.querySelector("[data-sidebar-collapsed]")!==null;}' +
    'function insertDropdown(){if(mounted())return true;if(collapsed())return false;var b=anchor();if(!b)return false;b.parentElement.insertBefore(buildDropdown(b),b.nextSibling);return true;}' +
    'function floating(){' +
    'if(mounted()||document.getElementById("dsh-hub-switch-fallback"))return;installStyle();' +
    'var w=el("details","position:fixed;right:14px;bottom:14px;z-index:2147483000;font:12px/1.2 system-ui,sans-serif");w.id="dsh-hub-switch-fallback";' +
    'var s=el("summary","list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;' +
    'background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))","⇄ "+DATA.current+" ▾");' +
    'w.appendChild(s);var p=panel();p.style.cssText+=";left:auto;right:0;top:auto;bottom:34px;min-width:180px;width:auto";w.appendChild(p);' +
    'document.body.appendChild(w);}' +
    'function closeIfOutside(ev){["dsh-hub-switch","dsh-hub-switch-fallback"].forEach(function(id){var e=document.getElementById(id);if(e&&e.open&&!e.contains(ev.target))e.open=false;});}' +
    'document.addEventListener("click",closeIfOutside,true);' +
    'document.addEventListener("keydown",function(ev){if(ev.key!=="Escape")return;["dsh-hub-switch","dsh-hub-switch-fallback"].forEach(function(id){var e=document.getElementById(id);if(e&&e.open)e.open=false;});});' +
    'if(!framed){if(DATA.mode==="floating"){floating();}else{build();}}' +
    'if(!framed&&DATA.sidebarTree){setTimeout(function(){ensureSidebarTree();},600);setInterval(ensureSidebarTree,2000);}' +
    'if(!framed&&DATA.dropdown){' +
    'var tries=0;if(!insertDropdown()){var t=setInterval(function(){if(insertDropdown()||++tries>80){clearInterval(t);if(!mounted())floating();}},250);}' +
    'new MutationObserver(function(){if(!mounted())insertDropdown();}).observe(document.body,{childList:true,subtree:true});}' +
    '})();<\/script>'
  return '<div id="dsh-hub-switch-data" hidden data-json="' + payload + '"></div>' + script
}

export function launcherPage(hosts) {
  const items = hosts.map(function (host) {
    return '<li><a href="/remotes/' + encodeURIComponent(host.id) + '/">' + escapeHtml(host.label) + '</a>' +
      '<span class="muted"> ' + escapeHtml(host.id) + '</span></li>'
  }).join('')
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>DSH remotes</title><style>' +
    'html,body{margin:0;min-height:100%;font:13px/1.6 system-ui,sans-serif;background:#151517;color:#ddd}' +
    'main{max-width:640px;margin:0 auto;padding:32px 20px}' +
    'h1{font-size:16px;margin:0 0 6px}' +
    'p{color:#999;margin:0 0 14px}' +
    'ul{padding-left:18px;margin:0 0 18px}' +
    'li{margin:6px 0}' +
    'a{color:#8ab4f8;text-decoration:none}a:hover{text-decoration:underline}' +
    '.muted{color:#888;font-size:12px}' +
    '</style></head><body><main>' +
    '<p class="muted">dsh-remote-hub</p>' +
    '<h1>远端入口（兜底页）</h1>' +
    '<p>日常切换用顶栏；远端管理在「设置 → 插件 → dsh-remote-hub」。本页仅在顶栏不可用时使用。</p>' +
    '<ul>' + (items === '' ? '<li class="muted">还没有配置远端。</li>' : items) + '</ul>' +
    '<p><a href="/">&larr; 回到本机</a></p>' +
    '<p><a href="/remotes/_status">诊断 JSON</a></p>' +
    '</main></body></html>'
}

export async function apply(ctx, config) {
  const dshTools = await loadDshTools()
  const storeFile = path.join(dshHome(), 'remote-hosts.json')
  const switcherOptions = normalizeSwitcher(config === undefined ? undefined : config.switcher)
  const upstreamTimeoutMs = config !== undefined && typeof config.upstreamTimeoutMs === 'number' && config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : 30000
  const probeIntervalMs = config !== undefined && typeof config.probeIntervalMs === 'number' && config.probeIntervalMs >= 0 ? config.probeIntervalMs : 30000
  // OpenCode integration moved to the separate dsh-opencode-client plugin.
  const opencodeServers = []
  const opencodePermission = config !== undefined && config.opencodePermission === 'reject' ? 'reject' : 'always'
  const opencodeProviderStatus = { registered: [], errors: [] }
  const opencodePathMap = (function () {
    const raw = config === undefined ? undefined : config.opencodePathMap
    if (!Array.isArray(raw)) return []
    const rules = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.from !== 'string' || item.from === '' || typeof item.to !== 'string') continue
      rules.push({ from: item.from.replace(/\/+$/, ''), to: item.to.replace(/\/+$/, '') })
    }
    return rules
  })()
  const state = { hosts: [], byId: new Map(), upgrades: new Map(), removed: new Set() }

  function dshHome() {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return path.join(os.homedir(), '.dsh')
  }

  function writeStore(body) {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 })
      const tmp = storeFile + '.tmp-' + String(process.pid)
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, storeFile)
    } catch (error) {
      if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('remote-hub: cannot write store: ' + error.message)
    }
  }

  function toRecord(host) {
    const record = { id: host.id, label: host.label }
    if (host.ssh !== undefined) {
      record.ssh = host.ssh
      record.remotePort = host.remotePort
    }
    if (host.upstreamText !== undefined) record.upstream = host.upstreamText
    if (host.localPortFixed) record.localPort = host.localPort
    if (host.tokenOrigin === 'inline' && host.token !== undefined) record.token = host.token
    if (host.tokenFile !== undefined) record.tokenFile = host.tokenFile
    return record
  }

  function persistStore() {
    const body = { version: 1, removed: Array.from(state.removed), hosts: state.hosts.map(toRecord) }
    writeStore(body)
  }

  function loadState() {
    const configured = normalizeRemotes(config)
    let store
    let rawStore
    try {
      rawStore = fs.readFileSync(storeFile, 'utf8')
      store = JSON.parse(rawStore)
    } catch {
      store = undefined
      if (rawStore !== undefined) {
        try {
          fs.renameSync(storeFile, storeFile + '.corrupt-' + String(Date.now()))
        } catch {}
      }
    }
    if (store === null || typeof store !== 'object' || !Array.isArray(store.hosts)) {
      state.removed = new Set()
      state.hosts = configured
      configured.forEach(function (host, index) { host.index = index })
      configured.forEach(function (host) { state.byId.set(host.id, host) })
      persistStore()
      return
    }
    state.removed = new Set(Array.isArray(store.removed) ? store.removed : [])
    const hosts = normalizeRemotes({ remotes: store.hosts })
    for (const seed of configured) {
      if (state.removed.has(seed.id)) continue
      if (hosts.some(function (host) { return host.id === seed.id })) continue
      hosts.push(seed)
    }
    hosts.forEach(function (host, index) { host.index = index })
    state.hosts = hosts
    for (const host of hosts) state.byId.set(host.id, host)
    persistStore()
  }

  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 32)
  }

  function hostFromInput(body) {
    const label = String(body.label === undefined ? '' : body.label).trim()
    let id = String(body.id === undefined ? '' : body.id).trim()
    if (id === '') id = slug(label)
    if (id === '' || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
    const record = { id: id, label: label === '' ? id : label }
    if (body.transport === 'direct') {
      const upstream = String(body.upstream === undefined ? '' : body.upstream).trim()
      if (upstream === '') return undefined
      record.upstream = upstream
    } else {
      const ssh = body.ssh === null || typeof body.ssh !== 'object' ? {} : body.ssh
      const host = String(ssh.host === undefined ? '' : ssh.host).trim()
      if (host === '') return undefined
      record.ssh = { host: host, user: typeof ssh.user === 'string' && ssh.user !== '' ? ssh.user : undefined, port: typeof ssh.port === 'number' ? ssh.port : undefined }
      record.remotePort = typeof body.remotePort === 'number' ? body.remotePort : 3080
    }
    if (typeof body.localPort === 'number') record.localPort = body.localPort
    if (body.tokenMode === 'inline' && typeof body.token === 'string' && body.token !== '') {
      record.token = body.token
    } else if (body.tokenMode === 'ssh' && record.ssh !== undefined) {
      record.tokenFile = { kind: 'ssh', host: record.ssh.host, user: record.ssh.user, path: '~/.dsh/remote-agent.json' }
    } else if (body.tokenMode === 'file' && typeof body.tokenPath === 'string' && body.tokenPath !== '') {
      record.tokenFile = { kind: 'file', path: body.tokenPath }
    }
    return record
  }

  function disposeUpgrade(id) {
    const dispose = state.upgrades.get(id)
    if (dispose === undefined) return
    state.upgrades.delete(id)
    try { dispose() } catch {}
  }

  function ensureUpgrade(host) {
    if (state.upgrades.has(host.id)) return
    const dispose = ctx.webServer.registerUpgrade({
      path: PREFIX + '/' + host.id + '/api/remote.mux',
      handler: handleUpgrade(host),
    })
    state.upgrades.set(host.id, dispose)
  }

  function disposeHost(host) {
    disposeUpgrade(host.id)
    stopTunnel(host)
  }

  function upsertHost(record) {
    const normalized = normalizeRemotes({ remotes: [record] })[0]
    if (normalized === undefined) return undefined
    const existing = state.byId.get(normalized.id)
    if (existing !== undefined) {
      disposeHost(existing)
      const at = state.hosts.indexOf(existing)
      state.hosts[at] = normalized
    } else {
      state.hosts.push(normalized)
    }
    normalized.index = state.hosts.indexOf(normalized)
    state.removed.delete(normalized.id)
    state.byId.set(normalized.id, normalized)
    ensureUpgrade(normalized)
    if (normalized.ssh !== undefined) startTunnel(normalized)
    persistStore()
    return normalized.id
  }

  function removeHostById(id) {
    const host = state.byId.get(id)
    if (host === undefined) return false
    disposeHost(host)
    state.byId.delete(id)
    const at = state.hosts.indexOf(host)
    if (at !== -1) state.hosts.splice(at, 1)
    state.removed.add(id)
    persistStore()
    return true
  }

  function hostState(host) {
    const tunnelState = host.tunnel === undefined ? undefined : host.tunnel.state
    if (tunnelState === 'starting') return 'pending'
    if (tunnelState === 'down') return 'offline'
    if (host.health === 'offline') return 'offline'
    if (host.health === 'online') return 'online'
    if (tunnelState === 'up') return 'online'
    if (host.lastError !== undefined) return 'offline'
    if (host.cookie !== undefined) return 'online'
    return 'unknown'
  }

  function listHosts() {
    return state.hosts.map(function (host) {
      const row = {
        id: host.id,
        label: host.label,
        state: hostState(host),
        transport: host.ssh === undefined ? 'direct' : 'ssh-tunnel',
        upstream: host.url === undefined ? null : host.url.origin,
        remotePort: host.ssh === undefined ? null : host.remotePort,
        ssh: host.ssh === undefined ? null : { host: host.ssh.host, user: host.ssh.user === undefined ? null : host.ssh.user, port: host.ssh.port === undefined ? null : host.ssh.port },
        localPort: host.localPort === undefined ? null : host.localPort,
        tunnel: host.tunnel === undefined ? null : { state: host.tunnel.state, attempts: host.tunnel.attempts },
        tokenSource: host.tokenOrigin,
        tokenResolved: host.token !== undefined,
        hasCookie: host.cookie !== undefined,
        health: host.health === undefined ? null : host.health,
        latencyMs: host.latencyMs === undefined ? null : host.latencyMs,
        lastProbeAt: host.lastProbeAt === undefined ? null : host.lastProbeAt,
        lastError: host.lastError === undefined ? null : host.lastError,
        stats: host.stats === undefined ? null : {
          requests: host.stats.requests,
          ok: host.stats.ok,
          errors: host.stats.errors,
          timeouts: host.stats.timeouts,
          avgLatencyMs: host.stats.requests === 0 ? null : Math.round(host.stats.latencySumMs / host.stats.requests),
          maxLatencyMs: host.stats.latencyMaxMs,
          lastRequestAt: host.stats.lastRequestAt,
        },
      }
      return row
    })
  }

  function probeHost(host) {
    const started = Date.now()
    return ensureUpstream(host).then(function (url) {
      if (url === undefined) return { ok: false, error: host.lastError === undefined ? 'no upstream' : host.lastError, latencyMs: Date.now() - started }
      return ensureCookie(host).then(function () {
        return new Promise(function (resolve) {
          const req = http.request({
            host: url.hostname,
            port: upstreamPort(url),
            method: 'GET',
            path: '/',
            headers: { host: url.host, cookie: host.cookie === undefined ? '' : host.cookie, accept: 'text/html' },
          }, function (res) {
            res.resume()
            res.on('end', function () {
              resolve({ ok: res.statusCode === 200, status: res.statusCode, latencyMs: Date.now() - started, tokenResolved: host.token !== undefined, hasCookie: host.cookie !== undefined })
            })
          })
          req.on('error', function (error) {
            resolve({ ok: false, error: error.message, latencyMs: Date.now() - started })
          })
          req.end()
        })
      })
    })
  }

  function originOf() {
    try {
      return new URL(ctx.webServer.getOrigin())
    } catch {
      return undefined
    }
  }

  function unauthorizedPage(res, status, detail) {
    const origin = originOf()
    const hint = origin === undefined ? '(origin unavailable)' : origin.origin
    const body = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>remote-hub: unauthorized</title>' +
      '<style>body{font:14px/1.6 system-ui,sans-serif;background:#151517;color:#ddd;padding:32px;max-width:720px}' +
      'code{background:#26262b;padding:2px 6px;border-radius:4px}</style></head><body>' +
      '<h2>' + String(status) + ' ' + escapeHtml(detail) + '</h2>' +
      '<p>Hub 需要先完成 token 认证。两种方式：</p><ol>' +
      '<li>打开 <code>' + escapeHtml(hint) + '/remotes/?token=&lt;token&gt;</code>（token 见 dsh web 启动行）</li>' +
      '<li>或先打开 <code>' + escapeHtml(hint) + '/?token=&lt;token&gt;</code>，再回到本页</li>' +
      '</ol><p>注意 token 与主机名必须一致（用 127.0.0.1 就别换成 localhost）。</p></body></html>'
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function relayHubToken(token, pathname, res) {
    const origin = originOf()
    if (origin === undefined) return unauthorizedPage(res, 401, 'origin unavailable')
    const port = origin.port === '' ? 80 : Number(origin.port)
    const exchange = http.request({
      host: origin.hostname,
      port: port,
      method: 'GET',
      path: '/?token=' + encodeURIComponent(token),
      headers: { host: origin.host, accept: 'text/html' },
    }, function (upRes) {
      const set = upRes.headers['set-cookie']
      upRes.resume()
      upRes.on('end', function () {
        const cookie = Array.isArray(set) ? set[0] : set
        if (cookie === undefined || cookie.indexOf('=') <= 0) {
          unauthorizedPage(res, 401, 'invalid token')
          return
        }
        res.writeHead(303, { location: pathname, 'set-cookie': cookie, 'cache-control': 'no-store' })
        res.end()
      })
    })
    exchange.on('error', function () { unauthorizedPage(res, 401, 'token exchange failed') })
    exchange.end()
  }

  function reject(req, res, pathname, token) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    if (rejection === 401 && typeof token === 'string' && token !== '') {
      relayHubToken(token, pathname, res)
      return true
    }
    unauthorizedPage(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  function forward(host, req, res, attempt) {
    const startedAt = Date.now()
    if (attempt === 0) {
      if (host.stats === undefined) host.stats = { requests: 0, ok: 0, errors: 0, timeouts: 0, latencySumMs: 0, latencyMaxMs: 0, lastRequestAt: 0 }
      host.stats.requests += 1
      host.stats.lastRequestAt = startedAt
    }
    const stats = host.stats
    const url = host.url
    const parsed = new URL(req.url === undefined ? '/' : req.url, 'http://hub.invalid')
    const prefix = PREFIX + '/' + host.id
    let rest = parsed.pathname.slice(prefix.length)
    if (rest === '') rest = '/'
    const target = rest + parsed.search

    const headers = Object.assign({}, req.headers)
    headers.host = url.host
    if (headers.origin !== undefined) headers.origin = url.protocol + '//' + url.host
    if (host.cookie !== undefined) headers.cookie = host.cookie
    // The injection path buffers text/html, so ask upstream for an identity body whenever
    // the client's Accept does not rule HTML out (navigations, curl, fetch with */*).
    const accept = typeof headers.accept === 'string' ? headers.accept.trim() : ''
    const mightBeHtml = accept === '' || accept.indexOf('text/html') !== -1 || accept.indexOf('*/*') !== -1
    if (mightBeHtml) delete headers['accept-encoding']

    const upstream = http.request({
      host: url.hostname,
      port: upstreamPort(url),
      method: req.method,
      path: target,
      headers: headers,
    }, function (upRes) {
      clearTimeout(headerTimer)
      host.health = 'online'
      host.lastError = undefined
      if (stats !== undefined) {
        stats.ok += 1
        const took = Date.now() - startedAt
        stats.latencySumMs += took
        if (took > stats.latencyMaxMs) stats.latencyMaxMs = took
      }
      const status = upRes.statusCode === undefined ? 502 : upRes.statusCode
      const canRetry = attempt === 0 && host.token !== undefined &&
        (req.method === 'GET' || req.method === 'HEAD') && status === 401
      if (canRetry) {
        upRes.resume()
        host.cookie = undefined
        if (host.tokenFile !== undefined) host.token = undefined
        ensureCookie(host).then(function (cookie) {
          if (cookie === undefined) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('remote-hub: ' + host.id + ' needs a valid token (check the agent file or inline token)\n')
            return
          }
          forward(host, req, res, 1)
        })
        return
      }
      const out = Object.assign({}, upRes.headers)
      if (out['set-cookie'] !== undefined) out['set-cookie'] = rewriteSetCookie(out['set-cookie'], host.id)
      if (out.location !== undefined) out.location = rewriteLocation(out.location, url)
      const contentType = typeof out['content-type'] === 'string' ? out['content-type'] : ''
      const encoded = typeof out['content-encoding'] === 'string' && out['content-encoding'] !== '' && out['content-encoding'] !== 'identity'
      const isHtml = contentType.indexOf('text/html') !== -1 && !encoded
      if (!isHtml) {
        res.writeHead(status, out)
        upRes.pipe(res)
        return
      }
      const chunks = []
      let bytes = 0
      let overflow = false
      upRes.on('data', function (chunk) {
        if (overflow) return
        bytes += chunk.length
        if (bytes > HTML_INJECT_MAX_BYTES) {
          overflow = true
          const streaming = Object.assign({}, out)
          delete streaming['content-length']
          res.writeHead(status, streaming)
          for (const buffered of chunks) res.write(buffered)
          chunks.length = 0
          upRes.pipe(res)
          return
        }
        chunks.push(chunk)
      })
      upRes.on('error', function (error) {
        host.lastError = 'upstream stream: ' + error.message
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.destroy()
      })
      upRes.on('end', function () {
        if (overflow) return
        let body = Buffer.concat(chunks).toString('utf8')
        const injected = switcherMarkup(state.hosts, host.id, switcherOptions)
        if (/<\/body>/i.test(body)) body = body.replace(/<\/body>/i, injected + '</body>')
        else body = body + injected
        const outHeaders = Object.assign({}, out)
        delete outHeaders['transfer-encoding']
        outHeaders['content-length'] = String(Buffer.byteLength(body))
        res.writeHead(status, outHeaders)
        res.end(body)
      })
    })

    const headerTimer = setTimeout(function () {
      upstream.destroy(new Error('upstream timeout after ' + String(upstreamTimeoutMs) + 'ms'))
    }, upstreamTimeoutMs)
    upstream.on('close', function () { clearTimeout(headerTimer) })
    res.on('close', function () { if (!res.writableEnded) upstream.destroy() })

    upstream.on('error', function (error) {
      host.lastError = 'upstream: ' + error.message
      host.health = 'offline'
      const timedOut = error.message.indexOf('upstream timeout') !== -1
      if (stats !== undefined) {
        const took = Date.now() - startedAt
        stats.latencySumMs += took
        if (took > stats.latencyMaxMs) stats.latencyMaxMs = took
        if (timedOut) stats.timeouts += 1
        else stats.errors += 1
      }
      if (!res.headersSent) {
        res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('remote-hub: upstream error for ' + host.id + ': ' + error.message + '\n')
    })

    if (attempt === 0) req.pipe(upstream)
    else upstream.end()
  }

  function handleHttp(req, res) {
    const parsed = new URL(req.url === undefined ? '/' : req.url, 'http://hub.invalid')
    const pathname = parsed.pathname
    const token = parsed.searchParams.get('token')
    if (reject(req, res, pathname, token === null ? undefined : token)) return
    if (pathname === PREFIX || pathname === PREFIX + '/') {
      const body = launcherPage(state.hosts)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    if (pathname === PREFIX + '/_status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ remotes: listHosts() }, null, 2))
      return
    }
    const rest = pathname.slice(PREFIX.length + 1)
    const slash = rest.indexOf('/')
    const id = slash === -1 ? rest : rest.slice(0, slash)
    const host = state.byId.get(id)
    if (host === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('remote-hub: unknown remote ' + id + '\n')
      return
    }
    ensureUpstream(host).then(function (url) {
      if (url === undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('remote-hub: ' + host.id + ' upstream unavailable: ' + String(host.lastError) + '\n')
        return
      }
      return ensureCookie(host).then(function () {
        forward(host, req, res, 0)
      })
    })
  }

  function handleUpgrade(host) {
    return function (req, socket, head) {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        const reason = rejection === 401 ? 'Unauthorized' : 'Forbidden'
        socket.end('HTTP/1.1 ' + rejection + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      ensureUpstream(host).then(function (url) {
        if (url === undefined) {
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        return ensureCookie(host).then(function (cookie) {
          const parsed = new URL(req.url === undefined ? '/' : req.url, 'http://hub.invalid')
          const prefix = PREFIX + '/' + host.id
          let rest = parsed.pathname.slice(prefix.length)
          if (rest === '') rest = '/'
          const target = rest + parsed.search
          const headers = Object.assign({}, req.headers)
          headers.host = url.host
          if (headers.origin !== undefined) headers.origin = url.protocol + '//' + url.host
          if (cookie !== undefined) headers.cookie = cookie
          const upstream = net.connect(upstreamPort(url), url.hostname, function () {
            const lines = ['GET ' + target + ' HTTP/1.1']
            Object.keys(headers).forEach(function (key) {
              const value = headers[key]
              if (value === undefined) return
              lines.push(key + ': ' + (Array.isArray(value) ? value.join(', ') : value))
            })
            upstream.write(lines.join('\r\n') + '\r\n\r\n')
            if (head !== undefined && head.length > 0) upstream.write(head)
            upstream.pipe(socket)
            socket.pipe(upstream)
          })
          upstream.on('error', function () { socket.destroy() })
          socket.on('error', function () { upstream.destroy() })
        })
      })
    }
  }

  function jsonResponse(value, status) {
    return new Response(JSON.stringify(value), {
      status: status === undefined ? 200 : status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  function readJsonBody(request) {
    return request.json().then(function (value) {
      return value === null || typeof value !== 'object' ? {} : value
    }).catch(function () { return {} })
  }

  /** Answer pending permission requests of one remote session while a delegated task runs. */
  function watchOpencodePermissions(server, sessionId, directory) {
    const answered = new Set()
    const timer = setInterval(function () {
      opencodeRequest(server, '/permission', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has(request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add(request.id)
          opencodeRequest(server, '/permission/' + encodeURIComponent(request.id) + '/reply', {
            method: 'POST',
            body: { reply: opencodePermission },
            directory: directory,
            timeoutMs: 5000,
          })
        }
      })
    }, 1500)
    return function () { clearInterval(timer) }
  }

  /**
   * Delegate to a remote OpenCode session. Without a session id a new remote session
   * is created; with one, the task continues in that session.
   */
  function delegateOpencode(server, directory, task, sessionId) {
    const continuing = typeof sessionId === 'string' && sessionId !== ''
    const effectiveDirectory = continuing ? undefined : directory
    const ensure = continuing
      ? Promise.resolve(sessionId)
      : opencodeRequest(server, '/session', { method: 'POST', body: { title: 'dsh delegate' }, directory: directory, timeoutMs: 20000 }).then(function (created) {
        if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
          throw new Error('opencode: cannot create a session on ' + server.id)
        }
        return created.value.id
      })
    return ensure.then(function (id) {
      const stopWatching = watchOpencodePermissions(server, id, effectiveDirectory)
      return opencodeRequest(server, '/session/' + id + '/message', {
        method: 'POST',
        body: { parts: [{ type: 'text', text: task }] },
        directory: effectiveDirectory,
        timeoutMs: 900000,
      }).then(function (reply) {
        stopWatching()
        server.snapshot = undefined
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          throw new Error('opencode: no reply from ' + server.id + ' session ' + id)
        }
        const parts = Array.isArray(reply.value.parts) ? reply.value.parts : []
        const text = parts.filter(function (part) {
          return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        }).map(function (part) { return part.text }).join('\n').trim()
        return { sessionId: id, text: text === '' ? '(remote agent returned no text)' : text }
      }, function (error) {
        stopWatching()
        throw error
      })
    })
  }

  /** Map the parent's local working directory onto the remote filesystem. */
  function mapOpencodeDirectory(server, cwd) {
    if (typeof cwd === 'string' && cwd !== '') {
      for (const rule of opencodePathMap) {
        if (cwd === rule.from) return rule.to === '' ? '/' : rule.to
        if (cwd.startsWith(rule.from + '/')) {
          const suffix = cwd.slice(rule.from.length)
          return rule.to === '' ? suffix : rule.to + suffix
        }
      }
      return cwd
    }
    return typeof server.directory === 'string' && server.directory !== '' ? server.directory : undefined
  }

  /** Flatten ContentBlock[] into the text the remote agent receives. */
  function opencodePromptText(prompt) {
    if (!Array.isArray(prompt)) return ''
    const parts = []
    for (const block of prompt) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  /** One opencode-backed subagent run: remote session + message + permission policy. */
  function startOpencodeProviderRun(server, request) {
    const controller = new AbortController()
    const parentSignal = request.signal
    const onAbort = function () { controller.abort() }
    if (parentSignal !== undefined && parentSignal !== null) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', onAbort, { once: true })
    }
    const label = typeof request.label === 'string' && request.label !== '' ? request.label : 'dsh subagent'
    const directory = mapOpencodeDirectory(server, request.cwd)
    const task = opencodePromptText(request.prompt) || '(empty task)'
    const detach = function () {
      if (parentSignal !== undefined && parentSignal !== null) parentSignal.removeEventListener('abort', onAbort)
    }
    return opencodeRequest(server, '/session', { method: 'POST', body: { title: label }, directory: directory, timeoutMs: 20000 }).then(function (created) {
      if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
        detach()
        throw new Error('opencode provider ' + server.id + ': cannot create a session')
      }
      const sessionId = created.value.id
      const stopWatching = watchOpencodePermissions(server, sessionId, directory)
      const settle = function (result) {
        stopWatching()
        detach()
        server.snapshot = undefined
        return result
      }
      const result = opencodeRequest(server, '/session/' + sessionId + '/message', {
        method: 'POST',
        body: { parts: [{ type: 'text', text: task }] },
        directory: directory,
        timeoutMs: 3600000,
        signal: controller.signal,
      }).then(function (reply) {
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          return settle({ output: [], stopReason: controller.signal.aborted ? 'aborted' : 'error', diagnostic: 'opencode: no reply from ' + server.id + ' session ' + sessionId })
        }
        const parts = Array.isArray(reply.value.parts) ? reply.value.parts : []
        const text = parts.filter(function (part) {
          return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        }).map(function (part) { return part.text }).join('\n').trim()
        return settle({ output: text === '' ? [] : [{ type: 'text', text: text }], stopReason: 'completed' })
      }, function (error) {
        if (controller.signal.aborted) {
          opencodeRequest(server, '/session/' + sessionId + '/abort', { method: 'POST', timeoutMs: 5000 })
          return settle({ output: [], stopReason: 'aborted' })
        }
        const detail = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error)
        return settle({ output: [], stopReason: 'error', diagnostic: Buffer.byteLength(detail) > 4096 ? detail.slice(0, 4096) : detail })
      })
      return {
        id: sessionId,
        result: result,
        dispose: async function () {
          controller.abort()
          await result.catch(function () {})
        },
      }
    })
  }

  /** Flatten remote opencode sessions into tool rows, honoring simple filters. */
  function collectOpencodeSessionRows(serverId, directory, query, limit) {
    const wanted = typeof serverId === 'string' && serverId !== '' ? serverId : undefined
    const rows = []
    let chain = Promise.resolve()
    for (const server of opencodeServers) {
      if (wanted !== undefined && server.id !== wanted) continue
      chain = chain.then(function () {
        return collectOpencode(server).then(function (snapshot) {
          const projects = Array.isArray(snapshot.projects) ? snapshot.projects : []
          for (const project of projects) {
            const sessions = Array.isArray(project.sessions) ? project.sessions : []
            for (const session of sessions) {
              const sessionDirectory = session.directory === null ? (project.worktree === null ? '' : project.worktree) : session.directory
              if (directory !== undefined && directory !== '' && !sessionDirectory.startsWith(directory)) continue
              if (query !== undefined && query !== '' && session.title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
              rows.push({
                server: server.id,
                serverState: snapshot.state,
                directory: sessionDirectory,
                title: session.title,
                updatedAt: session.updatedAt,
                id: session.id,
              })
            }
          }
          return rows
        }, function (error) {
          rows.push({ server: server.id, serverState: 'offline', directory: '', title: '<unreachable: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) + '>', updatedAt: null, id: '' })
          return rows
        })
      })
    }
    return chain.then(function () {
      rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      const capped = limit !== undefined && limit > 0 ? rows.slice(0, limit) : rows
      const lines = capped.map(function (row) {
        const when = row.updatedAt === null || row.updatedAt === undefined ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
        return '- [' + row.server + '] ' + (row.directory === '' ? '(no dir)' : row.directory) + ' | ' + row.title + (when === '' ? '' : ' | ' + when) + ' | ' + row.id
      })
      return {
        count: rows.length,
        shown: capped.length,
        text: lines.length === 0 ? 'no matching remote opencode sessions' : lines.join('\n'),
      }
    })
  }

  /** dsh remote sessions (session/list RPC over the tunnel), cached briefly. */
  function collectDshSessionRows(host) {
    if (host.sessionSnapshot !== undefined && Date.now() - host.sessionSnapshot.at < 10000) {
      return Promise.resolve(host.sessionSnapshot.value)
    }
    return remoteRpc(host, 'session/list', { _request: {} }).then(function (result) {
      if (result === undefined || result.ok !== true || result.value === undefined) return []
      const items = Array.isArray(result.value.items) ? result.value.items : []
      const rows = items.map(function (item) {
        const values = item.projections !== null && typeof item.projections === 'object' && item.projections.values !== null && typeof item.projections.values === 'object' ? item.projections.values : {}
        return {
          backend: 'dsh',
          host: host.id,
          hostLabel: host.label,
          sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
          title: typeof values.title === 'string' && values.title !== '' ? values.title : null,
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
          running: item.running === true,
          agentAvailable: item.agentAvailable !== false,
          blank: item.blank === true,
        }
      })
      host.sessionSnapshot = { at: Date.now(), value: rows }
      return rows
    }, function () { return [] })
  }

  /** Unified remote session rows: dsh remotes plus configured opencode servers. */
  function collectRemoteSessionRows(backend, hostId, cwdPrefix, query, limit) {
    const rows = []
    let chain = Promise.resolve()
    if (backend === undefined || backend === 'dsh') {
      for (const host of state.hosts) {
        if (hostId !== undefined && host.id !== hostId) continue
        chain = chain.then(function () {
          return collectDshSessionRows(host).then(function (items) {
            for (const item of items) {
              if (cwdPrefix !== undefined && item.cwd !== null && item.cwd.indexOf(cwdPrefix) !== 0) continue
              if (query !== undefined && (item.title === null || item.title.toLowerCase().indexOf(query.toLowerCase()) < 0)) continue
              rows.push(item)
            }
          })
        })
      }
    }
    if (backend === undefined || backend === 'opencode') {
      for (const server of opencodeServers) {
        if (hostId !== undefined && server.id !== hostId) continue
        chain = chain.then(function () {
          return collectOpencode(server).then(function (snapshot) {
            const groups = Array.isArray(snapshot.projects) ? snapshot.projects : []
            for (const group of groups) {
              const sessions = Array.isArray(group.sessions) ? group.sessions : []
              for (const session of sessions) {
                const directory = session.directory === null ? (group.worktree === null ? null : group.worktree) : session.directory
                if (cwdPrefix !== undefined && directory !== null && directory.indexOf(cwdPrefix) !== 0) continue
                if (query !== undefined && session.title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
                rows.push({
                  backend: 'opencode',
                  host: server.id,
                  hostLabel: server.label,
                  sessionId: session.id,
                  title: session.title,
                  cwd: directory,
                  updatedAt: session.updatedAt,
                  running: false,
                  agentAvailable: snapshot.state === 'online',
                  blank: false,
                })
              }
            }
          }, function () {})
        })
      }
    }
    return chain.then(function () {
      rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      const capped = limit !== undefined && limit > 0 ? rows.slice(0, limit) : rows
      const lines = capped.map(function (row) {
        const when = row.updatedAt === null || row.updatedAt === undefined ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
        const flags = []
        if (row.running) flags.push('running')
        if (row.blank) flags.push('blank')
        if (!row.agentAvailable) flags.push('agent-unavailable')
        return '- [' + row.backend + ':' + row.host + '] ' + (row.cwd === null ? '(no cwd)' : row.cwd) + ' | ' + (row.title === null ? '(untitled)' : row.title) + (when === '' ? '' : ' | ' + when) + (flags.length === 0 ? '' : ' | ' + flags.join(',')) + ' | ' + row.sessionId
      })
      return { count: rows.length, shown: capped.length, text: lines.length === 0 ? 'no matching remote sessions' : lines.join('\n') }
    })
  }

  /** Provider registration payload for one configured opencode server. */
  function makeOpencodeProvider(server) {
    return {
      name: 'opencode-' + server.id,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      start: function (request) { return startOpencodeProviderRun(server, request) },
    }
  }

  const adminRoutes = [
    {
      path: '/api/remote-hosts/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () { return Promise.resolve(jsonResponse({ remotes: listHosts() })) },
    },
    {
      path: '/api/remote-hosts/save',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const record = hostFromInput(body)
          if (record === undefined) return jsonResponse({ ok: false, error: 'invalid input (需要 label + ssh.host 或 upstream)' }, 400)
          const id = upsertHost(record)
          if (id === undefined) return jsonResponse({ ok: false, error: 'invalid remote' }, 400)
          return jsonResponse({ ok: true, id: id })
        })
      },
    },
    {
      path: '/api/remote-hosts/remove',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const ok = removeHostById(String(body.id === undefined ? '' : body.id))
          return jsonResponse(ok ? { ok: true } : { ok: false, error: 'not found' })
        })
      },
    },
    {
      path: '/api/remote-hosts/workspaces',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        const rows = []
        let chain = Promise.resolve()
        for (const host of state.hosts) {
          chain = chain.then(function () {
            return collectWorkspaces(host).then(function (snapshot) {
              rows.push({
                id: host.id,
                label: host.label,
                state: hostState(host),
                workspaces: snapshot.workspaces,
                orphans: snapshot.orphans,
                sessionCount: snapshot.sessionCount,
                storeAvailable: snapshot.storeAvailable,
                fetchedAt: Date.now(),
              })
            }, function (error) {
              rows.push({ id: host.id, label: host.label, state: hostState(host), workspaces: [], orphans: [], error: String(error && error.message ? error.message : error), fetchedAt: Date.now() })
            })
          })
        }
        return chain.then(function () { return jsonResponse({ remotes: rows }) })
      },
    },
    {
      path: '/api/remote-hosts/session/create',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const host = state.byId.get(String(body.id === undefined ? '' : body.id))
          if (host === undefined) return jsonResponse({ ok: false, error: 'unknown remote' }, 404)
          const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined
          return remoteRpc(host, 'session/create', { request: cwd === undefined ? {} : { cwd: cwd } }, 30000).then(function (result) {
            if (result === undefined || result.ok !== true || result.value === undefined || typeof result.value.sessionId !== 'string') {
              return jsonResponse({ ok: false, error: 'remote session create failed' }, 502)
            }
            return jsonResponse({
              ok: true,
              id: host.id,
              sessionId: result.value.sessionId,
              agentPreset: result.value.agentPreset === undefined ? null : result.value.agentPreset,
              url: '/remotes/' + encodeURIComponent(host.id) + '/',
            })
          })
        })
      },
    },
    {
      path: '/api/remote-hosts/session/prompt',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const host = state.byId.get(String(body.id === undefined ? '' : body.id))
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const text = typeof body.text === 'string' ? body.text : ''
          if (host === undefined) return jsonResponse({ ok: false, error: 'unknown remote' }, 404)
          if (sessionId === '' || text === '') return jsonResponse({ ok: false, error: 'sessionId and text required' }, 400)
          return remoteRpc(host, 'session/prompt', {
            request: {
              requestId: 'hub-' + randomUUID(),
              sessionId: sessionId,
              mode: typeof body.mode === 'string' ? body.mode : 'queue',
              content: [{ type: 'text', text: text }],
              clientTimeZone: typeof body.clientTimeZone === 'string' ? body.clientTimeZone : 'Asia/Shanghai',
            },
          }, 30000).then(function (result) {
            if (result === undefined || result.ok !== true) return jsonResponse({ ok: false, error: 'remote prompt failed' }, 502)
            return jsonResponse({ ok: true, accepted: !(result.value !== undefined && result.value.accepted === false) })
          })
        })
      },
    },
    {
      path: '/api/opencode/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        let chain = Promise.resolve([])
        chain = opencodeServers.reduce(function (previous, server) {
          return previous.then(function (rows) {
            return collectOpencode(server).then(function (value) {
              rows.push({ id: server.id, label: server.label, url: server.url, state: value.state, version: value.version, projects: value.projects, ungrouped: value.ungrouped })
              return rows
            })
          })
        }, chain)
        return chain.then(function (rows) { return jsonResponse({ servers: rows }) })
      },
    },
    {
      path: '/api/opencode/debug',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        let toolMethods = []
        try { toolMethods = toolsService === undefined ? [] : Object.keys(toolsService) } catch (error) { toolMethods = ['<error>'] }
        return Promise.resolve(jsonResponse({
          ok: true,
          dshTools: dshTools !== undefined,
          execPath: process.execPath,
          argv1: process.argv[1] === undefined ? null : process.argv[1],
          dshToolsAttempts: dshToolsAttempts,
          toolsService: toolsService !== undefined,
          toolMethods: toolMethods,
          protoMethods: toolsService === undefined ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(toolsService)),
          registeredTools: (function () {
            if (toolsService === undefined || typeof toolsService.schemas !== 'function') return null
            try { return Object.keys(toolsService.schemas()) } catch (error) { return ['<error: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) + '>'] }
          })(),
          providerStatus: { registered: opencodeProviderStatus.registered, errors: opencodeProviderStatus.errors },
          servers: opencodeServers.map(function (server) { return server.id }),
        }))
      },
    },
    {
      path: '/api/remote-sessions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const backend = url.searchParams.get('backend') === null || url.searchParams.get('backend') === '' ? undefined : url.searchParams.get('backend')
        const host = url.searchParams.get('host') === null || url.searchParams.get('host') === '' ? undefined : url.searchParams.get('host')
        const cwd = url.searchParams.get('cwd') === null || url.searchParams.get('cwd') === '' ? undefined : url.searchParams.get('cwd')
        const query = url.searchParams.get('query') === null || url.searchParams.get('query') === '' ? undefined : url.searchParams.get('query')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        return collectRemoteSessionRows(backend, host, cwd, query, limit).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, shown: result.shown, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode/sessions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null ? undefined : url.searchParams.get('server')
        const directory = url.searchParams.get('directory') === null ? undefined : url.searchParams.get('directory')
        const query = url.searchParams.get('query') === null ? undefined : url.searchParams.get('query')
        const limitRaw = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50
        return collectOpencodeSessionRows(server, directory, query, limit).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, shown: result.shown, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode/providers',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        return Promise.resolve(jsonResponse({
          ok: true,
          providers: opencodeServers.map(function (server) {
            return { name: 'opencode-' + server.id, server: server.id, directory: server.directory === undefined ? null : server.directory }
          }),
        }))
      },
    },
    {
      path: '/api/opencode/probe',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = opencodeServers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) }) || opencodeServers[0]
          if (server === undefined) return jsonResponse({ ok: false, error: 'no opencode server configured' }, 400)
          const task = typeof body.task === 'string' && body.task !== '' ? body.task : '只回答：probe ok'
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : (server.directory === undefined ? undefined : server.directory)
          const provider = makeOpencodeProvider(server)
          return provider.start({
            prompt: [{ type: 'text', text: task }],
            cwd: directory,
            signal: new AbortController().signal,
            label: 'dsh subagent probe',
          }).then(function (handle) {
            return handle.result.then(function (result) {
              return handle.dispose().then(function () {
                return jsonResponse({
                  ok: result.stopReason === 'completed',
                  id: handle.id,
                  result: {
                    output: result.output,
                    stopReason: result.stopReason,
                    diagnostic: result.diagnostic === undefined ? null : result.diagnostic,
                  },
                })
              })
            })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode/delegate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = opencodeServers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) }) || opencodeServers[0]
          if (server === undefined) return jsonResponse({ ok: false, error: 'no opencode server configured' }, 400)
          const task = typeof body.task === 'string' ? body.task : ''
          if (task === '') return jsonResponse({ ok: false, error: 'task required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          const session = typeof body.session === 'string' && body.session !== '' ? body.session : undefined
          return delegateOpencode(server, directory, task, session).then(function (outcome) {
            return jsonResponse({ ok: true, sessionId: outcome.sessionId, text: outcome.text })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode/session',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = opencodeServers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) })
          if (server === undefined) return jsonResponse({ ok: false, error: 'unknown opencode server' }, 400)
          const title = typeof body.title === 'string' && body.title !== '' ? body.title : 'session'
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return opencodeRequest(server, '/session', { method: 'POST', body: { title: title }, directory: directory }).then(function (result) {
            if (result === undefined || result.status !== 200 || result.value === undefined) {
              return jsonResponse({ ok: false, error: 'opencode create failed' })
            }
            server.snapshot = undefined
            return jsonResponse({ ok: true, session: summarizeOpencodeSession(result.value), url: server.url + '/', sessionUrl: server.url + '/session/' + result.value.id })
          })
        })
      },
    },
    {
      path: '/api/remote-hosts/probe',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const host = state.byId.get(String(body.id === undefined ? '' : body.id))
          if (host === undefined) return jsonResponse({ ok: false, error: 'not found' })
          return probeHost(host).then(function (result) { return jsonResponse({ ok: result.ok === true, result: result }) })
        })
      },
    },
  ]

  loadState()
  sweepTunnels()

  ctx.effect(function () {
    return ctx.on('webserver/index-inject', function (table) {
      table.push({ kind: 'html', placement: 'body', html: switcherMarkup(state.hosts, 'local', switcherOptions) })
    })
  }, 'remote-hub: entry link')

  ctx.effect(function () {
    const disposers = []
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handleHttp }))
    for (const route of adminRoutes) {
      const registered = ctx.connection.fetch.register(route)
      disposers.push(function () { try { registered() } catch {} })
    }
    let probeTimer
    if (probeIntervalMs > 0) {
      probeTimer = setInterval(function () {
        for (const host of state.hosts) {
          if (host.probing === true) continue
          host.probing = true
          healthCheck(host).then(function () { host.probing = false }, function () { host.probing = false })
        }
      }, probeIntervalMs)
      if (typeof probeTimer.unref === 'function') probeTimer.unref()
    }
    for (const host of state.hosts) {
      ensureUpgrade(host)
      if (host.ssh !== undefined) startTunnel(host)
    }
    return function () {
      if (probeTimer !== undefined) clearInterval(probeTimer)
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
      for (const dispose of state.upgrades.values()) {
        try { dispose() } catch {}
      }
      state.upgrades.clear()
      for (const host of state.hosts) stopTunnel(host)
    }
  }, 'remote-hub: routes')

  const toolsService = ctx.tools !== undefined ? ctx.tools : (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
  const toolServer = opencodeServers[0]
  if (dshTools !== undefined && toolsService !== undefined && typeof toolsService.register === 'function' && toolServer !== undefined) {
    ctx.effect(function () {
      const dispose = toolsService.register(dshTools.defineTool({
        name: 'opencode_delegate',
        description: 'Delegate a task to a remote OpenCode agent on another machine. Without a session id it creates a new remote session (in the given remote directory); with a session id it continues that earlier remote session, whose agent still remembers its own history. Sends the task, waits for the agent to finish and returns its final answer plus the session id. Use this when work should run in a remote environment (build, test, verify, or inspect a remote repository) instead of the current host. The remote agent has its own model, tools and filesystem; intermediate steps are not shown here.',
        parameters: {
          task: { type: 'string', description: 'Complete instructions for the remote agent. It cannot see this conversation, so make the task self-contained. When continuing an earlier remote session, the remote agent still remembers that session history.' },
          directory: { type: 'string', description: 'Absolute directory on the remote machine (for example /home/yhuan/workspace/gitlab/new_fw). Must exist there. Ignored when continuing an existing session.' },
          server: { type: 'string', description: 'OpenCode server id; omit to use the first configured one.' },
          session: { type: 'string', description: 'Remote OpenCode session id returned by a previous call. Pass it to continue that session instead of creating a new one.' },
        },
        output: {
          schema: { type: 'string' },
          render: function (_args, result) { return [{ type: 'text', text: result }] },
        },
        execute: function (args, exec) {
          const configured = args !== null && typeof args === 'object' && typeof args.server === 'string' ? opencodeServers.find(function (candidate) { return candidate.id === args.server }) : undefined
          const target = configured === undefined ? toolServer : configured
          const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
          const task = args !== null && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
          const session = args !== null && typeof args === 'object' && typeof args.session === 'string' && args.session !== '' ? args.session : undefined
          if (task === '') return Promise.resolve('opencode_delegate: task is required')
          return delegateOpencode(target, directory, task, session).then(function (outcome) {
            return 'remote opencode ' + target.id + ' session ' + outcome.sessionId + '\n' +
              '(pass session="' + outcome.sessionId + '" to continue this remote session)\n\n' + outcome.text
          }, function (error) {
            return 'opencode_delegate failed: ' + String(error && error.message ? error.message : error)
          })
        },
      }))
      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info('remote-hub: opencode_delegate tool registered')
      else console.log('remote-hub: opencode_delegate tool registered')
      return function () { try { dispose() } catch {} }
    }, 'remote-hub: opencode delegate tool')

    ctx.effect(function () {
      const dispose = toolsService.register(dshTools.defineTool({
        name: 'opencode_sessions',
        description: 'List sessions (conversations) on the configured remote OpenCode servers: server id, workspace directory, title, last update and session id. Read-only. Use it to discover a remote session id (for continuing with opencode_delegate session=...) or to see which remote workspaces have recent activity.',
        parameters: {
          server: { type: 'string', description: 'Only this OpenCode server id; omit to list every configured server.' },
          directory: { type: 'string', description: 'Only sessions whose absolute directory starts with this prefix.' },
          query: { type: 'string', description: 'Only sessions whose title contains this text.' },
          limit: { type: 'number', description: 'Maximum rows to return (default 50, cap 200).' },
        },
        output: {
          schema: { type: 'string' },
          render: function (_args, result) { return [{ type: 'text', text: result }] },
        },
        execute: function (args) {
          const server = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
          const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
          const query = args !== null && typeof args === 'object' && typeof args.query === 'string' && args.query !== '' ? args.query : undefined
          const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 50
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
          return collectOpencodeSessionRows(server, directory, query, limit).then(function (result) {
            return result.count + ' matching remote session(s), showing ' + result.shown + ':\n' + result.text
          }, function (error) {
            return 'opencode_sessions failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
          })
        },
      }))
      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info('remote-hub: opencode_sessions tool registered')
      return function () { try { dispose() } catch {} }
    }, 'remote-hub: opencode sessions tool')

    ctx.effect(function () {
      const dispose = toolsService.register(dshTools.defineTool({
        name: 'remote_sessions',
        description: 'List remote sessions across backends: dsh remote hosts (session id, title, cwd, updated time, running/blank flags) and configured OpenCode servers. Read-only. Use it to pick a session to inspect or continue; dsh sessions can be opened in the remote UI, OpenCode sessions can be continued with opencode_delegate session=...',
        parameters: {
          backend: { type: 'string', description: 'Filter by backend: "dsh" or "opencode"; omit for both.' },
          host: { type: 'string', description: 'Only this remote host id (dsh) or opencode server id (opencode).' },
          directory: { type: 'string', description: 'Only sessions whose working directory starts with this prefix.' },
          query: { type: 'string', description: 'Only sessions whose title contains this text.' },
          limit: { type: 'number', description: 'Maximum rows to return (default 50, cap 200).' },
        },
        output: {
          schema: { type: 'string' },
          render: function (_args, result) { return [{ type: 'text', text: result }] },
        },
        execute: function (args) {
          const backend = args !== null && typeof args === 'object' && (args.backend === 'dsh' || args.backend === 'opencode') ? args.backend : undefined
          const host = args !== null && typeof args === 'object' && typeof args.host === 'string' && args.host !== '' ? args.host : undefined
          const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
          const query = args !== null && typeof args === 'object' && typeof args.query === 'string' && args.query !== '' ? args.query : undefined
          const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 50
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
          return collectRemoteSessionRows(backend, host, directory, query, limit).then(function (result) {
            return result.count + ' remote session(s), showing ' + result.shown + ':\n' + result.text
          }, function (error) {
            return 'remote_sessions failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
          })
        },
      }))
      return function () { try { dispose() } catch {} }
    }, 'remote-hub: remote sessions tool')
  }

  if (typeof ctx.inject === 'function' && opencodeServers.length > 0) {
    ctx.inject(['subagents'], function (subCtx) {
      const subagents = subCtx.subagents !== undefined ? subCtx.subagents : (typeof subCtx.get === 'function' ? subCtx.get('subagents') : undefined)
      if (subagents === undefined || typeof subagents.registerProvider !== 'function') return
      for (const server of opencodeServers) {
        try {
          subagents.registerProvider(makeOpencodeProvider(server))
          opencodeProviderStatus.registered.push('opencode-' + server.id)
          if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info('remote-hub: registered subagent provider opencode-' + server.id)
        } catch (error) {
          opencodeProviderStatus.errors.push('opencode-' + server.id + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
          if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('remote-hub: cannot register opencode provider ' + server.id, error)
        }
      }
    })
  }

  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info('remote-hub: ' + String(state.hosts.length) + ' remote(s) at ' + PREFIX + ', store ' + storeFile)
  } else {
    console.log('remote-hub: ' + String(state.hosts.length) + ' remote(s) at ' + PREFIX + ', store ' + storeFile)
  }
}
