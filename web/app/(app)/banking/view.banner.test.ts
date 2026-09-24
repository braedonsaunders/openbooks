import assert from 'node:assert/strict'
import test from 'node:test'
import type { BankingData } from './view'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export default {}' }
    return next(specifier, context)
  },
})

const { bankingSpec } = await import('./view')

function blockedData(): BankingData {
  return {
    title: 'Banking',
    description: 'Company banking workspace',
    ratesBlocked: {
      code: 'rates-not-derived',
      title: 'Rates have not been derived',
      description: 'No consolidated exchange rates for EUR for March 2026.',
      deriveLabel: 'Derive rates',
      deriveHref: '/close',
    },
    layoutPrefs: {},
    subsidiaryPicker: null,
    subsidiaryValue: '',
    subsidiaryLabel: 'Subsidiary',
    tabs: [],
    canReconcile: true,
    matchHref: '/banking/match', matchVariant: 'outline', matchCountLabel: '', matchLabel: 'Match', showMatchCount: false,
    cashLabel: 'Cash', cashValue: '$0.00', cashSub: '0 accounts', cashTone: 'neutral',
    unmatchedTone: 'positive', cardsLabel: 'Cards', cardsValue: '$0.00', cardsSub: '0 accounts',
    unmatchedLabel: 'Unmatched', unmatchedValue: '0', unmatchedSub: 'All matched', unmatchedAccent: 'emerald',
    openReconsLabel: 'Open reconciliations', openReconsValue: '0', openReconsSub: 'None open',
    netFlowLabel: 'Net flow', netFlowValue: '$0.00', netFlowAccent: 'emerald', netFlowTone: 'positive',
    rosterTitle: 'Accounts', rosterAccounts: [], totalCash: 0, totalCards: 0,
    trendTitle: 'Cash trend', trendHint: '', trendSeriesName: 'Cash', trendLabels: [], trendData: [],
    directoryTitle: 'Directory', directory: [], attentionTitle: 'Attention', attentionAllClear: 'All clear', attention: [],
  } as unknown as BankingData
}

test('a rates refusal renders its derive remedy before the banking workspace', () => {
  const spec = bankingSpec(blockedData())
  const body = spec.body as unknown as Record<string, unknown>[]
  const banner = body[0]
  assert.ok(banner, 'the rates refusal must appear at the top of the page')
  assert.equal(banner.widget, 'empty-state')
  assert.deepEqual(banner.when, { $: 'ratesBlocked' })
  const props = banner.props as Record<string, unknown>
  assert.equal(props.title, 'Rates have not been derived')
  assert.equal(props.description, 'No consolidated exchange rates for EUR for March 2026.')
  assert.equal(props.action, 'link-button')
  assert.deepEqual(props.actionProps, { href: '/close', label: 'Derive rates' })

  const workspace = body[1]
  assert.ok(workspace, 'the banking workspace follows the banner')
  assert.equal(workspace.kind, 'grid', 'the workspace remains composed below the refusal banner')
  const tiles = (workspace.blocks as Record<string, unknown>[])[0]
  assert.ok(tiles, 'the first workspace section is the vitals strip')
  assert.equal(tiles.kind, 'grid', 'the fallback workspace shows empty vitals, not a fabricated rate amount')
})
