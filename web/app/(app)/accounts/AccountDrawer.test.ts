import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-003: in single-currency orgs the drawer hid the settlement-currency
// field AND stripped it from the save payload (Multi-currency off), while the
// API 422s reconcilable-without-currency — the flag could never be set from
// the UI, and the failure mapped to generic save_failed at best.
const drawerSource = readFileSync(new URL('./AccountDrawer.tsx', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const uiDrawerSource = readFileSync(new URL('../../../../packages/ui/src/drawer.tsx', import.meta.url), 'utf8')
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

// F-t06-002: closing the drawer left a stale account= param in the URL —
// UrlDrawer deferred the close navigation to onExitComplete, so the address
// bar lagged the dismissed state by the exit animation (and a synchronous
// read always saw the stale param). The drawer opts into instant URL sync;
// the loader's closeHref already strips account=/accountNew=/drawerReturn=.
test('closing the drawer syncs the URL instantly instead of after the exit animation', () => {
  assert.match(
    drawerSource,
    /syncUrlOnClose/,
    'the account drawer must opt into instant close-URL sync so the address bar matches the dismissed state',
  )
  assert.match(
    viewSource,
    /account: undefined/,
    'the loader closeHref must strip the account selector so closing cannot reopen on reload',
  )
  assert.match(
    uiDrawerSource,
    /syncUrlOnClose/,
    'UrlDrawer must implement the instant-sync opt-in',
  )
  assert.match(
    uiDrawerSource,
    /history\.replaceState/,
    'instant sync must rewrite the address bar at close time, ahead of the deferred router navigation',
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
