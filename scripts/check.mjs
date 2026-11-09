#!/usr/bin/env node
/** Offline package checks: exports, markup/script parsing, manifest basics. No network, no dsh runtime. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as entry from '../lib/index.js'
import { promptText, startRemoteSubagent, createRemoteProvider } from '../lib/remote-subagent.js'

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
assert.equal(provider.capabilities.outputSchema, false)

console.log('check ok')