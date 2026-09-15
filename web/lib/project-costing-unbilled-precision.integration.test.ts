import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { projectUnbilled } = await import('./project-costing.ts')

test('project unbilled labor rounds fractional rate products to ledger precision', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const employee = randomUUID()
    const project = randomUUID()
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${employee}, ${org.orgId}, 'employee', 'Fractional-rate worker', ${org.subsidiaryId})`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'DECIMAL', 'Decimal project', ${org.customerId}, 'active', true)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, is_billable,
      cost_rate, bill_rate, status, billing_status)
      values (${randomUUID()}, ${org.orgId}, ${employee}, ${org.date}, '1.2345', ${project}, true,
        '1.2345', '1.2345', 'approved', 'unbilled')`)

    const unbilled = await projectUnbilled(org.orgId, project)
    assert.equal(unbilled.revenue, '1.5240')
    assert.equal(unbilled.cost, '1.5240')
    assert.equal(unbilled.hours, 1.2345)
  } finally { await dropScratchOrg(org.orgId) }
})
