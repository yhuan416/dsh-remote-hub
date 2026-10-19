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
for (const marker of ['/remotes/demo/', '/remotes/_status', '回到本机']) {
  if (!page.includes(marker)) throw new Error('launcher page is missing ' + marker)
}
const pageBytes = page.includes('<script>') ? parseInline(page, 'launcher page') : page.length

const switcher = switcherMarkup([{ id: 'demo', label: 'demo' }], 'local', undefined)
for (const marker of ['dsh-hub-switch-data', 'dsh-hub-bar', 'dsh-hub-pane', 'padding-top:34px', 'postMessage', '--dsw-alias-bg-base', 'dropdown']) {
  if (!switcher.includes(marker)) throw new Error('switcher is missing ' + marker)
}
if (!switcher.includes('if(!framed){')) throw new Error('switcher must not build the bar inside an iframe')
const switcherBytes = parseInline(switcher, 'switcher')

console.log('launcher ok (' + String(pageBytes) + ' bytes), switcher ok (' + String(switcherBytes) + ' bytes)')
