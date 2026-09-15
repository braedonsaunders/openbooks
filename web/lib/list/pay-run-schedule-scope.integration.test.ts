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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { listSource } = await import('./sources.ts')

/**
 * Pay-run schedule filter options must honor the caller subsidiary scope,
 * like the banking and expense filters already do: a restricted caller sees
 * only schedules in visible subsidiaries. A schedule with no subsidiary
 * belongs to the root subsidiary (the canonical payroll rule), so it shows
 * exactly when the root is visible — never org-wide, never hidden from it.
 */
test('pay-run schedule filter options honor the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const branchId = randomUUID()
    const rootSchedule = randomUUID()
    const branchSchedule = randomUUID()
    const globalSchedule = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Payroll branch', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end, subsidiary_id)
        values
          (${rootSchedule}, ${scratch.orgId}, 'Root biweekly', 'biweekly', 26, '2026-01-02', ${scratch.subsidiaryId}),
          (${branchSchedule}, ${scratch.orgId}, 'Branch biweekly', 'biweekly', 26, '2026-01-02', ${branchId}),
          (${globalSchedule}, ${scratch.orgId}, 'Legacy biweekly', 'biweekly', 26, '2026-01-02', null)
      `)
    })

    const source = listSource('pay_run')
    assert.ok(source)
    const scheduleFilter = source.quickFilters?.find((filter) => filter.filterKey === 'pay_schedule_id')
    assert.ok(scheduleFilter?.loadOptions)
    const loadOptions = scheduleFilter.loadOptions as (
      orgId: string,
      allowedSubsidiaryIds: ReadonlySet<string> | null,
    ) => Promise<{ value: string; label: string }[]>
    const values = async (allowed: ReadonlySet<string> | null) =>
      (await loadOptions(scratch.orgId, allowed)).map((option) => option.value).sort()

    assert.deepEqual(await values(new Set([branchId])), [branchSchedule], 'branch scope sees only the branch schedule')
    assert.deepEqual(
      await values(new Set([scratch.subsidiaryId])),
      [globalSchedule, rootSchedule].sort(),
      'root scope sees the root schedule plus the unscoped (root-owned) one',
    )
    assert.deepEqual(
      await values(null),
      [branchSchedule, globalSchedule, rootSchedule].sort(),
      'unrestricted callers see every schedule',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
