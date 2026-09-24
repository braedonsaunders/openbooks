import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// The drill route reads posted ledger and document rows through the real
// database and the real FX flow path, so amounts reach the tests below
// exactly as Postgres returns them. Only the auth boundary is stubbed: the
// gate returns the scratch org with an unrestricted subsidiary scope, in the
// same { user, permissions, allowedSubsidiaryIds } shape the real
// guardPermission produces, and the suite sets the org per test through the
// shared gate state.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../lib/authz') {
      return { shortCircuit: true, url: 'mock:drill-gate' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:drill-gate') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const key = Symbol.for('openbooks.analytics-drill-gate')
          export async function guardPermission() {
            const gate = globalThis[key]
            if (!gate) throw new Error('drill gate org is not set for this test')
            return gate
          }`,
      }
    }
    return nextLoad(url, context)
  },
})

const gateKey = Symbol.for('openbooks.analytics-drill-gate')
const setGateOrg = (orgId: string) => {
  ;(globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
    user: { id: 'drill-test', orgId },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: null,
  }
}

const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { GET } = await import('../app/api/analytics/drill/route.ts')

// numeric(19,4) stays a string end to end: 123456789012345.6789 would arrive
// as 123456789012345.68 through any IEEE-754 coercion, so the exact string is
// the assertion, not a rounded number.
const EXACT_AMOUNT = '123456789012345.6789'
const EXACT_TOTAL = '98765432109876.5432'

test('analytics drill GET serializes account amounts without numeric coercion', async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    setGateOrg(scratch.orgId)
    const accountId = randomUUID()
    const offsetAccountId = randomUUID()
    const entryId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active)
        values
          (${accountId}, ${scratch.orgId}, 'DRL-D1', 'Drill decimal account', 'asset_bank', false, true),
          (${offsetAccountId}, ${scratch.orgId}, 'DRL-D2', 'Drill decimal offset', 'income', false, true)
      `)
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values
          (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'DRILL-1',
           ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
      `)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${scratch.orgId}, ${entryId}, 1, ${accountId}, ${scratch.subsidiaryId}, ${EXACT_AMOUNT}, 'CAD', ${EXACT_AMOUNT}, '1'),
          (${scratch.orgId}, ${entryId}, 2, ${offsetAccountId}, ${scratch.subsidiaryId}, '-123456789012345.6789', 'CAD', '-123456789012345.6789', '1')
      `)
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now()
         where id = ${entryId} and org_id = ${scratch.orgId}
      `)
    })

    const response = await GET(
      new Request(
        `https://books.example.test/api/analytics/drill?account=${accountId}&from=2026-07-01&to=2026-07-31`,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      currency: string
      total: string
      entries: { amount: string }[]
      monthly: { month: string; amount: string }[]
      breakdown: { name: string; amount: string }[]
    }
    assert.equal(body.currency, 'CAD')
    assert.equal(body.total, EXACT_AMOUNT)
    assert.equal(body.entries[0]?.amount, EXACT_AMOUNT)
    assert.deepEqual(body.monthly, [{ month: '2026-07', amount: EXACT_AMOUNT }])
    assert.deepEqual(body.breakdown, [{ name: 'No party', amount: EXACT_AMOUNT, count: 1 }])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('analytics drill GET serializes party document totals without numeric coercion', async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    setGateOrg(scratch.orgId)
    const actorId = (await withBypass(() => seedFlowActors(scratch.orgId))).adminId
    const docId = randomUUID()
    const entryId = randomUUID()
    await withBypass(async () => {
      const debitAccountId = randomUUID()
      const creditAccountId = randomUUID()
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active)
        values
          (${debitAccountId}, ${scratch.orgId}, 'DRL-P1', 'Drill party debit', 'asset_bank', false, true),
          (${creditAccountId}, ${scratch.orgId}, 'DRL-P2', 'Drill party credit', 'income', false, true)
      `)
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values
          (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'DRILL-INV-1',
           ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')
      `)
      await db.execute(sql`
        insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${scratch.orgId}, ${entryId}, 1, ${debitAccountId}, ${scratch.subsidiaryId}, '1.0000', 'CAD', '1.0000', '1'),
          (${scratch.orgId}, ${entryId}, 2, ${creditAccountId}, ${scratch.subsidiaryId}, '-1.0000', 'CAD', '-1.0000', '1')
      `)
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now()
         where id = ${entryId} and org_id = ${scratch.orgId}
      `)
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, subtotal, tax_total, total, created_by, fx_rate, posted_entry_id, posting_period_id)
        values (${docId}, ${scratch.orgId}, 'customer_invoice', 'posted', 'DRILL-INV-1', ${scratch.subsidiaryId},
                ${scratch.customerId}, ${scratch.date}, 'CAD', ${EXACT_TOTAL}, '0', ${EXACT_TOTAL}, ${actorId}, '1',
                ${entryId}, ${scratch.periodId})
      `)
    })

    const response = await GET(
      new Request(
        `https://books.example.test/api/analytics/drill?party=${scratch.customerId}&from=2026-07-01&to=2026-07-31`,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      currency: string
      total: string
      entries: { amount: string }[]
      breakdown: { name: string; amount: string }[]
    }
    assert.equal(body.currency, 'CAD')
    assert.equal(body.total, EXACT_TOTAL)
    assert.equal(body.entries[0]?.amount, EXACT_TOTAL)
    assert.equal(body.breakdown[0]?.amount, EXACT_TOTAL)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('analytics drill rejects malformed account and party selectors before querying', async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    setGateOrg(scratch.orgId)
    const accountResponse = await GET(
      new Request('https://books.example.test/api/analytics/drill?account=not-a-uuid&from=2026-07-01&to=2026-07-31'),
    )
    assert.equal(accountResponse.status, 404)

    const partyResponse = await GET(
      new Request('https://books.example.test/api/analytics/drill?party=not-a-uuid&from=2026-07-01&to=2026-07-31'),
    )
    assert.equal(partyResponse.status, 404)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
