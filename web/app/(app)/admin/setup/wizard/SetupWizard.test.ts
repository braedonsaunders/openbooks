import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { initialPayrollPack } from './payroll-pack-display'

const source = readFileSync(new URL('./SetupWizard.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can default.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

// The wizard offers whatever packs the server declares and installs whatever
// the operator chose: a closed CA-or-nothing union with a defaulted Canada
// closes the world for every tenant that is not Canadian.
test('setup wizard names no payroll pack in code', () => {
  assert.doesNotMatch(code, /['"]CA['"]/)
  assert.doesNotMatch(code, /['"]US['"]/)
  assert.doesNotMatch(code, /packs\.canada\b/)
  assert.doesNotMatch(code, /packs\.us\b/)
  assert.doesNotMatch(code, /payrollPackCanada\b/)
})

// The review step shows the pack's served name, not its code: it is handed
// the installable packs list for the lookup, so a new pack reads correctly
// with no edit here.
test('review step renders the served pack name', () => {
  assert.match(code, /payrollPacks=\{installablePacks\}/)
  assert.match(code, /packTitle\(t, payrollPack, payrollPackName\)/)
})

// Preselect only what is derived: a sole installable pack, else nothing.
test('wizard preselects no pack unless exactly one is installable', () => {
  const pack = (country: string) => ({ country, name: `${country} name` })
  assert.equal(initialPayrollPack([]), null)
  assert.equal(initialPayrollPack([pack('CA'), pack('US')]), null)
  assert.equal(initialPayrollPack([pack('XX'), pack('YY'), pack('ZZ')]), null)
  assert.equal(initialPayrollPack([pack('CA')]), 'CA')
  assert.equal(initialPayrollPack([pack('XX')]), 'XX')
})
