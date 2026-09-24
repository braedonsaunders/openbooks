import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../auth'

/**
 * Base-currency refusal contract (F1T-11).
 *
 * A missing base currency used to throw a raw English Error out of the
 * project profitability loader — which the app error boundary renders as
 * a generic failure with no name and no remedy — while the budget and
 * trial-balance loaders degraded to an undefined table currency. All
 * three loaders refuse the same way instead: a named notice carrying
 * the Company settings link, rendered as an empty-state block, before
 * any expensive query runs.
 *
 * Only the seams are doubled, and only the ones the suite does not own:
 * `server-only`, the next-intl plumbing, the ambient session (the same
 * auth injection the insights suites use), the feature gates (authz),
 * and the org-info reader whose absent row IS the refused condition
 * (mock the database, never the validation). The loaders, the specs,
 * the refusal copy keys and the href run REAL against scratch orgs.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __baseCurrencyRefusalUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__baseCurrencyRefusalUser.user}')
    }
    // Feature gates are authz: the currency branch under test sits behind
    // them and is independent of their verdict.
    if (specifier === '../../../../lib/projects-gate') {
      return virtual('export async function requireProjectsFeature(){}')
    }
    if (specifier === '../../../../lib/feature-gates') {
      return virtual('export async function requireFeatureEnabled(){}')
    }
    // The refused condition itself: the org row carries no base currency.
    // Nothing else in these chains reads lib/data before the refusal
    // returns, so no other reader can observe the stub.
    if (specifier === '../../../../lib/data') {
      return virtual('export async function orgInfo(){return undefined}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { env } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { BASE_CURRENCY_SETTINGS_HREF, baseCurrencyNotice, hasBaseCurrency } = await import('./base-currency')
const { loadProjectProfitability, projectProfitabilitySpec } = await import('../../app/(app)/reports/project-profitability/view')
const { loadBudgetReport, budgetReportSpec } = await import('../../app/(app)/reports/budget/view')
const { loadTrialBalance, trialBalanceSpec } = await import('../../app/(app)/reports/trial-balance/view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Loader', email: 'loader@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

async function setupOrg() {
  const org = await withBypassContext(() => createScratchOrg())
  const reader = await withBypassContext(() => createScratchUser(org.orgId, 'Reader', 'reader'))
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${org.orgId} and key='reader'`),
  )
  return { org, reader }
}

test('the refusal names its code and the Company settings remedy', async () => {
  const notice = baseCurrencyNotice({ title: 't', description: 'd', actionLabel: 'a' })
  assert.equal(notice.code, 'base-currency-not-configured')
  assert.equal(notice.actionHref, BASE_CURRENCY_SETTINGS_HREF)
  assert.equal(BASE_CURRENCY_SETTINGS_HREF, '/admin/setup/company')
  assert.equal(hasBaseCurrency(undefined), false)
  assert.equal(hasBaseCurrency(null), false)
  assert.equal(hasBaseCurrency(''), false)
  assert.equal(hasBaseCurrency('USD'), true)
})

test('project profitability refuses without a base currency instead of throwing', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, reader } = await setupOrg()
  try {
    state.user = sessionFor(org.orgId, reader)
    const data = await withOrgContext(org.orgId, () => loadProjectProfitability({}))
    assert.equal(data.baseCurrencyNotice?.code, 'base-currency-not-configured')
    assert.equal(data.baseCurrencyNotice?.title, 'baseCurrency.title')
    assert.equal(data.baseCurrencyNotice?.actionHref, '/admin/setup/company')
    assert.equal(data.baseCurrencyReady, false)
    const spec = projectProfitabilitySpec(data) as unknown as {
      body: { widget?: string; props?: { action?: string; actionProps?: { href?: string } }; when?: { $?: string } }[]
    }
    assert.equal(spec.body[0]?.widget, 'empty-state')
    assert.equal(spec.body[0]?.props?.action, 'link-button')
    assert.equal(spec.body[0]?.props?.actionProps?.href, '/admin/setup/company')
    assert.equal(spec.body[0]?.when?.$, 'baseCurrencyNotice')
    assert.equal(spec.body[1]?.when?.$, 'baseCurrencyReady')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('the budget report refuses without a base currency', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, reader } = await setupOrg()
  try {
    state.user = sessionFor(org.orgId, reader)
    const data = await withOrgContext(org.orgId, () => loadBudgetReport({}))
    assert.equal(data.baseCurrencyNotice?.code, 'base-currency-not-configured')
    assert.equal(data.baseCurrencyReady, false)
    const spec = budgetReportSpec(data) as unknown as {
      body: { widget?: string; props?: { actionProps?: { href?: string } }; when?: { $?: string } }[]
    }
    assert.equal(spec.body.length, 1)
    assert.equal(spec.body[0]?.widget, 'empty-state')
    assert.equal(spec.body[0]?.props?.actionProps?.href, '/admin/setup/company')
    assert.equal(spec.body[0]?.when?.$, 'baseCurrencyNotice')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('trial balance refuses without a base currency and hides the paper', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, reader } = await setupOrg()
  try {
    state.user = sessionFor(org.orgId, reader)
    const data = await withOrgContext(org.orgId, () => loadTrialBalance({}))
    assert.equal(data.baseCurrencyNotice?.code, 'base-currency-not-configured')
    assert.equal(data.ratesReady, false)
    const spec = trialBalanceSpec(data) as unknown as {
      body: { kind?: string; when?: { $?: string } }[]
    }
    assert.equal(spec.body[0]?.when?.$, 'baseCurrencyNotice')
    assert.ok(
      spec.body.filter((b) => b.kind === 'paper-view').every((b) => b.when?.$ === 'ratesReady'),
      'the paper stays gated on readiness, which is false under refusal',
    )
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
