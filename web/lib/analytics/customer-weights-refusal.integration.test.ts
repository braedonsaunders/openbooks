import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  // No request scope here: serve an empty cookie jar like the sibling
  // customer integration suites.
  if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export function cookies() { return { get() { return undefined } } }' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { customerData, customerProfitability, customerSummaryData } = await import('./customer-data')

/**
 * A hand-edited settings blob bypasses the config write validation, so a
 * weight group can stop summing to 100 underneath a live dashboard. The
 * loaders must return that refusal in the payload — naming the broken group
 * and the Configuration remedy — instead of throwing (which kills the page,
 * the hub preview and the assistant tool, and production redacts).
 */
test('customer loaders refuse a broken weight sum in the payload, never a throw', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(() => db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb)
      || '{"features":{"projects":true},"analytics":{"customerIntelligence":{"healthWeightRecency":24}}}'::jsonb
      where id = ${scratch.orgId}`))
    const period = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
    await pinClock('2026-07-15', async () => {
      const full = await withOrgContext(scratch.orgId, () => customerData(period, scratch.orgId, null))
      assert.ok(full.weightsError, 'the full loader must carry the refusal')
      assert.ok(full.weightsError.includes('Health — recency weight (%)'), `the refusal must name the broken group by label, got: ${full.weightsError}`)
      assert.ok(!full.weightsError.includes('healthWeightRecency'), `no raw storage key may reach the operator, got: ${full.weightsError}`)
      assert.ok(full.weightsError.includes('Customer Intelligence → Configuration'), `the refusal must name the reachable remedy, got: ${full.weightsError}`)
      assert.deepEqual(full.rows, [])
      assert.equal(full.config.healthWeightRecency, 24)
      const summary = await withOrgContext(scratch.orgId, () => customerSummaryData(period, scratch.orgId, null))
      assert.equal(summary.weightsError, full.weightsError)
      const prof = await withOrgContext(scratch.orgId, () => customerProfitability(period, scratch.orgId, null, undefined, full.kpis.totalRevenue))
      assert.equal(prof.weightsError, full.weightsError)
      assert.deepEqual(prof.customers, [])
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
