import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { UsageBillingError } from '@openbooks/engine/src/billing/usage/errors.ts'
import { createPrepaidGrant } from '@openbooks/engine/src/billing/usage/prepaid.ts'
import { commitRateRun } from '@openbooks/engine/src/billing/usage/rate-run.ts'
import { createUsageMeter, ingestUsageRecords } from '@openbooks/engine/src/billing/usage/records.ts'
import {
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
} from '@openbooks/engine/src/billing/usage/rating-plans.ts'
import { recomputeSaasMetrics, saasMetricsScanTargets } from '@openbooks/engine/src/billing/metrics/metrics-ledger.ts'
import { REPORT_ENTITIES, BUILT_IN_REPORT_DEFINITION_MAP } from '@openbooks/reports'
import { availableReportEntities } from './report-builder-catalog.ts'
import type { Authz } from './authz.ts'

const routeState: { authz: Authz | null } = { authz: null }
Object.assign(globalThis, { __saasFeatureRouteState: routeState, __saasFeatureNextResponse: NextResponse })
const realAuthz = new URL('./authz.ts', import.meta.url).href
const authzStub = { shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(`import { can } from '${realAuthz}'; export * from '${realAuthz}'; export async function getAuthz(){return globalThis.__saasFeatureRouteState.authz} export async function guardPermission(p){const a=globalThis.__saasFeatureRouteState.authz;if(!a)return globalThis.__saasFeatureNextResponse.json({error:'unauthorized'},{status:401});if(!can(a,p))return globalThis.__saasFeatureNextResponse.json({error:'missing permission: '+p},{status:403});return a;}`) }
registerHooks({ resolve(s, c, n) { return s === '@/lib/authz' || (s === './authz' && c.parentURL?.includes('/web/lib/feature-gates')) ? authzStub : n(s) } })
const { GET: getUsageMeters } = await import('../app/api/usage/meters/route.ts')
const { GET: getMetricsMonths } = await import('../app/api/metrics/months/route.ts')
const { PUT: setContractPricing } = await import('../app/api/revenue/contracts/[id]/pricing/route.ts')

