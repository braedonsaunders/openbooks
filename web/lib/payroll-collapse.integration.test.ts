import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * PAYCONF-c/d/e (collapse semantics): payroll legs arrive pre-collapsed per
 * (entry, account) in the entity FROM — before any caller filter, breakout,
 * grouping, sort, or LIMIT, in every mode — so no rows-mode projection (with
 * or without identity keys), limit:1 plan, amount section split, amount
 * equality oracle, sort, or summarize amount-breakout can return a
 * pre-collapse per-employee row or isolate an individual amount. Totals tie
 * out by construction; the grant restores full detail.
 *
 * Two employees share one pay-run journal/account with distinct net pays.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, pool, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
// runCustomQuery directly: the web executeReport wrapper needs a Next request
// scope (cookies) for locale/feature prep, which tests lack.
const { runCustomQuery } = (await import(root + 'packages/reports/src/run.ts')) as typeof import('@openbooks/reports')
const { REPORT_ENTITY_MAP } = (await import(root + 'packages/reports/src/entities.ts')) as typeof import('@openbooks/reports')
const { PAYROLL_RESTRICTED_PARTY_LABEL, payrollRestrictedEntity } = (await import(root + 'packages/reports/src/confidential-entities.ts')) as typeof import('@openbooks/reports')

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
  // Status stays non-posted: a posted document must reference its posted
  // entry, and the collapse keys on kind, not status.
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
    values (${payDoc}, ${org.orgId}, 'pay_run', 'PAY-1', ${org.date}, ${org.date}, ${org.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`)
  // One balanced pay-run entry: both employees' net-pay legs on the SAME
  // payable account, offset to wages expense.
  const entryId = randomUUID()
  // Draft first: the posted-balance trigger requires at least two balanced
  // lines to exist before an entry may post.
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PAY-1', ${org.date}, ${org.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`)
  // Net-pay legs are credits (negative), offset by the wage-expense debit —
  // the posting sign convention. The entry balances: -4842.17 + -5210.44 +
  // 10052.61 = 0.
  await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
    values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${org.date})`)
  // One ordinary (non-payroll) line on the same account proves the collapse
  // merges payroll legs only, not the account.
  const plainId = randomUUID()
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${plainId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PLAIN-1', ${org.date}, ${org.periodId}, 'plain', 'draft', 'manual')`)
  await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
    values (${randomUUID()}, ${org.orgId}, ${plainId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, null, false, 100, 'USD', 100, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${plainId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, -100, 'USD', -100, 1, ${org.date})`)
  await db.execute(sql`update journal_entries set status = 'posted' where id in (${entryId}, ${plainId}) and org_id = ${org.orgId}`)
}

const LEDGER = 'ledger_lines'

function baseOpts(org: Org, canSeePayroll: boolean) {
  return {
    entityMap: {
      ...REPORT_ENTITY_MAP,
      [LEDGER]: payrollRestrictedEntity(REPORT_ENTITY_MAP[LEDGER]!, canSeePayroll),
    },
    orgId: org.orgId,
  }
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

test('rows mode without key columns collapses to the entry total', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const result = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
    }, baseOpts(org, false))
    assert.equal(leakedIdentity(result.groups), null, 'payroll identity leaked through a keyless projection')
    assert.equal(leakedAmount(result.groups), null, 'a pre-collapse per-employee amount leaked')
    const text = JSON.stringify(result.groups)
    assert.ok(text.includes(PAYROLL_RESTRICTED_PARTY_LABEL), 'the collapsed row must carry the restricted label')
    // The ordinary line on the same account stays visible.
    assert.ok(text.includes('100'), 'non-payroll rows must survive the collapse')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('limit:1 with an ascending amount sort returns the collapsed row', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const result = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
      sorts: [{ column: 'amount', direction: 'asc' }], limit: 1,
    }, baseOpts(org, false))
    assert.equal(leakedIdentity(result.groups), null, 'limit:1 isolated an individual pay')
    assert.equal(leakedAmount(result.groups), null, 'limit:1 isolated an individual amount')
    assert.ok(JSON.stringify(result.groups).includes(PAYROLL_RESTRICTED_PARTY_LABEL))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test("groupBy:'amount' with all identity keys yields entry totals only", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const result = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'rows',
      columns: ['posting_date', 'party_name', 'amount', 'entry_id', 'account_id', 'party_id'],
      groupBy: 'amount',
    }, baseOpts(org, false))
    assert.equal(leakedIdentity(result.groups), null, 'an amount section carried an individual identity')
    assert.equal(leakedAmount(result.groups), null, 'an amount section carried an individual amount')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('an amount equality oracle matches only the entry total', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    // A leg amount matches no collapsed row.
    const missed = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
      filters: { combinator: 'and', rules: [{ field: 'amount', op: 'eq', value: `-${NET_A}` }] },
    }, baseOpts(org, false))
    assert.equal(missed.rowCount, 0, 'the amount oracle matched a payroll leg')
    // The entry total does match — as one collapsed row, naming no employee.
    const hit = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
      filters: { combinator: 'and', rules: [{ field: 'amount', op: 'eq', value: '-10052.61' }] },
    }, baseOpts(org, false))
    assert.equal(hit.rowCount, 1, 'the entry total must match its collapsed row')
    assert.equal(leakedIdentity(hit.groups), null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('summarize with an amount breakout forms entry-total buckets only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const result = await runCustomQuery(pool, {
      entity: LEDGER, mode: 'summarize', columns: [],
      breakouts: [{ column: 'amount' }], measures: [{ fn: 'count' }],
    }, baseOpts(org, false))
    assert.equal(leakedIdentity(result.groups), null, 'an amount bucket exposed an individual identity')
    assert.equal(leakedAmount(result.groups), null, 'an amount bucket exposed an individual amount')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('restricted and granted money tie out; the grant restores detail (control)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedPayroll(org))
    const q = { entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'] }
    const restricted = await runCustomQuery(pool, q, baseOpts(org, false))
    const granted = await runCustomQuery(pool, q, baseOpts(org, true))
    const sum = (groups: unknown): number =>
      JSON.stringify(groups).match(/-?\d+\.\d+/g)?.reduce((n, v) => n + Number(v), 0) ?? 0
    assert.equal(sum(restricted.groups), sum(granted.groups), 'restricted money must tie to granted money')
    const text = JSON.stringify(granted.groups)
    assert.ok(text.includes(NET_A) && text.includes(NAME_A), 'granted control must see both employees')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
