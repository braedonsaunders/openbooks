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

// Regression suite for the onboarding wizard's pay-schedule create (D6):
// the generic setup API refuses a POST without a UUID Idempotency-Key, and
// a fresh key per click would mint a duplicate schedule when the operator
// retries an ambiguous failure.

const wizard = source

test('the pay-schedule create sends an Idempotency-Key', () => {
  const post = wizard.indexOf("fetch('/api/admin/setup/pay-schedules'")
  assert.notEqual(post, -1, 'wizard must still create the schedule through the generic setup API')
  const call = wizard.slice(post, post + 600)
  assert.match(call, /'Idempotency-Key': scheduleRequestId\.current/)
})

test('the key is stable per attempt, minted once and kept across retries', () => {
  // The generic SetupDrawer's pattern: a ref minted lazily, never a fresh
  // crypto.randomUUID() inline in the fetch headers (which would replay as a
  // second create on retry).
  assert.match(
    wizard,
    /if \(!scheduleRequestId\.current\) scheduleRequestId\.current = crypto\.randomUUID\(\)/,
  )
  const posts = wizard.indexOf("fetch('/api/admin/setup/pay-schedules'")
  const headers = wizard.slice(posts, posts + 600)
  assert.doesNotMatch(headers, /crypto\.randomUUID\(\)/, 'the POST must reuse the ref, not mint inline')
})

test('every wizard POST to a key-requiring setup endpoint carries the header', () => {
  for (const match of wizard.matchAll(/fetch\('(\/api\/admin\/setup\/[^']*)'/g)) {
    const call = wizard.slice(match.index, match.index! + 600)
    assert.match(call, /Idempotency-Key/, `${match[1]} must send Idempotency-Key`)
  }
})
