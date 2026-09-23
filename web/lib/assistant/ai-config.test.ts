import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { CONTINUOUS_CLOSE_DISABLED_REMEDY } = await import('./ai-config.ts')

/**
 * The pack-enable refusal is user-facing copy: both legacy admin APIs
 * return it with a 409, so the message itself must name the switch and the
 * path that clears it — a bare code here would read as a system error.
 */
test('the pack-enable refusal names the switch and its remedy', () => {
  assert.match(CONTINUOUS_CLOSE_DISABLED_REMEDY, /Continuous Close/)
  assert.match(CONTINUOUS_CLOSE_DISABLED_REMEDY, /Company Settings → Features/)
  assert.match(CONTINUOUS_CLOSE_DISABLED_REMEDY, /enable agent packs/)
})
