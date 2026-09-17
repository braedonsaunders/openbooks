import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./[id]/RunWizard.tsx', import.meta.url), 'utf8')

test('payroll GL preview keeps exact money strings out of floating-point arithmetic', () => {
  assert.match(source, /import \{ decimalAbs, decimalCmp, decimalNeg, decimalPercentChange, decimalSum \} from/)
  assert.match(source, /total: decimalSum\(amounts\)/)
  assert.match(source, /const creditTotal = decimalNeg\(decimalSum\(credits\.map\(\(leg\) => leg\.amount\)\)\)/)
  assert.doesNotMatch(source, /Number\(leg\.amount\)/)
  assert.doesNotMatch(source, /Math\.abs\(Number\(/)
  assert.doesNotMatch(source, /Number\(entry\.amount\)/)
})
