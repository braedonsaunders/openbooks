import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { purchasingHome } = await import('./purchasing')

/**
 * Open purchase-order commitments translate each order's currency before
 * org-currency summation: POs never post, so they carry no maintained
 * fx_rate — a raw total mixes transaction currencies. CAD 100 + USD 100 at
 * the 1.35 spot is 235, not 200, in both the badge and the hero roster.
 */
test('open purchase-order value converts each order currency before summing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Buyer', 'admin'))
    await withBypassContext(() => db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,orders}', 'true'::jsonb)
       where id = ${org.orgId}
    `))
    await withBypassContext(() => db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-14', 'spot', '1.35')
    `))
    for (const [currency, total, number] of [
      ['CAD', '100', 'PO-CAD'],
      ['USD', '100', 'PO-USD'],
    ] as const) {
      await withBypassContext(() => db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
           currency, status, subtotal, tax_total, total, created_by, updated_by)
        values
          (${randomUUID()}, ${org.orgId}, 'purchase_order', ${number}, ${org.vendorId},
           ${org.subsidiaryId}, '2026-07-14', ${currency}, 'approved', ${total}, 0, ${total},
           ${actorId}, ${actorId})
      `))
    }

    // purchasing.ts reads through org-scope: unscoped the org lookup itself
    // throws 'has no base currency', so the FX math under test never runs.
    const home = await withOrgContext(org.orgId, () => purchasingHome(org.orgId))
    assert.equal(home.ordersEnabled, true, 'orders feature must be on for PO vitals')
    assert.equal(home.openPos, 2)
    assert.equal(home.openPoValue, 235, 'CAD 100 + USD 100 at 1.35 spot')
    assert.equal(home.topExposure.length, 1)
    assert.equal(home.topExposure[0]!.openPoValue, 235, 'hero roster converts too')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
