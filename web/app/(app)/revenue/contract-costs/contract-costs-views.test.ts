import assert from 'node:assert/strict'
import test from 'node:test'

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
    '@openbooks/engine/platform/database': `export const db = { execute: async () => ({ rows: [] }) }`,
    '../../../../lib/setup/ref-options':
      `export async function loadAccounts(){return []}`,
    '@openbooks/engine/revenue':
      `export async function contractCostAttentionItems(){return [{assetId:'a1',kind:'unlinked',contractNumber:null,carryingMinor:'10000',capitalizedOn:'2026-01-01'}]}` +
      `export async function assetCarryingMinor(){return 0n}` +
      `export function minorUnitsToCanonical(minor){return String(minor)}` +
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
