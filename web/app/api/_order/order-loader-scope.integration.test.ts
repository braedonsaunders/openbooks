import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    return next(specifier, context)
  },
})

const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { loadOrder } = await import('./lib.ts')

test('order loader refuses documents outside the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const hiddenSubsidiaryId = randomUUID()
    const orderId = randomUUID()
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
      values (${hiddenSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Private subsidiary', 'CAD', 'CA')
    `)
    await db.execute(sql`
      insert into documents(
        id, org_id, kind, document_number, document_date, party_id, subsidiary_id,
        currency, status, subtotal, tax_total, total, memo
      ) values (
        ${orderId}, ${org.orgId}, 'quote', 'PRIVATE-QUOTE', ${org.date}, ${org.customerId},
        ${hiddenSubsidiaryId}, 'CAD', 'draft', 100, 0, 100, 'Private terms'
      )
    `)
    await db.execute(sql`
      insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
      values (${org.orgId}, ${orderId}, 1, ${org.accounts.revenue}, 'Private line', 1, 100, 100)
    `)

    const scopedLoadOrder = loadOrder as unknown as (
      id: string,
      orgId: string,
      kind: 'quote',
      allowedSubsidiaryIds: ReadonlySet<string> | null,
    ) => Promise<unknown>
    const visible = await scopedLoadOrder(orderId, org.orgId, 'quote', new Set([org.subsidiaryId]))

    assert.equal(visible, null, 'out-of-scope order must not be hydrated for a restricted reader')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
