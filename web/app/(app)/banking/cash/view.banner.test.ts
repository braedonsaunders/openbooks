import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t06-027: enabling Multi-subsidiary crashed the cash cockpit with React
// error 441 — the same MissingRatesError out of SSR as the statements.
// The loader must convert the typed rates refusal into a banner with a derive
// link and never throw it; the FX-bearing cockpit hides while blocked.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('a rates refusal becomes a typed banner, never an SSR throw (F-t06-027)', () => {
  assert.match(
    source,
    /instanceof MissingRatesError/,
    'the loader must recognize the typed rates refusal',
  )
  assert.match(
    source,
    /if \(\!\(error instanceof MissingRatesError\)\) throw error/,
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

test('the blocked page shows the banner and hides the cockpit (F-t06-027)', () => {
  assert.match(
    source,
    /widgetBlock\('empty-state'/,
    'the spec must render a banner state for the blocked cockpit',
  )
  assert.match(
    source,
    /action: 'link-button'/,
    'the banner must offer the derive link as an action',
  )
  assert.match(
    source,
    /when: f\('ratesBlocked'\)/,
    'the banner shows exactly when the notice is set',
  )
  assert.match(
    source,
    /when: f\('ratesReady'\)/,
    'the cockpit hides exactly when the notice is set — no forecast beside the banner',
  )
})

// UX-20: zero bank accounts is a setup prerequisite, not a silent zero — the
// accounts panel names it and links the Banking overview that changes it.
test('the empty accounts panel links the Banking setup route (UX-20)', () => {
  const cockpit = readFileSync(new URL('./CashCockpit.tsx', import.meta.url), 'utf8')
  assert.match(
    cockpit,
    /\{t\('noAccounts'\)\}/,
    'the empty panel must name the missing accounts',
  )
  assert.match(
    cockpit,
    /href="\/banking"[\s\S]*?\{t\('noAccountsAction'\)\}/,
    'the empty panel must link the Banking overview that changes the zero',
  )
})
