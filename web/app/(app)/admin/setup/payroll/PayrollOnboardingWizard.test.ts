import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Regression suite for the onboarding wizard's pay-schedule create (D6):
// the generic setup API refuses a POST without a UUID Idempotency-Key, and
// a fresh key per click would mint a duplicate schedule when the operator
// retries an ambiguous failure.

const wizard = readFileSync(new URL('./PayrollOnboardingWizard.tsx', import.meta.url), 'utf8')

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
