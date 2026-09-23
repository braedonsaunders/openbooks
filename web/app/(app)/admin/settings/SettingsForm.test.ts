import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./SettingsForm.tsx', import.meta.url), 'utf8')

// F-t01-010: clearing Display name and saving gave zero feedback — Save
// stays enabled, the input carries no invalid state, and the empty value is
// silently rejected server-side. A transient toast alone is not enough: the
// field itself must carry the required error (the parties-display-name
// precedent, F-t02-009), pinned where the tester can still read it.
// CTRL-01: the vendor-bill release policy lives on Company Settings as an
// explicit opt-in (default off), with a warning while no approval flow is
// configured for vendor bills — the submit-time refusal names Flows/Setup as
// the remedy, so both surfaces must exist and stay linked here.
test('the approvals card exposes the vendor-bill requirement and the no-flow warning', () => {
  assert.match(
    source,
    /requireVendorBillApproval/,
    'the form must carry the vendor-bill approval requirement field',
  )
  assert.match(
    source,
    /type="checkbox"/,
    'the requirement must be an explicit opt-in control, never a hidden default',
  )
  assert.match(
    source,
    /approvals\.noFlowWarning/,
    'the card must warn while no vendor-bill approval flow is configured',
  )
  assert.match(
    source,
    /href="\/admin\/flows"/,
    'the warning must link the Flows setup surface the refusal names',
  )
})

// IN11: the stock-count independent-review policy lives on the same
// Approvals card as an explicit opt-in (default off). While off, the
// counts review panel warns that the same user may post; while on, a
// contributor's self-post is refused by name — both surfaces must exist
// here.
test('the approvals card exposes the stock-count independent-review requirement', () => {
  assert.match(
    source,
    /requireStockCountReview/,
    'the form must carry the stock-count review requirement field',
  )
  assert.match(
    source,
    /approvals\.requireStockCountReviewHint/,
    'the requirement must explain both the on and the off behaviour',
  )
})

// TZ1: the org business time zone is settable on Company Settings — the
// ~155 businessToday/businessTimeZone call sites ran on UTC around local
// midnight because no surface wrote orgs.settings->>'timeZone'.
test('the organization card exposes the business time zone picker', () => {
  assert.match(
    source,
    /organization\.timeZone\b/,
    'the form must carry the business time zone field',
  )
  assert.match(
    source,
    /timeZones\.map|timeZoneOptions/,
    'the picker must offer the canonical zone list, not a hardcoded few',
  )
  assert.match(
    source,
    /organization\.timeZoneHint/,
    'the field must explain what the zone dates',
  )
})

test('a blank display name pins an inline required error on the field', () => {
  assert.match(
    source,
    /aria-invalid/,
    'the name input must expose its invalid state to assistive tech and styling',
  )
  assert.match(
    source,
    /role="alert"/,
    'the required error must render as a persistent alert, not only a toast',
  )
  assert.match(
    source,
    /validation\.nameRequired/,
    'the inline error must reuse the localized required copy',
  )
  assert.match(
    source,
    /setShowNameError\(true\)|setNameError\(true\)/,
    'a save attempt with a blank name must raise the field error state',
  )
})
