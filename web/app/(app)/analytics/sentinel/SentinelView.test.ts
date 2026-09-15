import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./SentinelView.tsx', import.meta.url), 'utf8')

test('sentinel CSV exports retain flagged document amount decimals', () => {
  assert.match(source, /data\.flagged\.map\(\(f\) => \[f\.date, f\.docNumber, f\.kind, f\.partyName, f\.amount, /)
  assert.doesNotMatch(source, /Math\.round\(f\.amount\)/)
})
