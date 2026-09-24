import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypass, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

// Database partition: order drill scopes route through live SQL predicates
// (open/backlog, converted/linked, voided) that only PostgreSQL can answer.
// The unit suite keeps the URL round-trip and clamping cover in
// report-drill.test.ts; the scope routing is proved here against seeded
// orders. next-intl has no request scope in plain node, so translations
// resolve to the key (labels are never asserted).

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function redirect() { throw new Error("redirect") }; export function notFound() { throw new Error("not-found") }',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { loadReportDrillData } = await import('./report-drill-data.ts')
hooks.deregister()

type Scope = 'open' | 'converted' | 'conversion' | 'voided'

async function seedOrder(
  orgId: string,
  subsidiaryId: string,
  customerId: string,
  revenueAccountId: string,
  actorId: string,
  date: string,
  number: string,
  status: string,
  quantity: string,
  quantityBilled: string,
): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, fx_rate, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (${id}, ${orgId}, 'sales_order', ${number}, ${customerId},
            ${subsidiaryId}, ${date}, 'USD', '1', 'draft',
            '100.0000', '0', '100.0000', ${actorId}, ${actorId})`)
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity,
       quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
       created_by, updated_by)
    values (${orgId}, ${id}, 1, ${revenueAccountId}, ${quantity},
            ${quantityBilled}, '100.0000', '100.0000', '100.0000', '0', ${actorId}, ${actorId})`)
  // Lines are immutable outside draft status (document_line_immutability
  // guard), so seed the lines first and promote the document after.
  // Voiding additionally requires the documented void reason.
  if (status !== 'draft') {
    await db.execute(sql`update documents
       set status = ${status},
           voided_at = case when ${status} = 'voided' then now() end,
           voided_by = case when ${status} = 'voided' then ${actorId}::uuid end,
           void_reason = case when ${status} = 'voided' then 'drill scope fixture' end
     where id = ${id} and org_id = ${orgId}`)
  }
  return id
}

async function scopedNumbers(
  orgId: string,
  userId: string,
  scope: Scope,
): Promise<string[]> {
  const response = await loadReportDrillData(
    { kind: 'orders', label: 'Orders', orderKind: 'sales_order', scope },
    {
      // orderData reads only the org id and the scope; the remaining
      // principal fields ride along for the Authz type.
      user: {
        id: userId,
        email: 'drill-scope-clerk@example.test',
        name: 'Drill scope clerk',
        roles: [],
        orgId,
        envKind: 'sandbox',
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(),
      allowedSubsidiaryIds: null,
    },
    1,
  )
  assert.equal(response.total, response.rows.length)
  return response.rows.map((row) => String(row.cells[1])).sort()
}

test('order drill routes open, converted, and voided scopes through the right predicates', async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, 'Drill scope clerk', 'drill_scope_clerk'))
    await withBypassContext(async () => {
      const seed = (number: string, status: string, quantity: string, quantityBilled: string) =>
        seedOrder(org.orgId, org.subsidiaryId, org.customerId, org.accounts.revenue, actorId, org.date, number, status, quantity, quantityBilled)
      await seed('SO-OPEN-1', 'approved', '5', '2')
      const convertedId = await seed('SO-CONV-1', 'approved', '5', '5')
      const linkTarget = await seed('SO-CONV-TARGET', 'approved', '1', '1')
      await db.execute(sql`
        insert into document_links
          (org_id, from_document_id, to_document_id, link_type, created_by)
        values (${org.orgId}, ${convertedId}, ${linkTarget}, 'fulfills', ${actorId})`)
      await seed('SO-VOID-1', 'voided', '5', '0')
    })

    // Reads run under the org scope, proving the routing holds under
    // enforcement rather than under the seed bypass. The open scope needs
    // unconverted line quantity; the converted scope needs a document
    // link; the voided scope needs the voided status — each scope sees
    // exactly its own population.
    await withOrgContext(org.orgId, async () => {
      assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'open'), ['SO-OPEN-1'])
      assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'converted'), ['SO-CONV-1'])
      assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'conversion'), ['SO-CONV-1'])
      assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'voided'), ['SO-VOID-1'])
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
