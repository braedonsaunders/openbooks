import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PayrollOnboardingWizard.tsx', import.meta.url), 'utf8')
// Comments explain history; only code can default.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

// The onboarding wizard offers whatever packs the settings API declares: a
// CA/US-only i18n map with a bare-code fallback renders every other pack as
// "GB"/"DE"/"FR" for both the title AND the description. Country names come
// from the pack declarations via the API payload, never from a map here.
test('onboarding wizard names no payroll pack in code', () => {
  assert.doesNotMatch(code, /PACK_I18N/)
  assert.doesNotMatch(code, /['"]CA['"]/)
  assert.doesNotMatch(code, /['"]US['"]/)
  assert.doesNotMatch(code, /packs\.canada\b/)
  assert.doesNotMatch(code, /packs\.us\b/)
})
