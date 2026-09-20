import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Utilization must read approved time only. Draft, submitted and rejected
 * hours are not worked reality yet (and rejected hours never will be) — every
 * sibling reader (project profitability hours, the time drill-down) requires
 * `status = 'approved'`, but the utilization rollup counted every status, so
 * unapproved hours inflated billable % and non-billable cost.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { utilizationData } = (await import(root + 'web/lib/analytics/utilization-data.ts')) as typeof import('./analytics/utilization-data')

test('utilization counts approved time only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const employee = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${employee}, ${org.orgId}, 'person', 'Util Worker', ${org.subsidiaryId})`)
      for (const [status, hours] of [['approved', '8'], ['draft', '8'], ['submitted', '4'], ['rejected', '2']] as const) {
        await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, status)
          values (${org.orgId}, ${employee}, ${org.date}, ${hours}, null, ${org.items.service}, true, '10', ${status})`)
      }
    })
    await withOrgContext(org.orgId, async () => {
      const data = await utilizationData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null)
      assert.equal(data.company.range.hours, 8, 'draft/submitted/rejected hours must not inflate utilization')
      assert.equal(data.company.range.billableHours, 8)
      assert.equal(data.employees.length, 1)
      assert.equal(data.employees[0]!.range.hours, 8)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
