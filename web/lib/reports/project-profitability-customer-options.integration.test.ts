import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { projectProfitabilityCustomerOptions } = await import('./projects')

test('project profitability customer options omit customers whose projects are outside scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const hiddenSubsidiary = randomUUID()
      const hiddenCustomer = randomUUID()
      const visibleProject = randomUUID()
      const hiddenProject = randomUUID()
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden legal entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into parties(id, org_id, kind, display_name, subsidiary_id, is_active)
        values (${hiddenCustomer}, ${org.orgId}, 'organization', 'Hidden project customer', ${hiddenSubsidiary}, true)`)
      await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${visibleProject}, ${org.orgId}, ${org.subsidiaryId}, 'VISIBLE-CUSTOMER', 'Visible customer project', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${hiddenProject}, ${org.orgId}, ${hiddenSubsidiary}, 'HIDDEN-CUSTOMER', 'Hidden customer project', ${hiddenCustomer}, 'active', true, '{}'::jsonb)`)

      const restricted = await projectProfitabilityCustomerOptions(org.orgId, new Set([org.subsidiaryId]))
      const unrestricted = await projectProfitabilityCustomerOptions(org.orgId, null)
      assert.ok(restricted.some((customer) => customer.id === org.customerId))
      assert.ok(!restricted.some((customer) => customer.id === hiddenCustomer))
      assert.ok(unrestricted.some((customer) => customer.id === hiddenCustomer))
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
