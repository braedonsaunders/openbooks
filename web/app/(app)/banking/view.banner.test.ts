import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t06-027: enabling Multi-subsidiary crashed the banking workspace with
// React error 441 — the same MissingRatesError out of SSR as the statements.
// The loader must convert the typed rates refusal into a banner with a derive
// link and never throw it; the workspace grid renders empty vitals below it.
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

test('the blocked workspace shows the banner above empty vitals (F-t06-027)', () => {
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
