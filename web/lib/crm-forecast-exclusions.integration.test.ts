import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm/crm.ts')
const { countUndatedForecastExcluded } = await import('./crm.ts')

test('forecast exclusion count includes only active, open, dated-eligible opportunities', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Forecast reader', 'crm_reader'))
    await withBypassContext(async () => {
      await ensureCrmDefaults(org.orgId, actor)
      const statuses = (await db.execute<{ id: string; is_closed: boolean; forecast_category?: string }>(sql`
        select id, is_closed from crm_opportunity_statuses
         where org_id=${org.orgId} and is_active order by is_closed, sequence`)).rows
      const open = statuses.find((status) => !status.is_closed)
      const closed = statuses.find((status) => status.is_closed)
      assert.ok(open, 'CRM defaults provide an open status')
      assert.ok(closed, 'CRM defaults provide a closed status')
      const rows = [
        { title: 'eligible-undated', status: open.id, forecast: 'most_likely', active: true, closeDate: null },
        { title: 'second-eligible-undated', status: open.id, forecast: 'worst_case', active: true, closeDate: null },
        { title: 'dated', status: open.id, forecast: 'most_likely', active: true, closeDate: org.date },
        { title: 'omitted', status: open.id, forecast: 'omitted', active: true, closeDate: null },
        { title: 'closed', status: closed.id, forecast: 'most_likely', active: true, closeDate: null },
        { title: 'inactive', status: open.id, forecast: 'most_likely', active: false, closeDate: null },
      ]
      for (const row of rows) {
        const id = randomUUID()
        await db.execute(sql`insert into crm_opportunities
          (id,org_id,opportunity_number,title,status_id,probability,currency,projected_amount,weighted_amount,
           expected_close_date,forecast_category,is_active,created_by,updated_by)
          values(${id},${org.orgId},${id},${row.title},${row.status},50,'USD','100','50',
            ${row.closeDate},${row.forecast},${row.active},${actor},${actor})`)
      }
    })

    const count = await withOrgContext(org.orgId, () => countUndatedForecastExcluded({ orgId: org.orgId }))
    assert.equal(count, 2, 'the count includes both active, open, forecast-eligible undated opportunities')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
