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

// Preselect only what is derived: a sole installable pack, else nothing.
test('wizard preselects no pack unless exactly one is installable', () => {
  assert.equal(initialPayrollPack([]), null)
  assert.equal(initialPayrollPack(['CA', 'US']), null)
  assert.equal(initialPayrollPack(['XX', 'YY', 'ZZ']), null)
  assert.equal(initialPayrollPack(['CA']), 'CA')
  assert.equal(initialPayrollPack(['XX']), 'XX')
})