const DB = { skip: !process.env.OPENBOOKS_DB_URL }
const SAAS_METRIC_REPORTS = [
  'mrr-movements', 'arr-summary', 'revenue-churn', 'nrr-grr', 'cohort-retention',
  'arpa-ltv', 'gross-margin', 'deferred-waterfall', 'bookings-billings-revenue',
] as const

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await withOrgContext(orgId, async () => {
    const changed = await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb, true)
       where id = ${orgId} returning id`)
    assert.equal(changed.rows.length, 1, 'the feature settings row must remain in the organization')
  })
}

async function assertRouteHidden(response: Response): Promise<void> {
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
}

async function createUsageSetup(org: Awaited<ReturnType<typeof createScratchOrg>>, actorId: string) {
  const suffix = randomUUID().slice(0, 8)
  const itemId = randomUUID()
  const subscriptionPlanId = randomUUID()
  const subscriptionId = randomUUID()
  await withOrgContext(org.orgId, async () => {
    const item = await db.execute(sql`
      insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
      values (${itemId}, ${org.orgId}, 'service', ${`Usage item ${suffix}`}, ${org.accounts.revenue}, true, '{}'::jsonb)
      returning id`)
    assert.equal(item.rows.length, 1)
    const plan = await db.execute(sql`
      insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count, created_by)
      values (${subscriptionPlanId}, ${org.orgId}, ${`Subscription ${suffix}`}, '100', 'CAD', 'monthly', 1, ${actorId})
      returning id`)
    assert.equal(plan.rows.length, 1)
    const subscription = await db.execute(sql`
      insert into subscriptions (id, org_id, customer_id, plan_id, quantity, price_override, status,
                                 start_on, next_bill_on, auto_post, created_by)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${subscriptionPlanId}, '1', '100', 'active',
              '2026-07-01', '2026-08-15', false, ${actorId}) returning id`)
    assert.equal(subscription.rows.length, 1)
  })
  const meter = await createUsageMeter(org.orgId, actorId, {
    key: `requests-${suffix}`, name: `API requests ${suffix}`, unit: 'request', aggregation: 'sum', itemId,
  })
  const plan = await createUsageRatingPlan(org.orgId, actorId, { name: `Usage plan ${suffix}`, currency: 'CAD' })
  const version = await createUsageRatingPlanVersion(org.orgId, actorId, { planId: plan.id, effectiveFrom: '2026-07-01' })
  await replaceUsageRatingBands(org.orgId, actorId, version.id, [
    { meterId: meter.id, kind: 'graduated', seq: 1, upToQty: '2', unitPrice: '1.25' },
    { meterId: meter.id, kind: 'graduated', seq: 2, upToQty: null, unitPrice: '2.50' },
  ])
  await publishUsagePlanVersion(org.orgId, actorId, version.id)
  const link = await createSubscriptionUsageLink(org.orgId, actorId, {
    subscriptionId, customerId: org.customerId, planVersionId: version.id, meterIds: [meter.id],
    effectiveFrom: '2026-07-01', commitAmount: '10', commitPeriod: 'monthly', allowOverage: true,
  })
  return { meter, link, subscriptionId, planId: plan.id, versionId: version.id }
}

async function evidenceSnapshot(orgId: string): Promise<string> {
  return withOrgContext(orgId, async () => {
    const result = await db.execute<{ snapshot: string }>(sql`
      select jsonb_build_object(
        'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from usage_records r where r.org_id = ${orgId}),
        'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from usage_rating_runs r where r.org_id = ${orgId}),
        'invoices', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from documents d where d.org_id = ${orgId} and d.custom ? 'usageRunId'),
        'lines', (select coalesce(jsonb_agg(to_jsonb(dl) order by dl.document_id, dl.line_number), '[]'::jsonb)
                    from document_lines dl join documents d on d.org_id = dl.org_id and d.id = dl.document_id
                   where dl.org_id = ${orgId} and d.custom ? 'usageRunId'),
        'metrics', (select coalesce(jsonb_agg(to_jsonb(m) order by m.month, m.subsidiary_id), '[]'::jsonb) from saas_metrics_monthly m where m.org_id = ${orgId}),
        'facts', (select coalesce(jsonb_agg(to_jsonb(f) order by f.month, f.subsidiary_id), '[]'::jsonb) from saas_metrics_facts_monthly f where f.org_id = ${orgId}),
        'cohorts', (select coalesce(jsonb_agg(to_jsonb(c) order by c.month, c.subsidiary_id, c.cohort_month), '[]'::jsonb) from saas_metrics_cohort_monthly c where c.org_id = ${orgId})
      )::text as snapshot`)
    return result.rows[0]!.snapshot
  })
}

async function expectFeaturesRefusal(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof UsageBillingError
    && error.code === 'feature_off' && /Company Settings → Features/.test(error.remedy))
}

function resultRows(result: { groups: { columns: string[]; rows: unknown[][] }[] }): string {
  return JSON.stringify(result.groups.map(({ columns, rows }) => ({ columns, rows })))
}

test('SaaS usage and metrics preserve evidence across feature gates', DB, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, 'Usage billing controller', 'admin'))
  try {
    await setFeatures(org.orgId, { subscriptionBilling: true, usageBilling: true, saasMetrics: true })
    const usage = await createUsageSetup(org, actorId)
    await ingestUsageRecords(org.orgId, actorId, [{
      meterKey: usage.meter.key, customerId: org.customerId, subscriptionId: usage.subscriptionId,
      occurredOn: org.date, quantity: '3', source: 'api', idempotencyKey: randomUUID(),
    }])
    const committed = await commitRateRun(org.orgId, actorId, usage.link.id, '2026-07-01', '2026-07-31')
    assert.ok(committed.invoiceId, 'the usage run must create a draft invoice')
    assert.equal(committed.preview.commitShortfall, '5.0000')
    await recomputeSaasMetrics(org.orgId, '2026-07-01')

    const authz = {
      user: { id: actorId, email: 'usage@example.test', name: 'Usage Reader', roles: [], orgId: org.orgId,
        envKind: 'production', productionOrgId: org.orgId, homeUserId: actorId, homeOrgId: org.orgId, isSuperAdmin: false },
      permissions: new Set(['reports.read', 'usage.read']), allowedSubsidiaryIds: null,
    } as Authz
    routeState.authz = {
      ...authz,
      permissions: new Set(['usage.read', 'usage.manage', 'usage.bill', 'ar.post']),
    }
    const { executeReport } = await import('./custom-reports.ts')
    const { withReportAuthz } = await import('./report-execution-context.ts')
    const { canSeeReportDefinition, hiddenReportEntityKeys } = await import('./report-authz.ts')
    const runReport = (slug: string) => {
      const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug]!
      return withOrgContext(org.orgId, () => withReportAuthz(authz, () => executeReport(org.orgId, definition.query, undefined, {})))
    }
    const metricFigures = new Map<string, string>()
    for (const slug of SAAS_METRIC_REPORTS) {
      const result = await runReport(slug)
      metricFigures.set(slug, resultRows(result))
      if (slug === 'mrr-movements') {
        assert.ok(result.groups.some((group) => group.rows.length), 'the metrics built-in must have a row')
      }
    }
    const usageBefore = await runReport('usage-billing-detail')
    assert.equal(usageBefore.groups.reduce((count, group) => count + group.rows.length, 0), 3,
      'the detail report must include both rated bands and the minimum-commit trace')
    const before = await evidenceSnapshot(org.orgId)
    const usageFigures = resultRows(usageBefore)

    await setFeatures(org.orgId, { usageBilling: false, saasMetrics: false })
    await expectFeaturesRefusal(ingestUsageRecords(org.orgId, actorId, []))
    await expectFeaturesRefusal(commitRateRun(org.orgId, actorId, usage.link.id, '2026-07-01', '2026-07-31'))
    await expectFeaturesRefusal(createPrepaidGrant(org.orgId, actorId, {
      customerId: org.customerId, sourceDocumentLineId: randomUUID(), amount: '1', currency: 'CAD',
    }))
    await expectFeaturesRefusal(createUsageRatingPlan(org.orgId, actorId, { name: 'Disabled plan', currency: 'CAD' }))
    await expectFeaturesRefusal(createUsageRatingPlanVersion(org.orgId, actorId, {
      planId: usage.planId, effectiveFrom: '2026-08-01',
    }))
    await expectFeaturesRefusal(replaceUsageRatingBands(org.orgId, actorId, usage.versionId, []))
    await expectFeaturesRefusal(publishUsagePlanVersion(org.orgId, actorId, usage.versionId))
    await expectFeaturesRefusal(recomputeSaasMetrics(org.orgId, '2026-07-01'))
    const targets = await saasMetricsScanTargets()
    assert.ok(targets.skippedFeatureOffOrgIds.includes(org.orgId), 'the metrics scan summary must classify this org as feature off')
    assert.ok(!targets.enabledOrgIds.includes(org.orgId), 'the disabled organization must not be scanned')

    const hidden = await withOrgContext(org.orgId, async () => hiddenReportEntityKeys(authz))
    const visible = availableReportEntities(REPORT_ENTITIES, hidden)
    for (const key of [
      'usage_billing_lines', 'saas_metrics_subscriptions', 'saas_metrics_facts',
      'saas_metrics_cohorts', 'deferred_revenue_runoff',
    ]) {
      assert.ok(hidden.includes(key), `${key} must be hidden while its feature is off`)
      assert.ok(!visible.some((entity) => entity.key === key), `${key} must be absent from the report catalog`)
    }
    for (const slug of [...SAAS_METRIC_REPORTS, 'usage-billing-detail']) {
      const query = BUILT_IN_REPORT_DEFINITION_MAP[slug]!.query
      assert.equal(await withOrgContext(org.orgId, () => canSeeReportDefinition(authz, { report_type: 'query', query, statement: null })), false)
      await assert.rejects(runReport(slug), /Report access denied|unavailable|disabled/i)
    }
    assert.equal(await evidenceSnapshot(org.orgId), before, 'turning features off must leave every usage and metric row byte-for-byte unchanged')

    await setFeatures(org.orgId, { subscriptionBilling: false, usageBilling: true, saasMetrics: true })
    await expectFeaturesRefusal(ingestUsageRecords(org.orgId, actorId, []))
    await expectFeaturesRefusal(commitRateRun(org.orgId, actorId, usage.link.id, '2026-07-01', '2026-07-31'))
    await expectFeaturesRefusal(createPrepaidGrant(org.orgId, actorId, {
      customerId: org.customerId, sourceDocumentLineId: randomUUID(), amount: '1', currency: 'CAD',
    }))
    await expectFeaturesRefusal(createUsageRatingPlan(org.orgId, actorId, { name: 'Parent-disabled plan', currency: 'CAD' }))
    await expectFeaturesRefusal(recomputeSaasMetrics(org.orgId, '2026-07-01'))
    const offTargets = await saasMetricsScanTargets()
    assert.ok(offTargets.skippedFeatureOffOrgIds.includes(org.orgId), 'a child override cannot reach the metrics duty through its disabled parent')

    await setFeatures(org.orgId, { subscriptionBilling: true, usageBilling: true, saasMetrics: true })
    assert.equal(await evidenceSnapshot(org.orgId), before, 're-enabling features must reveal the unchanged evidence')
    await recomputeSaasMetrics(org.orgId, '2026-07-01')
    for (const [slug, figures] of metricFigures) assert.equal(resultRows(await runReport(slug)), figures)
    assert.equal(resultRows(await runReport('usage-billing-detail')), usageFigures)

    await setFeatures(org.orgId, { subscriptionBilling: true, usageBilling: false, saasMetrics: true, revenueRecognition: true })
    await assertRouteHidden(await withOrgContext(org.orgId, () => getUsageMeters(new Request('http://openbooks.test/api/usage/meters'))))
    await setFeatures(org.orgId, { usageBilling: true, saasMetrics: false })
    await assertRouteHidden(await withOrgContext(org.orgId, () => getMetricsMonths(new Request('http://openbooks.test/api/metrics/months'))))
    await setFeatures(org.orgId, { saasMetrics: true, revenueRecognition: false })
    await assertRouteHidden(await withOrgContext(org.orgId, () => setContractPricing(new Request('http://openbooks.test/api/revenue/contracts/00000000-0000-4000-8000-000000000001/pricing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) })))
  } finally {
    routeState.authz = null
    await dropScratchOrg(org.orgId)
  }
})
