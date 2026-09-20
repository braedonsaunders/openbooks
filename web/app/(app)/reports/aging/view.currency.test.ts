import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { WIDGET_NAMES } from '../../../../components/viewspec/registry-names'

// P1 (fleet 8): the aging screen gains an Intacct-style reporting-currency
// selector plus a convert-from basis toggle. The loader must parse both
// through the shared screen/export resolver, map an underived-spot refusal
// to the rates banner, label the surface with basis + as-of, and always show
// the document's own currency and txn-currency open on detail rows.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('the loader parses currency through the shared screen/export resolver', () => {
  assert.match(
    source,
    /resolveAgingCurrencyParams\(sp, scope\)/,
    'screen and export must agree on what a URL means — one resolver, not two parsers',
  )
})

test('an underived spot becomes the rates banner, never an SSR throw', () => {
  assert.match(
    source,
    /instanceof AgingRatesUnavailableError/,
    'the loader must recognize the typed spot refusal',
  )
  assert.match(
    source,
    /if \(\!\(e instanceof AgingRatesUnavailableError\)\) throw e/,
    'only the spot refusal converts — every other error still throws',
  )
})

test('the surface labels basis and as-of in the UI, not in a comment', () => {
  assert.match(
    source,
    /fromTransaction.*fromBase|fromBase.*fromTransaction/s,
    'the period phrase must name which leg converted',
  )
  assert.match(source, /inCurrency/, 'the period phrase must name the reporting currency')
})

test('detail rows always show the document currency and txn open', () => {
  assert.match(
    source,
    /labelDocCurrency.*labelTxnOpen|txnOpen/,
    'detail rows carry doc currency and unconverted txn open whatever basis is selected',
  )
  assert.match(
    source,
    /widget\('currency-basis'/,
    'the selector control must be on the page',
  )
  assert.match(
    source,
    /widget\('currency-basis', \{[\s\S]*?\}, f\('ratesReady'\)\)/,
    'the selector hides with the paper when rates block the report',
  )
})

test('drill-downs reproduce the screen selection, not the defaults', () => {
  assert.match(source, /currencyBasis,/, 'bucket drill targets carry the basis')
  assert.match(source, /currency: target/, 'bucket drill targets carry the reporting currency')
})

test('the selector renders through the registry, not a direct import', () => {
  // The page reaches the control only as widget('currency-basis', …) in the
  // spec, resolved via WIDGET_REGISTRY at render. A direct import anywhere
  // outside the registry would make the registry entry a lie.
  assert.ok(WIDGET_NAMES.has('currency-basis'), 'currency-basis must be a renderable registry name')
  assert.match(
    readFileSync(new URL('../../../../components/viewspec/widgets-controls.tsx', import.meta.url), 'utf8'),
    /'currency-basis': \(props\)/,
    'the registry must own the currency-basis entry',
  )
  assert.doesNotMatch(
    source,
    /import .*currency-basis/,
    'the aging view must not import the control directly — the spec names it by string key',
  )
})
