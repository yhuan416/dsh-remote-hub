#!/usr/bin/env node
/**
 * Regression guard: the launcher page embeds a large inline script assembled by
 * string concatenation. A broken escape produces a blank page with no console
 * error the tests can see, so parse it here instead.
 */
import { launcherPage } from '../lib/index.js'

const html = launcherPage([{ id: 'demo', label: 'demo' }])
const open = html.indexOf('<script>')
const close = html.indexOf('</script>', open)
if (open < 0 || close < 0) {
  console.error('launcher page has no inline script')
  process.exit(1)
}
const source = html.slice(open + '<script>'.length, close)
try {
  new Function(source)
} catch (error) {
  console.error('launcher inline script does not parse:', error.message)
  process.exit(1)
}
for (const marker of ['id="rows"', 'id="save"', 'id="manage"', 'api("list")']) {
  if (!html.includes(marker)) {
    console.error('launcher page is missing', marker)
    process.exit(1)
  }
}
console.log('launcher page ok (' + String(source.length) + ' bytes of script)')
