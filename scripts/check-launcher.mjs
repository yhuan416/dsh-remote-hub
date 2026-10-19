#!/usr/bin/env node
/**
 * Regression guard for the two inline scripts this plugin emits: the launcher
 * page script and the injected backend switcher. Both are assembled by string
 * concatenation, where a broken escape produces a blank page with no visible
 * error, so parse them here instead.
 */
import { launcherPage, switcherMarkup } from '../lib/index.js'

function parseInline(html, label) {
  const open = html.indexOf('<script>')
  if (open < 0) throw new Error(label + ' has no inline script')
  const close = html.indexOf('</script>', open)
  if (close < 0) throw new Error(label + ' has an unterminated script')
  const source = html.slice(open + '<script>'.length, close)
  try {
    new Function(source)
  } catch (error) {
    throw new Error(label + ' inline script does not parse: ' + error.message)
  }
  return source.length
}

const page = launcherPage([{ id: 'demo', label: 'demo' }])
for (const marker of ['id="rows"', 'id="save"', 'id="manage"', 'api("list")']) {
  if (!page.includes(marker)) throw new Error('launcher page is missing ' + marker)
}
const pageBytes = parseInline(page, 'launcher page')

const switcher = switcherMarkup([{ id: 'demo', label: 'demo' }], 'local', undefined)
if (!switcher.includes('dsh-hub-switch-data')) throw new Error('switcher payload holder is missing')
if (!switcher.includes('_newSession')) throw new Error('switcher does not target the sidebar anchor')
const switcherBytes = parseInline(switcher, 'switcher')

console.log('launcher ok (' + String(pageBytes) + ' bytes), switcher ok (' + String(switcherBytes) + ' bytes)')
