import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./OpeningBalancesView.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can default.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

// Unknown or empty country must never fall through to Canada: a null-country
// row is an orphan whose profile is gone (its pack is unknown, not Canadian),
// and an empty grid has nobody to carry anything in for. The engine refuses
// the silent-Canada fallthrough (engine/src/payroll/packs.ts); the grid does.
test('opening-balances grid names no default country in code', () => {
  assert.doesNotMatch(code, /['"]CA['"]/)
  assert.doesNotMatch(code, /['"]US['"]/)
  assert.doesNotMatch(code, /\?\?\s*['"][A-Z]/)
})
