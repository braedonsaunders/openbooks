import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Live-Postgres regression: the January readiness queue judges unflagged
// vendors against the statute for their form and year. It used to compare
// every vendor's bank cash against a flat $600, so for 2026+ it queued US
// vendors paid $600-$1,999 that no filing can include, and it missed T4A
// vendors paid $500-$599 that a T4A filing must include.

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Resolve this worktree's engine directly, even when node_modules is shared.
    if (specifier.startsWith('@openbooks/engine/')) {
      const engineRoot = new URL('../../engine/', import.meta.url)
      return {
        url: new URL(specifier.slice('@openbooks/engine/'.length), engineRoot).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})
// Query-suffixed URL keeps this import out of the module cache shared with
// sibling suites (same seam as the information-returns scope suite: a const
// URL is opaque to tsc, which would otherwise try to resolve the query).
const libUrl = './compliance.ts?readiness'
const { loadInformationReturnReadiness } = (await import(libUrl)) as typeof import('./compliance.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)

const DB = !!process.env.OPENBOOKS_DB_URL

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function seedVendor(
  org: Org,
  actorId: string,
  opts: { form: string | null; flagged: boolean; classification?: string },
): Promise<string> {
  const partyId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${partyId}, ${org.orgId}, 'vendor', ${`Readiness ${opts.form ?? 'none'}-${partyId.slice(0, 8)}`},
              null, true, '{}'::jsonb)`)
    await db.execute(sql`
      insert into vendor_roles
        (org_id, party_id, is_t4a, information_return_form, tax_classification,
         tin_last4, tin_type, created_by, updated_by)
      values
        (${org.orgId}, ${partyId}, ${opts.flagged}, ${opts.form},
         ${opts.classification ?? 'individual'},
         ${opts.flagged ? '1234' : null}, ${opts.flagged ? 'ein' : null},
         ${actorId}, ${actorId})`)
  })
  return partyId
}

async function seedPayment(
  org: Org,
  actorId: string,
  partyId: string,
  amount: string,
  taxYear: number,
): Promise<void> {
  const paymentId = randomUUID()
  const entryId = randomUUID()
  const date = `${taxYear}-07-15`
  await withBypassContext(async () => {
    // Document and entry reference each other, so the document lands first
    // unlinked, then the entry, then the link — the same order the
    // information-returns engine fixture uses.
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency,
         subtotal, tax_total, total, custom, created_by, updated_by)
      values
        (${paymentId}, ${org.orgId}, 'vendor_payment', 'approved',
         ${`IR-READY-${taxYear}-${amount}-${partyId.slice(0, 8)}`}, ${org.subsidiaryId}, ${partyId},
         ${date}, ${date}, 'CAD',
         ${amount}, '0', ${amount},
         ${JSON.stringify({ bankAccountId: org.accounts.bank })}::jsonb,
         ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, source_document_id, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`IR-READY-${taxYear}-${amount}`}, ${date}, ${org.periodId},
         'Readiness fixture', 'draft', ${paymentId}, 'document',
         ${actorId}, ${actorId})`)
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, party_id, is_open_item, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.ap}, ${org.subsidiaryId}, ${amount},
         'CAD', ${amount}, 1, ${partyId}, true, 'Readiness control'),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.bank}, ${org.subsidiaryId}, ${`-${amount}`},
         'CAD', ${`-${amount}`}, 1, null, false, 'Readiness cash')`)
    // Lines before posting: a posted entry must already balance.
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId}
       where org_id = ${org.orgId} and id = ${entryId}`)
    await db.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${entryId},
             posting_period_id = ${org.periodId}
       where org_id = ${org.orgId} and id = ${paymentId}`)
  })
}

const names = (rows: Array<{ vendorName: string }>) => rows.map((r) => r.vendorName)

test(
  'readiness judges the unflagged threshold by form and year',
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'IR reader', 'ir_readiness'))
      // One vendor paid $1,500 under both laws; one paid $2,500 under 2026 law;
      // one T4A vendor paid $550; one flagged-and-ready vendor that must never queue.
      const nec1500 = await seedVendor(org, actorId, { form: '1099-NEC', flagged: false })
      const nec2500 = await seedVendor(org, actorId, { form: '1099-NEC', flagged: false })
      const t4a550 = await seedVendor(org, actorId, { form: 'T4A', flagged: false })
      const ready = await seedVendor(org, actorId, { form: '1099-NEC', flagged: true })
      await seedPayment(org, actorId, nec1500, '1500', 2025)
      await seedPayment(org, actorId, nec1500, '1500', 2026)
      await seedPayment(org, actorId, nec2500, '2500', 2026)
      await seedPayment(org, actorId, t4a550, '550', 2026)
      await seedPayment(org, actorId, ready, '5000', 2026)

      const queue2025 = await withOrgContext(org.orgId, () => loadInformationReturnReadiness(org.orgId, 2025))
      assert.ok(
        names(queue2025).some((n) => n.includes(nec1500.slice(0, 8))),
        'a $1,500 unflagged NEC vendor is questioned for 2025 (the $600 law)',
      )

      const queue2026 = await withOrgContext(org.orgId, () => loadInformationReturnReadiness(org.orgId, 2026))
      const queued = names(queue2026)
      assert.ok(
        !queued.some((n) => n.includes(nec1500.slice(0, 8))),
        'a $1,500 unflagged NEC vendor is not questioned for 2026 (the $2,000 law)',
      )
      assert.ok(
        queued.some((n) => n.includes(nec2500.slice(0, 8))),
        'a $2,500 unflagged NEC vendor is questioned for 2026',
      )
      assert.ok(
        queued.some((n) => n.includes(t4a550.slice(0, 8))),
        'a $550 unflagged T4A vendor is questioned (the $500 rule)',
      )
      assert.ok(
        !queued.some((n) => n.includes(ready.slice(0, 8))),
        'a flagged vendor with a TIN and a form never queues',
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)
