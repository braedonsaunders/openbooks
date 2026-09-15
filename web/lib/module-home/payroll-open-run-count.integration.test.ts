import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { payrollHome } = await import('./payroll.ts')

/**
 * Payroll in-progress tile vs schedule card: a calculated run whose document
 * is gate-approved but not yet posted is OPEN — the card shows it as the
 * period's run with a commit/post action. The in-progress count must agree
 * with the card instead of counting drafts alone.
 */
test('an approved-but-unposted run counts as in progress', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Payroll clerk', 'admin'))
  try {
    const scheduleId = randomUUID()
    const documentId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${scratch.orgId}, 'Biweekly', 'biweekly', 26, '2026-06-28', 3, true,
                ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                               currency, status, created_by, updated_by)
        values (${scratch.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
                ${scratch.subsidiaryId}, '2026-07-15', 'CAD', 'approved', ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                              pay_date, tax_year, run_status, calculated_at, created_by, updated_by)
        values (${documentId}, ${scratch.orgId}, ${scheduleId}, '2026-06-29', '2026-07-12', '2026-07-15',
                2026, 'calculated', now(), ${actorId}, ${actorId})
      `)
    })

    const home = await withBypass(() => payrollHome(scratch.orgId, null))
    const card = home.schedules.find((s) => s.id === scheduleId)
    assert.ok(card, 'schedule card exists')
    assert.ok(card.run, 'the card treats the approved run as the open run')
    assert.equal(
      home.inProgressRuns,
      1,
      'the in-progress tile must agree with the card that an approved run is open',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
