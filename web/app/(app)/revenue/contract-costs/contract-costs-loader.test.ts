import assert from 'node:assert/strict'
import test from 'node:test'

const state = {
  loadAccountsOrg: null as string | null,
  accounts: [
    { value: 'a-expense', label: '5000 · Commissions', accountType: 'expense' },
    { value: 'a-expense-other', label: '5010 · Commissions, other', accountType: 'expense_other' },
    { value: 'a-payable', label: '2000 · Trade payables', accountType: 'liability_payable' },
    { value: 'a-bank', label: '1000 · Operating bank', accountType: 'asset_bank' },
    { value: 'a-income', label: '4000 · Sales', accountType: 'income' },
  ],
}
Object.assign(globalThis, { __contractCostsLoaderState: state })
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
      `if (s.includes('from orgs')) return { rows: [{ base_currency: 'USD' }] };` +
      `if (s.includes('count(*)')) return { rows: [{ n: '0' }] };` +
      `return { rows: [] } } }`,
    '../../../../lib/setup/ref-options':
      `export async function loadAccounts(orgId){` +
      `globalThis.__contractCostsLoaderState.loadAccountsOrg = orgId;` +
      `return globalThis.__contractCostsLoaderState.accounts}`,
    '@openbooks/engine/revenue':
      `export class ContractCostError extends Error {` +
      `constructor(message, options){ super(message); this.code = options?.code ?? 'contract_cost_invalid';` +
      `this.remedy = options?.remedy ?? '' } }` +
      `export async function contractCostAttentionItems(){return []}` +
      `export async function assetCarryingMinor(){return 0n}` +
      `export function minorUnitsToCanonical(minor){return String(minor)}` +
      `export async function currencyExponent(){return 2}` +
      `export async function scheduleForAsset(){return []}`,
  },
})

const { loadContractCosts } = await import('./view')

test('contract-costs pickers reuse the shared postable-account loader, narrowed to expense and liability types', async () => {
  const data = await loadContractCosts({})
  assert.equal(state.loadAccountsOrg, 'org-1')
  assert.deepEqual(data.expenseAccounts, [
    { value: 'a-expense', label: '5000 · Commissions' },
    { value: 'a-expense-other', label: '5010 · Commissions, other' },
    { value: 'a-payable', label: '2000 · Trade payables' },
  ])
})
