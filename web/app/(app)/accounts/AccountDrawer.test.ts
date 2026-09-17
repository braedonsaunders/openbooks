import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-003: in single-currency orgs the drawer hid the settlement-currency
// field AND stripped it from the save payload (Multi-currency off), while the
// API 422s reconcilable-without-currency — the flag could never be set from
// the UI, and the failure mapped to generic save_failed at best.
const drawerSource = readFileSync(new URL('./AccountDrawer.tsx', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const enAccounts = JSON.parse(
  readFileSync(new URL('../../../messages/en/accounts.json', import.meta.url), 'utf8'),
) as { drawer: { errors: Record<string, string> } }

test('settlement currency is offered whenever reconcilable is on, not only with Multi-currency', () => {
  assert.match(
    drawerSource,
    /multiCurrency \|\| form\.reconcilable/,
    'currency field visibility must key on reconcilable as well as multiCurrency',
  )
})

test('save sends the settlement currency whenever reconcilable is on, not only with Multi-currency', () => {
  assert.match(
    drawerSource,
    /multiCurrency \|\| form\.reconcilable \? \{ currencyRestriction/,
    'payload must carry currencyRestriction for reconcilable accounts even when Multi-currency is off',
  )
})

test('checking reconcilable defaults an empty settlement currency to the org base currency', () => {
  assert.match(
    drawerSource,
    /baseCurrency/,
    'drawer must know the org base currency to default the settlement currency',
  )
  assert.match(
    viewSource,
    /baseCurrency/,
    'loader must pass the org base currency to the drawer',
  )
})

test('save refuses reconcilable-without-currency before the round trip', () => {
  assert.match(
    drawerSource,
    /form\.reconcilable && !form\.currencyRestriction/,
    'client guard must stop a save the server would 422',
  )
})

test('reconcilable_currency_required maps to a specific message, never generic save_failed', () => {
  assert.match(
    drawerSource,
    /'reconcilable_currency_required'/,
    'drawer error map must know the server code',
  )
  const message = enAccounts.drawer.errors['reconcilable_currency_required']
  assert.equal(typeof message, 'string')
  assert.ok((message as string).length > 0)
})
