#!/usr/bin/env node
/** Offline package checks: exports, markup/script parsing, manifest basics. No network, no dsh runtime. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as entry from '../lib/index.js'
import { promptText, startRemoteSubagent, createRemoteProvider, parseStructured } from '../lib/remote-subagent.js'

assert.equal(entry.name, 'remote-hub')
assert.deepEqual(entry.inject, ['webServer', 'connection', 'tools'])
assert.equal(typeof entry.apply, 'function')
assert.notEqual(entry.Config, undefined)

const hosts = [
  { id: 'n100', label: 'n100' },
  { id: 'm65', label: 'm65' },
]
const markup = entry.switcherMarkup(hosts, 'n100', { mode: 'bar', dropdown: false })
assert.ok(markup.includes('id="dsh-hub-switch-data"'))
assert.ok(markup.includes('dsh-hub-bar'))
assert.ok(markup.includes('n100') && markup.includes('m65'))

const script = markup.match(/<script>([\s\S]*)<\/script>/)
assert.ok(script !== null, 'switcher script exists')
new Function(script[1])

const entryPage = entry.launcherPage(hosts)
assert.ok(entryPage.includes('/remotes/n100/'))
assert.ok(entryPage.includes('/remotes/m65/'))

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.type, 'module')
assert.equal(pkg.exports['.'], './lib/index.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(typeof pkg.engines.dsh === 'string' && pkg.engines.dsh.length > 0, 'engines.dsh declared')
assert.ok(pkg.files.includes('cordis.patch.yml'))
assert.ok(pkg.files.includes('ARCHITECTURE.md'))

assert.equal(promptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')

const calls = []
let listCalls = 0
const fakeRpc = async function (host, method) {
  calls.push(method)
  if (method === 'session/create') return { ok: true, value: { sessionId: 'session-check' } }
  if (method === 'session/prompt') return { ok: true, value: { accepted: true } }
  if (method === 'session/list') {
    listCalls += 1
    if (listCalls === 1) return { ok: true, value: { items: [{ sessionId: 'session-check', running: true, projections: { values: { turnOutline: [] } } }] } }
    return { ok: true, value: { items: [{ sessionId: 'session-check', running: false, projections: { kind: 'sequenced', asOfSeq: 21, values: { turnOutline: [{ turn: 1, response: 'answer-ok' }] } } }] } }
  }
  if (method === 'session/page') return { ok: true, value: { records: [{ type: 'event', event: { type: 'assistant/message', seq: 19, time: 1, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'full-answer-' + 'x'.repeat(200) }] } } } }], hasMore: false } }
  if (method === 'session/cancel') return { ok: true, value: { accepted: true } }
  return { ok: false, error: { message: 'unexpected ' + method } }
}
const handle = await startRemoteSubagent({ id: 'n100' }, fakeRpc, { task: 'hi', pollIntervalMs: 10, timeoutMs: 5000 })
assert.equal(handle.id, 'session-check')
const remoteResult = await handle.result
assert.equal(remoteResult.stopReason, 'completed')
assert.equal(remoteResult.output.length, 1)
assert.ok(remoteResult.output[0].text.startsWith('full-answer-'), 'reads the full transcript, not the 120-char outline')
assert.ok(remoteResult.output[0].text.length > 200)
await handle.dispose()
const provider = createRemoteProvider({ id: 'n100' }, fakeRpc)
assert.equal(provider.name, 'remote-dsh-n100')
assert.equal(provider.capabilities.outputSchema, true)
assert.equal(provider.capabilities.agentOptions, true)
assert.equal(provider.capabilities.agentPreset, true)

assert.deepEqual(parseStructured('```json\n{"answer":"42"}\n```', { type: 'object', required: ['answer'] }), { answer: '42' })
assert.equal(parseStructured('not json', { type: 'object' }), undefined)

const structuredCalls = []
let structuredListCalls = 0
const structuredRpc = async function (host, method) {
  structuredCalls.push(method)
  if (method === 'session/create') return { ok: true, value: { sessionId: 'session-structured' } }
  if (method === 'session/rename') return { ok: true, value: { title: 'x', seq: 1 } }
  if (method === 'session/selectModel') return { ok: true, value: { selected: { provider: 'p', model: 'm' } } }
  if (method === 'session/prompt') return { ok: true, value: { accepted: true } }
  if (method === 'session/list') {
    structuredListCalls += 1
    if (structuredListCalls === 1) return { ok: true, value: { items: [{ sessionId: 'session-structured', running: true, projections: { values: { turnOutline: [] } } }] } }
    return { ok: true, value: { items: [{ sessionId: 'session-structured', running: false, projections: { kind: 'sequenced', asOfSeq: 5, values: { turnOutline: [{ turn: 1, response: '{"answer":"42"}' }] } } }] } }
  }
  if (method === 'session/page') return { ok: true, value: { records: [{ type: 'event', event: { type: 'assistant/message', seq: 4, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '{"answer":"42"}' }] } } } }], hasMore: false } }
  if (method === 'session/cancel') return { ok: true, value: { accepted: true } }
  return { ok: false, error: { message: 'unexpected ' + method } }
}
const structuredProvider = createRemoteProvider({ id: 'n100' }, structuredRpc)
const structuredRun = await structuredProvider.start({
  cwd: '/tmp',
  prompt: [{ type: 'text', text: 'give json' }],
  outputSchema: { type: 'object', required: ['answer'] },
  agentPreset: 'standard',
  agentOptions: { provider: 'p', model: 'm' },
  label: 'demo',
  signal: new AbortController().signal,
})
const structuredResult = await structuredRun.result
assert.equal(structuredResult.stopReason, 'completed')
assert.deepEqual(structuredResult.structured, { answer: '42' })
assert.ok(structuredCalls.includes('session/rename'), 'provider renames the remote session with the label')
assert.ok(structuredCalls.includes('session/selectModel'), 'provider applies model overrides')

// workspace selection: the create branch forwards workspaceId, and it is exclusive with cwd
const workspaceCreates = []
const workspaceRpc = async function (host, method, args) {
  if (method === 'session/create') {
    workspaceCreates.push(args)
    return { ok: true, value: { sessionId: 'session-workspace' } }
  }
  if (method === 'session/prompt') return { ok: true, value: { accepted: true } }
  if (method === 'session/list') return { ok: true, value: { items: [{ sessionId: 'session-workspace', running: false, projections: { kind: 'sequenced', asOfSeq: 3, values: { turnOutline: [{ turn: 1, response: 'workspace-ok' }] } } }] } }
  if (method === 'session/page') return { ok: true, value: { records: [] } }
  if (method === 'session/cancel') return { ok: true, value: { accepted: true } }
  return { ok: false, error: { message: 'unexpected ' + method } }
}
const workspaceHandle = await startRemoteSubagent({ id: 'n100' }, workspaceRpc, {
  task: 'hi',
  workspaceId: '984a7b95-4d3e-4c8d-906d-c22f0671a8bf',
  pollIntervalMs: 10,
  timeoutMs: 5000,
})
assert.equal((await workspaceHandle.result).stopReason, 'completed')
assert.deepEqual(workspaceCreates[0].request, { workspaceId: '984a7b95-4d3e-4c8d-906d-c22f0671a8bf' }, 'workspaceId is forwarded to session/create')
await workspaceHandle.dispose()
await assert.rejects(
  startRemoteSubagent({ id: 'n100' }, workspaceRpc, { task: 'hi', workspaceId: 'x', cwd: '/tmp', pollIntervalMs: 10, timeoutMs: 5000 }),
  /not both/,
  'workspaceId and cwd are mutually exclusive',
)

// workspace path resolution against the workspace store
const workspaceStore = JSON.stringify({
  tables: {
    workspaces: {
      'ws-a': { path: '/home/u/a/', title: 'a' },
      'ws-b': { path: '/home/u/b', title: 'b' },
    },
  },
})
const readWorkspaceStore = async function () { return workspaceStore }
assert.equal(await entry.resolveRemoteWorkspace({ id: 'n100', dshHome: '/home/u/.dsh' }, '/home/u/a', readWorkspaceStore), 'ws-a', 'workspace path resolves to its id (trailing slash tolerated)')
assert.equal(await entry.resolveRemoteWorkspace({ id: 'n100' }, '11111111-1111-1111-1111-111111111111', readWorkspaceStore), '11111111-1111-1111-1111-111111111111', 'workspace id passes through')
assert.equal(await entry.resolveRemoteWorkspace({ id: 'n100' }, '', readWorkspaceStore), undefined)
await assert.rejects(entry.resolveRemoteWorkspace({ id: 'n100' }, '/nope', readWorkspaceStore), /workspace path not found on n100: \/nope; known: \/home\/u\/a, \/home\/u\/b/)
await assert.rejects(entry.resolveRemoteWorkspace({ id: 'n100' }, 'relative/path', readWorkspaceStore), /absolute path/)

// session timestamps are local time with an explicit UTC offset, not bare UTC
const formatted = entry.formatSessionTime(Date.UTC(2026, 0, 2, 3, 4, 0))
assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/, 'formatSessionTime renders local time + offset')
assert.equal(entry.formatSessionTime(undefined), '')
assert.equal(entry.formatSessionTime(null), '')
assert.equal(entry.formatSessionTime('nope'), '')
await assert.rejects(entry.resolveRemoteWorkspace({ id: 'n100' }, '/home/u/a', async function () { return undefined }), /workspace store is unreadable/)
await assert.rejects(entry.resolveRemoteWorkspace({ id: 'n100' }, '/home/u/a', async function () { return 'not json' }), /not valid JSON/)

console.log('check ok')