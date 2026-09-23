import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t06-027: enabling Multi-subsidiary crashed the purchasing workspace with
// React error 441 — the same MissingRatesError out of SSR as the statements.
// The loader must convert the typed rates refusal into a banner with a derive
// link and never throw it. Since F-t03-009 the grid below the banner renders
// live vitals (lenient scope), not fail-closed zeros.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('a rates refusal becomes a typed banner, never an SSR throw (F-t06-027)', () => {
  assert.match(
    source,
    /instanceof MissingRatesError/,
    'the loader must recognize the typed rates refusal',
  )
  assert.match(
    source,
    /if \(\!\(e instanceof MissingRatesError\)\) throw e/,
    'only the rates refusal converts — every other error still throws',
  )
  assert.match(
    source,
    /code: 'rates-not-derived'/,
    'the blocked notice must carry its stable code',
  )
  assert.match(
    source,
    /deriveHref: '\/close'/,
    'the blocked notice must link to period close to derive rates',
  )
})

// F-t03-009: a dormant foreign subsidiary with no derived consolidated rates
// zeroed the whole workspace (SIM Meridian: 0 vendors / $0 spend / $0
// payables beside 'All clear' with 7 vendors and ~$125K of open posted
// bills). The loader recovers like the banking overview — same visibility
// and picker through the lenient scope, banner pinned beside LIVE figures.
test('a rates refusal recovers through the lenient scope with live figures (F-t03-009)', () => {
  assert.match(
    source,
    /reportSubsidiaryScope/,
    'the loader must fall back to the lenient scope on a rates refusal',
  )
  assert.match(
    source,
    /subsidiary: scoped\.subsidiary/,
    'the fallback must carry the resolved scope (figures keep loading)',
  )
  assert.doesNotMatch(
    source,
    /BLOCKED_HOME/,
    'no fail-closed zeros path: every computable figure renders beside the banner',
  )
})

test('the rates banner pins above live vitals with a derive link (F-t06-027)', () => {
  assert.match(
    source,
    /widgetBlock\('empty-state'/,
    'the spec must render a banner state for the blocked workspace',
  )
  assert.match(
    source,
    /action: 'link-button'/,
    'the banner must offer the derive link as an action',
  )
  assert.match(
    source,
    /}, f\('ratesBlocked'\)\)/,
    'the banner shows exactly when the notice is set',
  )
})

// UX-20: the empty commitments hero names its prerequisite in copy and
// offers the create action only where the caller holds ap.create — a reader
// without it keeps the honest zero with no misleading button.
test('the empty commitments hero carries its granted create action (UX-20)', () => {
  assert.match(
    source,
    /heroEmptyAction: !can\(authz, 'ap\.create'\)/,
    'the empty action must be gated on the AP creation grant',
  )
  assert.match(
    source,
    /\?orderNew=1', label: t\('home\.hero\.createOrder'\)/,
    'order-enabled tenants link straight into a new purchase order',
  )
  assert.match(
    source,
    /doc=new&kind=vendor_bill', label: t\('home\.hero\.createBill'\)/,
    'tenants without orders link into a new vendor bill instead',
  )
  assert.match(
    source,
    /emptyAction: data\.heroEmptyAction/,
    'the spec must carry the action to the commitments section',
  )
})
