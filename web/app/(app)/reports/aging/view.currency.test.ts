import assert from 'node:assert/strict'
import test from 'node:test'
import { WIDGET_NAMES } from '../../../../components/viewspec/registry-names'
import type { AgingData } from './view'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    // Platform boundary, not our own module: lets the unit partition import
    // the pure spec builder without a Next server runtime.
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default {}',
      }
    }
    return next(specifier, context)
  },
})

const { agingSpec } = await import('./view')

// P1 (fleet 8): the aging screen gains an Intacct-style reporting-currency
// selector plus a convert-from basis toggle. These tests pin the spec half:
// the selector reaches the page as a registry widget carrying the screen
// selection, and it hides with the paper when rates block the report. (The
// loader half — parsing screen/export params, the spot refusal, basis and
// as-of labels, drill targets — needs a database and has no unit interface.)
function dataWithSelection(): AgingData {
  return {
    currencyOptions: [
      { value: 'USD', label: 'USD' },
      { value: 'EUR', label: 'EUR' },
    ],
    currencyValue: 'EUR',
    currencyBasisValue: 'transaction',
    labelCurrency: 'Currency',
    labelConvertFrom: 'Convert from',
    labelBase: 'Base',
    labelTransaction: 'Transaction',
    ratesBlocked: null,
    ratesReady: true,
  } as unknown as AgingData
}

function blocksOf(spec: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      found.push(node as Record<string, unknown>)
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit((spec as { header: unknown }).header)
  return found
}

test('the currency selector reaches the page as a registry widget carrying the screen selection', () => {
  const blocks = blocksOf(agingSpec(dataWithSelection()))
  const selector = blocks.find((block) => block.widget === 'currency-basis')
  assert.ok(selector, 'the selector must be on the page as a currency-basis widget')
  assert.ok(
    WIDGET_NAMES.has('currency-basis'),
    'currency-basis must be a renderable registry name — the spec names it by string key, never by direct import',
  )
  const props = selector.props as Record<string, unknown>
  assert.deepEqual(props.currencies, [
    { value: 'USD', label: 'USD' },
    { value: 'EUR', label: 'EUR' },
  ])
  assert.equal(props.currency, 'EUR', 'the selector must carry the reporting currency')
  assert.equal(props.currencyBasis, 'transaction', 'the selector must carry the convert-from basis')
})

test('the currency selector hides with the paper when rates block the report', () => {
  const blocked = { ...dataWithSelection(), ratesBlocked: { code: 'rates-not-derived' }, ratesReady: false }
  const blocks = blocksOf(agingSpec(blocked as unknown as AgingData))
  const selector = blocks.find((block) => block.widget === 'currency-basis')
  assert.ok(selector, 'the selector must still be in the spec')
  assert.deepEqual(
    selector.when,
    { $: 'ratesReady' },
    'the selector hides exactly when the notice is set — no converting beside the banner',
  )
})
