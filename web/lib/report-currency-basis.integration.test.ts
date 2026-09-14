import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { generalLedger, journalReport } = await import('./reports/ledger-reports')
const { accountRegister, partyRegister, partnerStatement } = await import('./reports/registers')
const { trialBalance, profitAndLoss, balanceSheet, partnerBalances } = await import('./reports/statements')
const { cashFlow } = await import('./reports/cash-flow')
const { cashFlowIndirect } = await import('./reports/cash-flow-indirect')
const { projectProfitability } = await import('./reports/projects')

test('raw report readers refuse mixed functional currencies and preserve native single-currency scopes', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const child = randomUUID()
  try {
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${child}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'USD entity', 'USD', 'US')`)
      for (const [subsidiary, currency, code] of [[scratch.subsidiaryId, 'CAD', 'CAD'], [child, 'USD', 'USD']]) {
        const entry = randomUUID(), project = randomUUID()
        await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
          values (${project}, ${scratch.orgId}, ${subsidiary}, ${code}, ${code}, ${scratch.customerId}, 'active', true)`)
        await db.execute(sql`insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${subsidiary}, ${code}, ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, party_id, amount, currency, txn_amount, fx_rate)
          values (${scratch.orgId}, ${entry}, 1, ${scratch.accounts.bank}, ${subsidiary}, ${project}, ${scratch.customerId}, '100', ${currency}, '100', '1'),
            (${scratch.orgId}, ${entry}, 2, ${scratch.accounts.ar}, ${subsidiary}, ${project}, ${scratch.customerId}, '100', ${currency}, '100', '1'),
            (${scratch.orgId}, ${entry}, 3, ${scratch.accounts.revenue}, ${subsidiary}, ${project}, ${scratch.customerId}, '-200', ${currency}, '-200', '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
    })
    const org = scratch.orgId, day = scratch.date, book = scratch.bookId
    const readers: Record<string, (subsidiaryIds: string[]) => Promise<unknown>> = {
      ledger: (subsidiaryIds) => generalLedger(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
      journal: (subsidiaryIds) => journalReport(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
      register: (ids) => accountRegister(org, scratch.accounts.ar, 100, 0, undefined, new Set(ids), book),
      parties: (subsidiaryIds) => partyRegister('ar', { orgId: org, bookId: book, from: day, to: day, dims: { subsidiaryIds } }),
      statement: (subsidiaryIds) => partnerStatement(scratch.customerId, org, { from: day, to: day, side: 'ar', bookId: book, dims: { subsidiaryIds } }),
      trial: (subsidiaryIds) => trialBalance(day, { subsidiaryIds }, org, book),
      pnl: (subsidiaryIds) => profitAndLoss(day, day, { subsidiaryIds }, org, book),
      balance: (subsidiaryIds) => balanceSheet(day, org, book, { subsidiaryIds }),
      partners: (subsidiaryIds) => partnerBalances('receivable', org, day, book, { subsidiaryIds }),
      cash: (subsidiaryIds) => cashFlow(day, day, { subsidiaryIds }, org, book),
      indirect: (subsidiaryIds) => cashFlowIndirect(day, day, { subsidiaryIds }, org, book),
      projects: (subsidiaryIds) => projectProfitability(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
    }
    for (const [name, read] of Object.entries(readers)) {
      await assert.rejects(() => read([scratch.subsidiaryId, child]), { name: 'ReportCurrencyBasisError' }, name)
      await read([scratch.subsidiaryId])
      await read([child])
      await read([])
    }
    const cad = await generalLedger(day, day, { orgId: org, dims: { subsidiaryIds: [scratch.subsidiaryId] } })
    assert.equal(cad.accounts.find((account) => account.id === scratch.accounts.revenue)?.closing, '-200.0000')
    const usd = await trialBalance(day, { subsidiaryIds: [child] }, org)
    assert.equal(usd.find((account) => account.id === scratch.accounts.ar)?.balance, '100.0000')
    // An unused second currency cannot block an earlier empty report.
    await generalLedger('2000-01-01', '2000-01-02', { orgId: org })
    // The raw-line (non-summary) branch observes the same dimension scope.
    await profitAndLoss(day, day, { subsidiaryIds: [scratch.subsidiaryId, child], departmentId: randomUUID() }, org)
    await trialBalance(day, { subsidiaryIds: [scratch.subsidiaryId, child], departmentId: randomUUID() }, org)
  } finally { await withBypass(() => dropScratchOrg(scratch.orgId)) }
})
