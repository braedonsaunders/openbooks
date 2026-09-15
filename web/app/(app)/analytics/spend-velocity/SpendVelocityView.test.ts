import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./SpendVelocityView.tsx', import.meta.url), 'utf8')

test('spend velocity CSV exports retain account amount decimals', () => {
  assert.match(source, /rows\.map\(\(a\) => \[a\.accountName, a\.currentAmount, a\.priorAmount, a\.twoBackAmount, /)
  assert.match(source, /a\.projectedAmount, a\.velocity/)
  assert.doesNotMatch(source, /Math\.round\(a\.(?:currentAmount|priorAmount|twoBackAmount|projectedAmount)\)/)
})
