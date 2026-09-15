import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./VendorView.tsx', import.meta.url), 'utf8')

test('vendor CSV exports retain spend and average bill decimals', () => {
  assert.match(source, /rows\.map\(\(r\) => \[r\.name, r\.spend, .*r\.avgBill, /)
  assert.doesNotMatch(source, /Math\.round\(r\.(?:spend|avgBill)\)/)
})
