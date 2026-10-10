import assert from 'node:assert/strict'
import test from 'node:test'
import type { BalanceSheetData } from './view'

const { balanceSheetSpec } = await import('./view')

// enabling Multi-subsidiary crashed the balance sheet with React
// error 441 — the loader converts the typed rates refusal into a banner with
// a derive link instead of throwing it out of SSR. These tests pin the spec
// half of that contract: given blocked data, the page shows the banner and
// hides the paper. (The loader half needs a database and has no unit
// interface.)
function blockedData(): BalanceSheetData {
  return {
    ratesBlocked: {
      code: 'rates-not-derived',
      title: 'Rates have not been derived',
      description: 'No consolidated exchange rates for EUR for March 2026.',
      deriveLabel: 'Derive rates',
      deriveHref: '/close',
    },
    ratesReady: false,
  } as unknown as BalanceSheetData
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
  visit((spec as { body: unknown }).body)
  return found
}

test('a rates refusal renders as a derive banner gated on the block', () => {
  const blocks = blocksOf(balanceSheetSpec(blockedData()))
  const banner = blocks.find((block) => block.widget === 'empty-state')
  assert.ok(banner, 'the blocked statement must render an empty-state banner')
  assert.deepEqual(banner.when, { $: 'ratesBlocked' }, 'the banner shows exactly while the notice is set')
  const props = banner.props as Record<string, unknown>
  assert.equal(props.title, 'Rates have not been derived')
  assert.equal(props.description, 'No consolidated exchange rates for EUR for March 2026.')
  assert.equal(props.action, 'link-button')
  const actionProps = props.actionProps as Record<string, unknown>
  assert.equal(actionProps.href, '/close', 'the banner must link to period close to derive rates')
  assert.equal(actionProps.label, 'Derive rates')
})

test('the paper hides while rates are blocked', () => {
  const blocks = blocksOf(balanceSheetSpec(blockedData()))
  const paper = blocks.find((block) => block.kind === 'paper')
  assert.ok(paper, 'the statement paper must still be in the spec')
  assert.deepEqual(
    paper.when,
    { $: 'ratesReady' },
    'the paper shows only when rates are ready — no numbers beside the banner',
  )
})

// A balance sheet reads "as of" its window end. Unfiltered, the filter bar
// must show the same fiscal-year-to-date window the loader resolves, so the
// statement is dated today rather than at a fiscal year end still ahead.
test('the unfiltered balance sheet defaults to an as-of of today', async () => {
  const { AS_OF_DEFAULT_PERIOD_PRESET, AS_OF_STATEMENT_KINDS } = await import('@openbooks/reports')
  assert.equal(AS_OF_DEFAULT_PERIOD_PRESET, 'this_fiscal_year_to_date')
  assert.ok(AS_OF_STATEMENT_KINDS.includes('balance-sheet'))
  assert.ok(AS_OF_STATEMENT_KINDS.includes('trial-balance'))
  assert.ok(!AS_OF_STATEMENT_KINDS.includes('pnl'), 'a period statement keeps the full fiscal year')
  const spec = balanceSheetSpec(blockedData()) as unknown as { header: Record<string, unknown>[] }
  const bar = spec.header.find((block) => block.kind === 'filter-bar')
  assert.ok(bar, 'the balance sheet renders the shared filter bar')
  assert.equal(bar.defaultPeriod, AS_OF_DEFAULT_PERIOD_PRESET)
})
