import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t06-025: enabling Multi-subsidiary crashed the balance sheet with React
// error 441 — the same MissingRatesError out of SSR as TB/P&L. The loader
// must convert the typed rates refusal into a banner with a derive link and
// never throw it.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('a rates refusal becomes a typed banner, never an SSR throw (F-t06-025)', () => {
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

test('the blocked page shows the banner and hides the paper (F-t06-025)', () => {
  assert.match(
    source,
    /widgetBlock\('empty-state'/,
    'the spec must render a banner state for the blocked statement',
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
    'the paper hides exactly when the notice is set — no numbers beside the banner',
  )
})
