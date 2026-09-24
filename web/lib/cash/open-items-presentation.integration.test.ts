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

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { openItems } = await import('./open-items.ts')
const { listApplicationOpenItems } = await import('../application/open-items.ts')
type ApplicationContext = import('../application/context.ts').ApplicationContext

const D = '2026-07-14'

async function seedHostileMix() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    const usCust = randomUUID()
    const usVend = randomUUID()
    for (const [id, kind, name] of [[usCust, 'customer', 'US Customer'], [usVend, 'vendor', 'US Vendor']] as const) {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom) values (${id}, ${org.orgId}, ${kind}, ${name}, true, '{}'::jsonb)`)
    }
    const docs = [
      ['INV-CAD', 'customer_invoice', org.subsidiaryId, org.customerId, 'CAD', '100', '1', org.accounts.ar, org.accounts.revenue],
      ['INV-USD', 'customer_invoice', usSub, usCust, 'USD', '200', '1', org.accounts.ar, org.accounts.revenue],
      ['BILL-CAD', 'vendor_bill', org.subsidiaryId, org.vendorId, 'CAD', '100', '1', org.accounts.ap, org.accounts.cogs],
      ['BILL-USD', 'vendor_bill', usSub, usVend, 'USD', '100', '1', org.accounts.ap, org.accounts.cogs],
    ] as const
    for (const [num, kind, sub, party, cur, total, fx, ctrl, contra] of docs) {
      const docId = randomUUID()
      const entryId = randomUUID()
      const ctrlAmt = kind === 'vendor_bill' ? `-${total}` : total
      const contraAmt = kind === 'vendor_bill' ? total : `-${total}`
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total)
        values (${docId}, ${org.orgId}, ${kind}, ${num}, ${party}, ${sub}, ${D}, ${D}, ${cur}, ${fx}, 'draft', ${total}, 0, ${total})`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${ctrl}, ${sub}, ${party}, true, ${ctrlAmt}, ${cur}, ${ctrlAmt}, ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${contra}, ${sub}, ${party}, false, ${contraAmt}, ${cur}, ${contraAmt}, ${fx})`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    }
  })
  return org
}

function applicationContext(orgId: string): ApplicationContext {
  return {
    authz: {
      user: { orgId } as ApplicationContext['authz']['user'],
      permissions: new Set(['ar.read', 'ap.read']),
      allowedSubsidiaryIds: null,
    },
    source: 'api',
    requestId: randomUUID(),
    apiKeyId: null,
  }
}

/**
 * Open AR/AP items are collectible/payable balances stated in the org's
 * presentation currency: a USD 200 invoice at a 1.35 closing spot is 270 CAD
 * of receivables, not 200. Summing raw line functionals mixes subsidiary
 * currencies on every consolidated cash surface (positions, forecast, aging).
 */
test('open items translate foreign-functional lines at the as-of spot', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedHostileMix()
  try {
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const ar = (await openItems(org.orgId, 'ar', '2026-07-15')).map((i) => i.remaining).sort()
        assert.deepEqual(ar, ['100.0000', '270.0000'])
        const ap = (await openItems(org.orgId, 'ap', '2026-07-15')).map((i) => i.remaining).sort()
        assert.deepEqual(ap, ['100.0000', '135.0000'])
        const app = applicationContext(org.orgId)
        const applicationAr = await listApplicationOpenItems(app, { side: 'ar', asOf: '2026-07-15' })
        assert.equal(applicationAr.total, 2)
        assert.deepEqual(applicationAr.items.map((item) => item.remaining).sort(), ['100.0000', '270.0000'])
        const applicationAp = await listApplicationOpenItems(app, { side: 'ap', asOf: '2026-07-15' })
        assert.equal(applicationAp.total, 2)
        assert.deepEqual(applicationAp.items.map((item) => item.remaining).sort(), ['100.0000', '135.0000'])
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('open items fail closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedHostileMix()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(openItems(org.orgId, 'ar', '2026-07-15'), /no spot rate for USD/)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
