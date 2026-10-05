import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// The pay tile reads the EMPLOYEE's own schedule: server copy ('next-intl')
// is stubbed at the boundary so the assertions pin the reader, not the
// catalog. nextPeriodAfter itself is the engine's — the expectations below
// are hand-derived dates, never a second call into the function under test.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getLocale() { return "en" }'
          + 'export async function getTranslations() { return (key) => key }',
        ),
      }
    }
    return next(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadPersonaMetrics } = await import('./_persona.ts')
type Authz = import('@/lib/authz.ts').Authz

const DB = !!env.OPENBOOKS_DB_URL

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: 'Paid Monthly', orgId,
      roles: [{ key: 'staff', name: 'staff' }],
      envKind: 'sandbox', productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(['dashboard.read']),
    allowedSubsidiaryIds: null,
  }
}

/**
 * The pay tile uses the employee's own pay schedule through the payroll
 * calendar — never the org default, never a fixed day-step, never a 28th
 * clamp, and the pay-date offset applies to every frequency. The org default
 * here is weekly while the employee pays monthly on month-end + 5 days, so
 * any answer the weekly schedule would give proves the wrong schedule won.
 */
test('the pay tile follows the employee schedule through the payroll calendar', { skip: !DB }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = (await withBypass(() => createScratchUser(scratch.orgId, 'Paid Monthly', 'staff'))) as unknown as string
  const partyId = randomUUID()
  const weeklyId = randomUUID()
  const monthlyId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"features": {"payroll": true}}'::jsonb where id = ${scratch.orgId}`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${partyId}, ${scratch.orgId}, 'person', 'Paid Monthly')`)
    await db.execute(sql`update users set party_id = ${partyId} where id = ${actorId} and org_id = ${scratch.orgId}`)
    // Org default: weekly, paid 3 days after each week-end.
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, is_default, created_by, updated_by)
      values (${weeklyId}, ${scratch.orgId}, 'Weekly', 'weekly', 52, '2026-06-28', 3, true, true, ${actorId}, ${actorId})`)
    // The employee's schedule: monthly on month-end, paid 5 days later.
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, is_default, created_by, updated_by)
      values (${monthlyId}, ${scratch.orgId}, 'Monthly', 'monthly', 12, '2026-01-31', 5, true, false, ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province)
      values (${scratch.orgId}, ${partyId}, ${monthlyId}, 'CA', 'ON')`)
  })
  try {
    const metrics = await withBypass(() => loadPersonaMetrics(authzFor(scratch.orgId, actorId), new Set(['payTile'])))
    assert.ok(metrics.payTile, 'the tile renders for a profiled employee')
    // Hand-derived: the first month-end strictly after the UTC business day,
    // plus the schedule's 5-day pay-date offset. Month-end pay stays
    // month-end — a 28th clamp would land here instead.
    const now = new Date()
    const todayIso = now.toISOString().slice(0, 10)
    let year = now.getUTCFullYear()
    let month = now.getUTCMonth()
    let end = new Date(Date.UTC(year, month + 1, 0))
    if (end.toISOString().slice(0, 10) <= todayIso) {
      month += 1
      if (month > 11) { month = 0; year += 1 }
      end = new Date(Date.UTC(year, month + 1, 0))
    }
    const expected = new Date(end.getTime() + 5 * 86_400_000).toISOString().slice(0, 10)
    assert.equal(metrics.payTile.nextPayDate, expected, 'next pay date follows the employee monthly schedule, not the weekly default')
    assert.equal(metrics.payTile.lastPayDate, null)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
