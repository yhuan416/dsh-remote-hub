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
import { execFile, spawn } from 'node:child_process'

export const name = 'remote-hub'
export const inject = ['webServer', 'connection']

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
  tunnel.disposed = true
  if (tunnel.timer !== undefined) clearTimeout(tunnel.timer)
  const child = tunnel.child
  if (child !== undefined) {
    try { child.kill('SIGTERM') } catch {}
    setTimeout(function () { try { child.kill('SIGKILL') } catch {} }, 3000)
  }
  tunnel.state = 'off'
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
    '#dsh-hub-pane iframe{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base,#fff)}'
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
    'if(it.id!=="local"){var d=el("span","display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#8a8a8a;vertical-align:middle");dots[it.id]=d;b.appendChild(d);}' +
    'b.appendChild(document.createTextNode(it.label));' +
    'b.onclick=function(){if(it.id==="local"){showLocal();}else{showRemote(it.id);}};bar.appendChild(b);});' +
    'bar.appendChild(el("span","flex:1"));' +
    'var mg=el("a",null,"管理");mg.href="/remotes/";bar.appendChild(mg);' +
    'document.body.appendChild(bar);' +
    'pane=el("div");pane.id="dsh-hub-pane";document.body.appendChild(pane);' +
    'sync();poll();setInterval(poll,5000);}' +
    'function statusColor(s){return s==="online"?"#37b24d":s==="pending"?"#f59e0b":s==="offline"?"#e03131":"#8a8a8a";}' +
    'function applyStatus(rows){rows.forEach(function(r){var d=dots[r.id];if(!d)return;d.style.background=statusColor(r.state);' +
    'var b=d.parentElement;if(!b)return;' +
    'var parts=[r.state||"unknown"];if(r.tunnel&&r.tunnel.state)parts.push("tunnel "+r.tunnel.state);if(r.lastError)parts.push(r.lastError);' +
    'b.title=parts.join(" | ");});}' +
    'function poll(){fetch("/api/remote-hosts/list",{headers:{accept:"application/json"}}).then(function(r){return r.json();})' +
    '.then(function(d){if(d&&d.remotes)applyStatus(d.remotes);}).catch(function(){});}' +
    'function sync(){if(!bar)return;Array.prototype.forEach.call(bar.querySelectorAll("button[data-id]"),function(b){' +
    'if(b.getAttribute("data-id")===activeId){b.setAttribute("data-active","1");}else{b.removeAttribute("data-active");}});}' +
    'function showRemote(id){' +
    'if(framed){post(id);return;}' +
    'if(onRemotes){location.href="/remotes/"+id+"/";return;}' +
    'build();' +
    'if(!frames[id]){var f=el("iframe");f.src="/remotes/"+id+"/";pane.appendChild(f);frames[id]=f;}' +
    'Object.keys(frames).forEach(function(k){frames[k].style.display=(k===id)?"block":"none";});' +
    'pane.style.display="block";activeId=id;sync();}' +
    'function showLocal(){' +
    'if(framed){post("local");return;}' +
    'if(onRemotes){location.href="/";return;}' +
    'build();pane.style.display="none";activeId="local";sync();}' +
    'window.addEventListener("message",function(ev){if(ev.origin!==location.origin)return;var d=ev.data;if(!d||d.type!=="dsh-hub-open")return;' +
    'if(d.id&&d.id!=="local"){showRemote(d.id);}else{showLocal();}});' +
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
    'var m=el("a","display:block;padding:6px 10px;border-radius:6px;text-decoration:none;color:var(--dsw-alias-label-secondary,inherit);' +
    'border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));margin-top:4px","管理远端…");m.href="/remotes/";p.appendChild(m);' +
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
    'if(!framed&&DATA.dropdown){' +
    'var tries=0;if(!insertDropdown()){var t=setInterval(function(){if(insertDropdown()||++tries>80){clearInterval(t);if(!mounted())floating();}},250);}' +
    'new MutationObserver(function(){if(!mounted())insertDropdown();}).observe(document.body,{childList:true,subtree:true});}' +
    '})();<\/script>'
  return '<div id="dsh-hub-switch-data" hidden data-json="' + payload + '"></div>' + script
}

