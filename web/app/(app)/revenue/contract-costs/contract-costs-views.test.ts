import assert from 'node:assert/strict'
import test from 'node:test'

const state = { org: [{ base_currency: 'USD' }] }
Object.assign(globalThis, { __costViewsState: state })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({
  intl: true,
  authz: {
    source:
      `export async function getAuthz(){return { user: { orgId: 'org-1' }, permissions: new Set(['*']) }}` +
      `export function can(){return true}` +
      `export async function requirePermission(){return getAuthz()}`,
  },
  features: true,
  extra: {
    'server-only': `export {}`,
    '@openbooks/engine/platform/database':
      `export const db = { execute: async (q) => {` +
      `const s = JSON.stringify(q);` +
      `if (s.includes('journal_lines')) return { rows: [{ carrying: '0' }] };` +
      `if (s.includes('contract_cost_amortization')) return { rows: [] };` +
      `if (s.includes('from currencies')) return { rows: [{ minor_units: 2 }] };` +
      `if (s.includes('from orgs')) return { rows: globalThis.__costViewsState.org };` +
      `if (s.includes('count(*)')) return { rows: [{ n: '0' }] };` +
      `return { rows: [] } } }`,
    '../../../../lib/setup/ref-options':
      `export async function loadAccounts(){return []}`,
    '@openbooks/engine/revenue':
      `export class ContractCostError extends Error {` +
      `constructor(message, options){ super(message); this.code = options?.code ?? 'contract_cost_invalid';` +
      `this.remedy = options?.remedy ?? '' } }` +
      `export async function contractCostAttentionItems(){return [{assetId:'a1',kind:'unlinked',contractNumber:null,carryingMinor:'10000',capitalizedOn:'2026-01-01'}]}` +
      `export async function assetCarryingMinor(){return 0n}` +
      `export function minorUnitsToCanonical(minor){return String(minor)}` +
      `export async function currencyExponent(){return 2}` +
      `export async function scheduleForAsset(){return []}`,
  },
})

const { loadContractCosts } = await import('./view')

/**
 * Attention and assets are sibling URL views: exactly one body renders,
 * attention leads while actionable, and an explicit view always wins.
 */
test('contract-costs attention leads while actionable with its tab active', async () => {
  const data = await loadContractCosts({})
  assert.equal(data.activeView, 'attention')
  assert.equal(data.onAttention, true)
  assert.equal(data.onAssets, false)
  assert.equal(data.tabs.length, 2)
  assert.equal(data.tabs[0]?.href, '/revenue/contract-costs?view=attention')
  assert.equal(data.tabs[0]?.active, true)
  assert.equal(data.tabs[0]?.count, 1)
  assert.equal(data.tabs[1]?.href, '/revenue/contract-costs?view=assets')
  assert.equal(data.tabs[1]?.active, false)
})

test('contract-costs sibling tabs preserve workspace filters', async () => {
  const period = '22222222-2222-2222-2222-222222222222'
  const data = await loadContractCosts({ view: 'assets', period })
  const attention = data.tabs[0]?.href ?? ''
  assert.ok(attention.includes('view=attention'), 'the sibling tab keeps its view key')
  assert.ok(attention.includes(`period=${period}`), 'the sibling tab keeps the period filter')
})

/**
 * An organization the account cannot see is an access refusal, never an
 * invitation to configure: without a visible org row the page refuses by
 * name with the account/access remedy.
 */
test('contract-costs refuses by name when the org is unavailable', async () => {
  state.org = []
  try {
    await assert.rejects(
      () => loadContractCosts({}),
      (error: unknown) => {
        const named = error as { code?: string; remedy?: string; message?: string }
        assert.equal(named.code, 'contract_cost_org_unavailable')
        assert.match(named.message ?? '', /not available/)
        assert.match(named.remedy ?? '', /administrator for access/)
        return true
      },
    )
  } finally {
    state.org = [{ base_currency: 'USD' }]
  }
})

test('contract-costs honors an explicit assets view and falls back on unknown views', async () => {
  const assets = await loadContractCosts({ view: 'assets' })
  assert.equal(assets.activeView, 'assets')
  assert.equal(assets.onAttention, false)
  assert.equal(assets.onAssets, true)
  assert.equal(assets.tabs[1]?.active, true)

  const fallback = await loadContractCosts({ view: 'bogus' })
  assert.equal(fallback.activeView, 'attention')
  assert.equal(fallback.onAttention, true)
})
