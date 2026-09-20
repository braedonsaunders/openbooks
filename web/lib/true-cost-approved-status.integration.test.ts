import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * True Cost's labour bases must read approved time only — the same rule as
 * utilization, project profitability hours and the time drill-down. Draft,
 * submitted and rejected hours inflated billed/total hours, understating every
 * hours-based burden rate.
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
const { trueCostData } = (await import(root + 'web/lib/analytics/true-cost-data.ts')) as typeof import('./analytics/true-cost-data')

test('true cost labour bases count approved time only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const employee = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${employee}, ${org.orgId}, 'person', 'True Cost Worker', ${org.subsidiaryId})`)
      for (const [status, hours] of [['approved', '8'], ['draft', '8'], ['submitted', '4'], ['rejected', '2']] as const) {
        await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, cost_rate, status)
          values (${org.orgId}, ${employee}, ${org.date}, ${hours}, null, ${org.items.service}, true, '10', ${status})`)
      }
    })
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }, null)
      assert.equal(data.kpis.totalHours, 8, 'draft/submitted/rejected hours must not inflate true-cost bases')
      assert.equal(data.kpis.billedHours, 8)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
