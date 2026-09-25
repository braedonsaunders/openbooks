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
const { rankProjects } = await import('./project-ranking')
const { marginPercentText } = await import('./financial-decimal')

test('ranked margin rounds the half-up tie exactly (1.005% -> 1.01)', () => {
  assert.equal(marginPercentText('1.0050', '100.0000'), '1.01')
})

test('project ranking counts only purchase order commitments visible to the caller', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const hiddenSubsidiary = randomUUID()
      const project = randomUUID()
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status, is_active, contract_value)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'SCOPE-RANK', 'Scope ranking', ${org.customerId}, 'active', true, 0)`)

      async function purchaseOrder(subsidiaryId: string, amount: string) {
        const documentId = randomUUID()
        await db.execute(sql`insert into documents(id, org_id, kind, document_number, document_date, currency, status, party_id, subsidiary_id, subtotal, total)
          values (${documentId}, ${org.orgId}, 'purchase_order', ${documentId}, ${org.date}, 'CAD', 'draft', ${org.vendorId}, ${subsidiaryId}, ${amount}, ${amount})`)
        await db.execute(sql`insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, project_id, subsidiary_id)
          values (${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 'Open project commitment', 1, ${amount}, ${amount}, ${project}, ${subsidiaryId})`)
        await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${documentId}`)
      }

      await purchaseOrder(org.subsidiaryId, '100')
      await purchaseOrder(hiddenSubsidiary, '900')

      const args = { limit: 10, withActivityOnly: false }
      const restricted = await rankProjects(org.orgId, args, new Set([org.subsidiaryId]))
      const unrestricted = await rankProjects(org.orgId, args, null)
      assert.equal(restricted.rows.find((row) => row.id === project)?.committedCost, '100.0000')
      assert.equal(unrestricted.rows.find((row) => row.id === project)?.committedCost, '1000.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
