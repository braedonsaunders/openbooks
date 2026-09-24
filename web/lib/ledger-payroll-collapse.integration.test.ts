import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * PAYCONF-c/d/e (collapse semantics): the interactive journal and GL account
 * detail collapse payroll legs per (entry, account) in the query itself —
 * before any order or limit — so a reader without payroll.read sees the
 * restricted label and entry totals but no employee name and no per-employee
 * amount. Balances tie out exactly; a reader WITH the grant sees everything
 * unchanged.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { generalLedger, journalReport } = (await import(root + 'web/lib/reports/ledger-reports.ts')) as typeof import('@/lib/reports/ledger-reports.ts')
const { PAYROLL_RESTRICTED_PARTY_LABEL } = (await import(root + 'web/lib/payroll-confidentiality.ts')) as typeof import('@/lib/payroll-confidentiality.ts')

type Org = Awaited<ReturnType<typeof createScratchOrg>>

const NET_A = '4842.17'
const NET_B = '5210.44'
const NAME_A = 'Avery Employee'
const NAME_B = 'Blake Employee'

async function seedPayroll(org: Org) {
  const empA = randomUUID()
  const empB = randomUUID()
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
    values (${empA}, ${org.orgId}, 'employee', ${NAME_A}, ${org.subsidiaryId}),
           (${empB}, ${org.orgId}, 'employee', ${NAME_B}, ${org.subsidiaryId})`)
  const payDoc = randomUUID()
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
    values (${payDoc}, ${org.orgId}, 'pay_run', 'PAY-1', ${org.date}, ${org.date}, ${org.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`)
  const entryId = randomUUID()
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PAY-1', ${org.date}, ${org.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`)
  await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
    values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${org.date})`)
  await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`)
}

function leakedIdentity(payload: unknown): string | null {
  const text = JSON.stringify(payload)
  for (const secret of [NAME_A, NAME_B]) {
    if (text.includes(secret)) return secret
  }
  return null
}

function leakedAmount(payload: unknown): string | null {
  const text = JSON.stringify(payload)
  for (const secret of [NET_A, NET_B]) {
    if (text.includes(secret)) return secret
  }
  return null
}

test('journal collapses the pay-run entry without the grant', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const base = { dims: {}, orgId: org.orgId, bookId: org.bookId }
    const hidden = await withBypassContext(() => journalReport(org.date, org.date, { ...base, canSeePayroll: false }))
    assert.equal(leakedIdentity(hidden.entries), null, 'journal lines leaked an individual identity')
    assert.equal(leakedAmount(hidden.entries), null, 'journal lines leaked an individual amount')
    assert.ok(JSON.stringify(hidden.entries).includes(PAYROLL_RESTRICTED_PARTY_LABEL))

    const shown = await withBypassContext(() => journalReport(org.date, org.date, { ...base, canSeePayroll: true }))
    const text = JSON.stringify(shown.entries)
    assert.ok(text.includes(NET_A) && text.includes(NAME_A), 'granted journal must show both employees')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('GL collapses pay-run lines but keeps exact balances without the grant', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const base = { accountId: org.accounts.ap, dims: {}, orgId: org.orgId, bookId: org.bookId }
    const hidden = await withBypassContext(() => generalLedger(org.date, org.date, { ...base, canSeePayroll: false }))
    assert.equal(leakedIdentity(hidden.accounts), null, 'GL lines leaked an individual identity')
    assert.equal(leakedAmount(hidden.accounts), null, 'GL lines leaked an individual amount')
    // The payable account still lists with its full closing balance.
    const ap = hidden.accounts.find((a) => a.id === org.accounts.ap)
    assert.ok(ap, 'the payable account must still list with its balances')
    assert.equal(ap!.closing, '-10052.6100')
    // Balances tie with the granted reader's.
    const shown = await withBypassContext(() => generalLedger(org.date, org.date, { ...base, canSeePayroll: true }))
    const shownAp = shown.accounts.find((a) => a.id === org.accounts.ap)
    assert.equal(shownAp!.closing, ap!.closing, 'restricted balances must tie to granted balances')
    assert.ok(JSON.stringify(shown.accounts).includes(NET_B), 'granted GL must show employee lines')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
