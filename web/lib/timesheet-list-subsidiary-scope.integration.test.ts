import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { ListViewConfig } from '@openbooks/customization'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { entityListSource } = await import('./list/entity-sources.ts')

test('timesheet week rows and employee options honor the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const visibleEmployee = randomUUID()
    const hiddenEmployee = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden timesheet entity', 'CAD', 'CA')
      `)
      for (const [employee, subsidiary, label] of [
        [visibleEmployee, scratch.subsidiaryId, 'Visible timesheet worker'],
        [hiddenEmployee, hiddenSubsidiary, 'Hidden timesheet worker'],
      ] as const) {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id)
          values (${employee}, ${scratch.orgId}, 'person', ${label}, ${subsidiary})
        `)
        await db.execute(sql`
          insert into employee_roles (org_id, party_id, hired_on, is_active)
          values (${scratch.orgId}, ${employee}, '2026-01-01', true)
        `)
        await db.execute(sql`
          insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status)
          values (${randomUUID()}, ${scratch.orgId}, ${employee}, ${scratch.date}, 8, 'approved')
        `)
      }
    })

    const source = entityListSource('timesheet_week')
    assert.ok(source)
    const table = source.table
    assert.equal(typeof table, 'function')
    if (typeof table !== 'function') throw new TypeError('timesheet week source must be an aggregate table')
    const view = {
      schemaVersion: 1,
      recordType: 'timesheet_week',
      columns: [],
      filters: [],
    } as ListViewConfig
    const allowed = new Set([scratch.subsidiaryId])
    const where = source.where(view, { filters: {}, showInactive: false }, scratch.orgId, allowed)
    const rows = await db.execute<{ employee_party_id: string }>(sql`
      select tw.employee_party_id
        from ${table(scratch.orgId)} tw
        ${source.baseJoins}
       where ${where}
       order by tw.employee_party_id
    `)
    assert.deepEqual(rows.rows.map((row) => row.employee_party_id), [visibleEmployee])

    const employeeFilter = source.quickFilters.find((filter) => filter.filterKey === 'employee_party_id')
    assert.ok(employeeFilter?.loadOptions)
    const options = await employeeFilter.loadOptions(scratch.orgId, allowed)
    assert.deepEqual(options.map((option) => option.value), [visibleEmployee])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
