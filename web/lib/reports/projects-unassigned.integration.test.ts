import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * F-t07-004: Project Profitability silently excludes journal lines with no
 * project assignment, so its totals do not tie to the P&L (SIM Aperture:
 * $356,971.24 of untagged subcontractor COGS missing; Rassaun: CA$6.0M of
 * untagged revenue missing). Untagged P&L activity must surface as an
 * explicit Unassigned row and be included in the report totals.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { projectProfitability } = (await import(root + 'web/lib/reports/projects.ts')) as typeof import('./projects')
const { decimalCmp } = (await import(root + 'web/lib/statement-format.ts')) as typeof import('../statement-format')

async function postBalanced(
  org: { orgId: string; subsidiaryId: string; bookId: string; periodId: string; date: string },
  lines: { accountId: string; projectId: string | null; amount: string }[],
  entryNumber: string,
) {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber},
       ${org.date}, ${org.periodId}, ${entryNumber}, 'draft', 'manual')`)
  // One multi-row INSERT: the balance trigger reads the whole entry.
  const values = lines.map(
    (line, index) =>
      sql`(${org.orgId}, ${entryId}, ${index + 1}, ${line.accountId}, ${org.subsidiaryId}, ${line.projectId}, ${line.amount}, 'CAD', ${line.amount}, '1')`,
  )
  const body = values.reduce((acc, v, i) => (i === 0 ? v : sql`${acc}, ${v}`))
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values ${body}`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
}

test('project profitability surfaces untagged P&L activity as an Unassigned row', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    let projectId = ''
    await withBypassContext(async () => {
      projectId = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-TIE',
                'Tie-out job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      // Tagged: 1000 revenue / 200 expense on the project.
      await postBalanced(org, [
        { accountId: org.accounts.revenue, projectId, amount: '-1000' },
        { accountId: org.accounts.bank, projectId: null, amount: '1000' },
      ], 'JE-TAG-REV')
      await postBalanced(org, [
        { accountId: org.accounts.adjustment, projectId, amount: '200' },
        { accountId: org.accounts.bank, projectId: null, amount: '-200' },
      ], 'JE-TAG-EXP')
      // Untagged: 500 revenue / 300 expense with no project assignment.
      await postBalanced(org, [
        { accountId: org.accounts.revenue, projectId: null, amount: '-500' },
        { accountId: org.accounts.bank, projectId: null, amount: '500' },
      ], 'JE-UNTAG-REV')
      await postBalanced(org, [
        { accountId: org.accounts.adjustment, projectId: null, amount: '300' },
        { accountId: org.accounts.bank, projectId: null, amount: '-300' },
      ], 'JE-UNTAG-EXP')
    })
    const result = await withOrgContext(org.orgId, () =>
      projectProfitability('2026-07-01', '2026-07-31', { orgId: org.orgId }),
    )
    const unassigned = result.rows.find((row) => row.projectId === 'unassigned')
    assert.ok(unassigned, 'untagged P&L activity must appear as an explicit Unassigned row')
    assert.equal(decimalCmp(unassigned.revenue, '500'), 0, 'unassigned revenue')
    assert.equal(decimalCmp(unassigned.expenses, '300'), 0, 'unassigned expenses')
    assert.equal(decimalCmp(unassigned.net, '200'), 0, 'unassigned net')
    assert.equal(unassigned.customerId, null)
    assert.equal(unassigned.hours, 0)
    // Totals tie to the full P&L scope: tagged + untagged.
    assert.equal(decimalCmp(result.totals.revenue, '1500'), 0, 'totals revenue ties to the P&L')
    assert.equal(decimalCmp(result.totals.expenses, '500'), 0, 'totals expenses tie to the P&L')
    assert.equal(decimalCmp(result.totals.net, '1000'), 0, 'totals net ties to the P&L')
    const tagged = result.rows.find((row) => row.projectId === projectId)
    assert.ok(tagged, 'tagged project row survives')
    assert.equal(decimalCmp(tagged.revenue, '1000'), 0)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId)).catch(() => {})
  }
})

test('project profitability omits the Unassigned row when everything is tagged', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const projectId = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-TAGGED',
                'Tagged job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await postBalanced(org, [
        { accountId: org.accounts.revenue, projectId, amount: '-1000' },
        { accountId: org.accounts.bank, projectId: null, amount: '1000' },
      ], 'JE-ONLY-TAGGED')
    })
    const result = await withOrgContext(org.orgId, () =>
      projectProfitability('2026-07-01', '2026-07-31', { orgId: org.orgId }),
    )
    assert.equal(result.rows.some((row) => row.projectId === 'unassigned'), false, 'no Unassigned row without untagged activity')
    assert.equal(decimalCmp(result.totals.revenue, '1000'), 0)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId)).catch(() => {})
  }
})