export function launcherPage(hosts) {
  const payload = hosts.map(function (host) {
    return { id: host.id, label: host.label }
  })
  const json = JSON.stringify(payload).split('<').join('')
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>DSH remotes</title><style>' +
    'html,body{margin:0;height:100%;font:13px/1.45 system-ui,sans-serif;background:#151517;color:#ddd}' +
    'body{display:flex;flex-direction:column}' +
    '#tabs{display:flex;gap:6px;padding:6px 8px;background:#1e1e21;border-bottom:1px solid #333;align-items:center;flex-wrap:wrap}' +
    '#tabs .sp{flex:1}' +
    'button{background:#2a2a2f;color:#ddd;border:1px solid #3a3a40;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit}' +
    'button.on{background:#3b5bdb;border-color:#3b5bdb;color:#fff}' +
    'button.sm{padding:2px 8px;font-size:12px}' +
    'button.danger{border-color:#7a2b2b;color:#f0a0a0}' +
    '#panes{flex:1;position:relative;min-height:0}' +
    '.pane{position:absolute;inset:0;width:100%;height:100%;border:0;display:none;background:#fff}' +
    '#empty{padding:24px;color:#888}' +
    '.muted{color:#888;font-size:12px}' +
    '#admin{position:absolute;inset:0;background:#111113ee;display:none;flex-direction:column;z-index:9;padding:16px;box-sizing:border-box;overflow:auto}' +
    '#admin.on{display:flex}' +
    '#admin h2{margin:0 0 12px;font-size:15px}' +
    'table{border-collapse:collapse;width:100%;margin-bottom:16px}' +
    'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2c2c31;font-size:12.5px;vertical-align:middle}' +
    'th{color:#888;font-weight:normal}' +
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#666}' +
    '.dot.up{background:#37b24d}.dot.down{background:#e03131}.dot.auth{background:#f59f00}' +
    '.form{display:grid;grid-template-columns:120px 1fr;gap:8px 10px;max-width:640px;align-items:center}' +
    '.form input,.form select{background:#1e1e21;border:1px solid #3a3a40;color:#ddd;border-radius:5px;padding:5px 8px;font:inherit}' +
    '.row{display:flex;gap:8px;margin-top:12px}' +
    '#msg{min-height:18px;color:#9ab}' +
    '</style></head><body>' +
    '<nav id="tabs"><a href="/" title="返回本机" style="color:#ddd;text-decoration:none;padding:4px 10px;border:1px solid #3a3a40;border-radius:6px;background:#2a2a2f">&#8592; 本机</a><span class="muted">remotes:</span><span class="sp"></span>' +
    '<button id="manage" class="sm">管理</button></nav>' +
    '<div id="panes"></div>' +
    '<div id="empty" style="display:none">还没有配置远端。点右上角「管理」添加。</div>' +
    '<div id="admin"><h2>远端管理</h2>' +
    '<table><thead><tr><th>状态</th><th>名称</th><th>传输</th><th>token</th><th>最近错误</th><th></th></tr></thead>' +
    '<tbody id="rows"></tbody></table>' +
    '<h2 id="formTitle">添加远端</h2>' +
    '<div class="form">' +
    '<label>显示名称</label><input id="f-label" placeholder="yhuan@192.168.4.50">' +
    '<label>传输方式</label><select id="f-mode"><option value="ssh">ssh 隧道（Hub 自动起 ssh -L）</option><option value="direct">直连 upstream（已有隧道/同机）</option></select>' +
    '<label>ssh 主机</label><input id="f-sshhost" placeholder="192.168.4.50">' +
    '<label>ssh 用户</label><input id="f-sshuser" placeholder="yhuan">' +
    '<label>ssh 端口</label><input id="f-sshport" placeholder="22">' +
    '<label>远端 dsh 端口</label><input id="f-remoteport" placeholder="3080">' +
    '<label>本机端口</label><input id="f-localport" placeholder="留空自动（32000+序号）">' +
    '<label>直连地址</label><input id="f-upstream" placeholder="http://127.0.0.1:3182">' +
    '<label>token 来源</label><select id="f-tokenmode"><option value="ssh">ssh 读取 agent 文件</option><option value="inline">内联 token</option><option value="none">无（需手动认证）</option></select>' +
    '<label>内联 token</label><input id="f-token" placeholder="43 字符">' +
    '</div>' +
    '<div class="row"><button id="save">保存</button><button id="reset" class="sm">清空表单</button><button id="close" class="sm">关闭</button></div>' +
    '<div id="msg"></div>' +
    '</div>' +
    '<script>(function(){' +
    'var initial=' + json + ';' +
    'var tabs=document.getElementById("tabs"),panes=document.getElementById("panes"),empty=document.getElementById("empty");' +
    'var admin=document.getElementById("admin"),rows=document.getElementById("rows"),msg=document.getElementById("msg");' +
    'var frames={},active=null;' +
    'function select(id){' +
    'if(!frames[id]){var f=document.createElement("iframe");f.className="pane";f.src="/remotes/"+id+"/";panes.appendChild(f);frames[id]=f;}' +
    'if(active&&frames[active])frames[active].style.display="none";' +
    'frames[id].style.display="block";active=id;' +
    'Array.prototype.forEach.call(tabs.querySelectorAll("button[data-id]"),function(b){b.className=b.getAttribute("data-id")===id?"on":"";});}' +
    'function renderTabs(list){' +
    'Array.prototype.forEach.call(tabs.querySelectorAll("button[data-id]"),function(b){b.remove();});' +
    'var manage=document.getElementById("manage");' +
    'list.forEach(function(r){var b=document.createElement("button");b.textContent=r.label;b.setAttribute("data-id",r.id);b.onclick=function(){select(r.id);};tabs.insertBefore(b,manage.nextSibling);});' +
    'empty.style.display=list.length?"none":"block";}' +
    'function dot(r){var s=r.tunnel?r.tunnel.state:(r.upstream?"direct":"?");if(s==="up")return "dot up";if(r.tokenResolved===false&&r.tokenSource)return "dot auth";if(s==="down")return "dot down";return "dot";}' +
    'function renderRows(list){rows.innerHTML="";list.forEach(function(r){var tr=document.createElement("tr");' +
    'var c1=document.createElement("td");var dt=document.createElement("span");dt.className=dot(r);c1.appendChild(dt);c1.appendChild(document.createTextNode(" "+(r.tunnel?r.tunnel.state:"-")));tr.appendChild(c1);' +
    'var c2=document.createElement("td");c2.appendChild(document.createTextNode(r.label));var idDiv=document.createElement("div");idDiv.className="muted";idDiv.textContent=r.id;c2.appendChild(idDiv);tr.appendChild(c2);' +
    'var c3=document.createElement("td");c3.textContent=(r.transport==="ssh-tunnel")?("ssh "+r.ssh.host+" -> :"+r.remotePort):("direct "+(r.upstream||""));tr.appendChild(c3);' +
    'var c4=document.createElement("td");c4.textContent=r.tokenSource||"-";tr.appendChild(c4);' +
    'var c5=document.createElement("td");c5.className="muted";c5.textContent=r.lastError||"";tr.appendChild(c5);' +
    'var td=document.createElement("td");' +
    'var open=document.createElement("button");open.className="sm";open.textContent="打开";open.onclick=function(){select(r.id);admin.classList.remove("on");};' +
    'var probe=document.createElement("button");probe.className="sm";probe.textContent="测试";probe.onclick=function(){probeHost(r.id);};' +
    'var del=document.createElement("button");del.className="sm danger";del.textContent="删除";del.onclick=function(){removeHost(r.id);};' +
    'td.appendChild(open);td.appendChild(document.createTextNode(" "));td.appendChild(probe);td.appendChild(document.createTextNode(" "));td.appendChild(del);' +
    'tr.appendChild(td);rows.appendChild(tr);});}' +
    'function api(path,body){return fetch("/api/remote-hosts/"+path,body===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});}' +
    'function load(){return api("list").then(function(res){var list=res.remotes||[];renderTabs(list);renderRows(list);return list;}).catch(function(e){msg.textContent="加载失败: "+e.message;});}' +
    'function probeHost(id){msg.textContent="测试中...";api("probe",{id:id}).then(function(res){msg.textContent=JSON.stringify(res.result||res);load();});}' +
    'function removeHost(id){if(!confirm("删除远端 "+id+" ?"))return;api("remove",{id:id}).then(function(){if(frames[id]){frames[id].remove();delete frames[id];}load();});}' +
    'function readForm(){' +
    'return {label:document.getElementById("f-label").value.trim(),mode:document.getElementById("f-mode").value,' +
    'sshHost:document.getElementById("f-sshhost").value.trim(),sshUser:document.getElementById("f-sshuser").value.trim(),' +
    'sshPort:document.getElementById("f-sshport").value.trim(),remotePort:document.getElementById("f-remoteport").value.trim(),' +
    'localPort:document.getElementById("f-localport").value.trim(),upstream:document.getElementById("f-upstream").value.trim(),' +
    'tokenMode:document.getElementById("f-tokenmode").value,token:document.getElementById("f-token").value.trim()};}' +
    'document.getElementById("save").onclick=function(){var v=readForm();' +
    'var body={label:v.label,transport:v.mode,remotePort:v.remotePort?Number(v.remotePort):undefined,' +
    'localPort:v.localPort?Number(v.localPort):undefined,upstream:v.upstream||undefined,' +
    'ssh:v.mode==="ssh"?{host:v.sshHost,user:v.sshUser||undefined,port:v.sshPort?Number(v.sshPort):undefined}:undefined,' +
    'tokenMode:v.tokenMode,token:v.tokenMode==="inline"?(v.token||undefined):undefined};' +
    'msg.textContent="保存中...";api("save",body).then(function(res){if(res.ok){msg.textContent="已保存: "+res.id;load();}else{msg.textContent="失败: "+res.error;}});};' +
    'document.getElementById("reset").onclick=function(){["f-label","f-sshhost","f-sshuser","f-sshport","f-remoteport","f-localport","f-upstream","f-token"].forEach(function(id){document.getElementById(id).value="";});msg.textContent="";};' +
    'document.getElementById("manage").onclick=function(){admin.classList.add("on");load();};' +
    'document.getElementById("close").onclick=function(){admin.classList.remove("on");};' +
    'document.getElementById("f-mode").onchange=function(){var ssh=this.value==="ssh";document.getElementById("f-upstream").disabled=ssh;};' +
    'renderTabs(initial);if(initial.length){select(initial[0].id);}else{empty.style.display="block";}' +
    'setInterval(function(){if(document.visibilityState==="visible")load();},5000);' +
    '})();</script></body></html>'
}

export function apply(ctx, config) {
  const storeFile = path.join(dshHome(), 'remote-hosts.json')
  const switcherOptions = normalizeSwitcher(config === undefined ? undefined : config.switcher)
  const upstreamTimeoutMs = config !== undefined && typeof config.upstreamTimeoutMs === 'number' && config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : 30000
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
    if (tunnelState === 'up') return 'online'
    if (tunnelState === 'starting') return 'pending'
    if (tunnelState === 'down') return 'offline'
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
        lastError: host.lastError === undefined ? null : host.lastError,
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
      if (!res.headersSent) {
        const timedOut = error.message.indexOf('upstream timeout') !== -1
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
    for (const host of state.hosts) {
      ensureUpgrade(host)
      if (host.ssh !== undefined) startTunnel(host)
    }
    return function () {
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

  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info('remote-hub: ' + String(state.hosts.length) + ' remote(s) at ' + PREFIX + ', store ' + storeFile)
  } else {
    console.log('remote-hub: ' + String(state.hosts.length) + ' remote(s) at ' + PREFIX + ', store ' + storeFile)
  }
}
