#!/usr/bin/env node
/** Offline package checks: exports, markup/script parsing, manifest basics. No network, no dsh runtime. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as entry from '../lib/index.js'

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

console.log('check ok')
