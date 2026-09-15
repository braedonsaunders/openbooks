import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./CustomerView.tsx', import.meta.url), 'utf8')

test('customer health CSV exports retain revenue and CLV decimals', () => {
  assert.match(source, /rows\.map\(\(r\) => \[r\.name, r\.healthScore, r\.healthGrade, r\.revenue, r\.clv, /)
  assert.doesNotMatch(source, /Math\.round\(r\.(?:revenue|clv)\)/)
})
