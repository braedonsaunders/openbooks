import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = { genericFailure: false, customerHomeCalls: 0 }
Object.assign(globalThis, { __customerRatesBannerTest: state })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next/navigation') return { shortCircuit: true, url: 'data:text/javascript,export function redirect(path){throw new Error(`redirect:${path}`)}' }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(`
          export async function getLocale(){return 'en'}
          export async function getTranslations(namespace){
            const t=(key)=>namespace==='reports'&&key==='statement.ratesBlockedTitle'?'Exchange rates are missing'
              :namespace==='reports'&&key==='statement.ratesBlockedAction'?'Derive rates':key;
            t.has=()=>false; return t;
          }
        `),
      }
    }
    if (specifier === '../../../lib/authz' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function getAuthz(){return {user:{orgId:"org-1",roles:[]}}}export function can(){return true}export function assertCan(){throw new Error("unexpected refusal")}' }
    }
    if (specifier === '../../../lib/consolidation' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(`
          export class MissingRatesError extends Error {}
          export async function reportSubsidiaryView(){
            if(globalThis.__customerRatesBannerTest.genericFailure) throw new Error('database unavailable')
            throw new MissingRatesError('USD/CAD rates are not derived through 2026-09-24')
          }
        `),
      }
    }
    if (specifier === '../../../lib/cash/core' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function resolveAsOf(){return "2026-09-24"}' }
    }
    if (specifier === '../../../lib/module-home/customers' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function customersHome(){globalThis.__customerRatesBannerTest.customerHomeCalls++;throw new Error("blocked figures must not load")}' }
    }
    if (specifier === '../../../lib/nav/resolve' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function resolveNav(){return []}' }
    }
    if (specifier === '../../../components/module-home/group-tabs' && context.parentURL?.endsWith('/web/app/(app)/customers/view.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function customerGroupTabs(){return []}' }
    }
    if (specifier === '@/lib/money-server') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {moneyCompact:(value)=>String(value)}}' }
    }
    return next(specifier, context)
  },
})

const { loadCustomers, customersSpec } = await import('./view')

test('missing consolidated rates become a banner while figures fail closed', async () => {
  state.genericFailure = false
  state.customerHomeCalls = 0
  const data = await loadCustomers({})
  assert.deepEqual(data.ratesBlocked, {
    code: 'rates-not-derived',
    title: 'Exchange rates are missing',
    description: 'USD/CAD rates are not derived through 2026-09-24',
    deriveLabel: 'Derive rates',
    deriveHref: '/close',
  })
  assert.equal(data.activeCustomersValue, '0')
  assert.equal(data.arOutstanding, '0')
  assert.equal(state.customerHomeCalls, 0, 'blocked consolidation must not load unscoped figures')

  const notice = customersSpec(data).body.find((block) => block.kind === 'widget' && block.widget === 'empty-state')
  assert.ok(notice && notice.kind === 'widget')
  assert.equal(notice.props?.title, 'Exchange rates are missing')
  assert.equal(notice.props?.description, data.ratesBlocked.description)
  assert.deepEqual(notice.props?.actionProps, { href: '/close', label: 'Derive rates' })
})

test('unexpected customer loader errors still reach the caller', async () => {
  state.genericFailure = true
  await assert.rejects(loadCustomers({}), /database unavailable/)
})
