import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveValue } from '@braedonsaunders/appkit-viewspec'
import { stubModules } from '../../../testing/stub-modules'

const state = { canCreate: true, ordersEnabled: true, unexpected: false }
Object.assign(globalThis, { __purchasingViewTest: state })
stubModules({
  navigation: {
    source: 'export function redirect(path){throw new Error(`redirect:${path}`)}',
  },
  intl: 'export async function getLocale(){return "en"}export async function getTranslations(namespace){const t=(key)=>namespace==="reports"&&key==="statement.ratesBlockedTitle"?"Exchange rates are missing":namespace==="reports"&&key==="statement.ratesBlockedAction"?"Derive rates":key;t.has=()=>false;return t}',
  authz: false,
  features: false,
  extra: {
    '@/lib/money-server': 'export async function getMoneyFormatter(){return {moneyCompact:(value)=>String(value)}}',
    '../../../lib/format': 'export function trendWeekLabel(value){return String(value)}',
  },
})

// View-scoped doubles stay conditioned: they answer only the purchasing
// view's own imports, which no shared stub shape matches.
const { registerHooks: registerViewHooks } = await import('node:module')
registerViewHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../../lib/authz' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function getAuthz(){return {user:{orgId:"org-1",roles:[]}}}export function can(authz,permission){return permission==="ap.create"||permission==="purchase_orders.create"?globalThis.__purchasingViewTest.canCreate:true}export function assertCan(){throw new Error("unexpected refusal")}' }
    if (specifier === '../../../lib/consolidation' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export class MissingRatesError extends Error {}
      export async function reportSubsidiaryView(){if(globalThis.__purchasingViewTest.unexpected)throw new Error('database unavailable');throw new MissingRatesError('USD/CAD rates are not derived through 2026-09-24')}
      export async function reportSubsidiaryScope(){return {subsidiary:{ids:['sub-1'],includeNullSubsidiary:false},currency:'USD',label:'Main entity',consolidated:false,options:[],picker:[{id:'sub-1',label:'Main entity'}]}}
    `) }
    if (specifier === '../../../lib/cash/core' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolveAsOf(){return "2026-09-24"}' }
    if (specifier === '../../../lib/module-home/purchasing' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function purchasingHome(){return {apAllowed:true,ordersEnabled:globalThis.__purchasingViewTest.ordersEnabled,expensesEnabled:true,badges:{vendors:7,openPos:2,payments7d:3,unpostedExpenses:1},openPoValue:500,spend30d:900,apOverdue:50,apOutstanding:600,dueNext7:200,paid7dValue:100,topExposure:[],openPos:2,trend:[]}}' }
    if (specifier === '../../../lib/nav/resolve' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function resolveNav(){return [{id:"purchasing",items:[]}]}' }
    if (specifier === '../../../components/module-home/group-tabs' && context.parentURL?.endsWith('/web/app/(app)/purchasing/view.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function groupTabs(){return []}' }
    if (specifier === '@/lib/money-server') return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {moneyCompact:(value)=>String(value)}}' }
    if (specifier === '../../../lib/format') return { shortCircuit: true, url: 'data:text/javascript,export function trendWeekLabel(value){return String(value)}' }
    return next(specifier, context)
  },
})

const { loadPurchasing, purchasingSpec } = await import('./view')

test('purchasing vitals retain five readable metrics with optional features disabled', async () => {
  const base = await loadPurchasing({})
  for (const ordersEnabled of [false, true]) {
    for (const expensesEnabled of [false, true]) {
      const data = { ...base, ordersEnabled, posAllowed: ordersEnabled, expensesEnabled }
      const grid = purchasingSpec(data).body.find((block) => block.kind === 'grid')
      assert.ok(grid?.kind === 'grid')
      const vitals = grid.blocks[0]
      assert.ok(vitals?.kind === 'grid')
      assert.equal(vitals.blocks.filter((block) => !block.when || resolveValue(block.when, data)).length, 5,
        `Orders=${ordersEnabled}, Expenses=${expensesEnabled}`)
      const unreadable = { ...data, apAllowed: false, posAllowed: false, expensesEnabled: false }
      const protectedGrid = purchasingSpec(unreadable).body.find((block) => block.kind === 'grid')
      assert.ok(protectedGrid?.kind === 'grid')
      const protectedVitals = protectedGrid.blocks[0]
      assert.ok(protectedVitals?.kind === 'grid')
      assert.equal(protectedVitals.blocks.filter((block) => !block.when || resolveValue(block.when, unreadable)).length, 1,
        'without AP or Expenses access only the vendor count is readable')
    }
  }
})

function block(data: Awaited<ReturnType<typeof loadPurchasing>>, type: string) {
  const find = (value: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(value)) return value.map(find).find(Boolean)
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (record.kind === 'widget' && record.widget === type) return record
    for (const child of Object.values(record)) {
      const found = find(child)
      if (found) return found
    }
    return undefined
  }
  return find(purchasingSpec(data))
}

test('missing consolidated rates remain a visible remedy beside live purchasing figures', async () => {
  const data = await loadPurchasing({})
  assert.deepEqual(data.ratesBlocked, {
    code: 'rates-not-derived',
    title: 'Exchange rates are missing',
    description: 'USD/CAD rates are not derived through 2026-09-24',
    deriveLabel: 'Derive rates',
    deriveHref: '/close',
  })
  assert.deepEqual(data.subsidiaryPicker, [{ id: 'sub-1', label: 'Main entity' }])
  assert.equal(data.subsidiaryValue, 'sub-1')
  assert.equal(data.vendorsValue, '7', 'rates refusal keeps independently readable purchasing vitals')
  assert.equal(data.openPosValue, '500')
  const notice = block(data, 'empty-state')
  assert.ok(notice && notice.kind === 'widget')
  const noticeProps = notice.props as Record<string, unknown>
  assert.equal(noticeProps.title, data.ratesBlocked.title)
  assert.equal(noticeProps.description, data.ratesBlocked.description)
  assert.deepEqual(noticeProps.actionProps, { href: '/close', label: 'Derive rates' })
})

test('unexpected purchasing loader errors still reach the caller', async () => {
  state.unexpected = true
  try { await assert.rejects(loadPurchasing({}), /database unavailable/) }
  finally { state.unexpected = false }
})

test('empty commitments offer only the granted action supported by the tenant configuration', async () => {
  state.canCreate = true
  state.ordersEnabled = true
  const withOrders = await loadPurchasing({})
  const withOrdersAction = block(withOrders, 'commitments-section')
  assert.ok(withOrdersAction && withOrdersAction.kind === 'widget')
  assert.deepEqual((withOrdersAction.props as Record<string, unknown>).emptyAction, { href: '/purchase-orders?orderNew=1', label: 'home.hero.createOrder' })

  state.ordersEnabled = false
  const withoutOrders = await loadPurchasing({})
  const billAction = block(withoutOrders, 'commitments-section')
  assert.ok(billAction && billAction.kind === 'widget')
  assert.deepEqual((billAction.props as Record<string, unknown>).emptyAction, { href: '/ap/bills?doc=new&kind=vendor_bill', label: 'home.hero.createBill' })

  state.canCreate = false
  const readOnly = await loadPurchasing({})
  const readOnlyAction = block(readOnly, 'commitments-section')
  assert.ok(readOnlyAction && readOnlyAction.kind === 'widget')
  assert.equal((readOnlyAction.props as Record<string, unknown>).emptyAction, null, 'readers cannot be offered an action that their grant refuses')
})
