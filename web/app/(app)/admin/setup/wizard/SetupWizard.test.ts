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

// TZ1: the company step offers the business time zone (server-declared
// canonical list, never hardcoded here), sends it on apply, and shows it
// on the review step — the org's business zone is settable during setup.
test('setup wizard company step carries the business time zone', () => {
  assert.match(code, /setup-time-zone/, 'the company step must render a time-zone picker')
  assert.match(code, /company\.timeZone/, 'the picker label must resolve through copy')
  assert.match(code, /timeZones\.map/, 'the options must come from the server-declared list')
  assert.match(code, /^\s*timeZone,$/m, 'apply must send the chosen zone to the wizard route')
  assert.match(code, /review\.timeZone/, 'the review step must show the chosen zone')
})

test('setup wizard names no time zone in code', () => {
  assert.doesNotMatch(code, /America\/Toronto/, 'zones travel as server data, never literals')
  assert.doesNotMatch(code, /supportedValuesOf/, 'enumeration belongs to the shared platform validator')
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
