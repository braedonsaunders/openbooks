import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * A cash disposal's gain/loss is part of investing proceeds, not operating
 * cash flow: the indirect statement reclassifies the P&L leg of cash
 * disposal entries from operating into investing (gross proceeds = NBV
 * movement + gain). The direct statement must classify it identically —
 * otherwise the two statements' operating and investing sections disagree
 * while both still tie.
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
const { toUnits } = (await import(root + 'engine/src/money.ts')) as typeof import('@openbooks/engine/src/money.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { cashFlow, cashFlowIndirect } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')

test('direct cash flow presents cash disposal gains as investing proceeds', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      const equipmentId = randomUUID()
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${equipmentId}, ${org.orgId}, '1500', 'Equipment', 'asset_fixed', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
      // Cash sale of equipment: NBV 100, proceeds 120, gain 20.
      const entryId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'DISP-CASH', ${org.date}, ${org.periodId}, 'DISP-CASH', 'draft', 'disposal', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 120.00, 'CAD', 120.00, 1, false),
          (${org.orgId}, ${entryId}, 2, ${equipmentId}, ${org.subsidiaryId}, -100.00, 'CAD', -100.00, 1, false),
          (${org.orgId}, ${entryId}, 3, ${org.accounts.fxGainLoss}, ${org.subsidiaryId}, -20.00, 'CAD', -20.00, 1, false)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`)
      // A genuine operating cash expense through the SAME gain/loss account:
      // reclassification must move only the disposal leg, never this one.
      const opexId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values (${opexId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'OPEX-CASH', ${org.date}, ${org.periodId}, 'OPEX-CASH', 'draft', 'manual', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${opexId}, 1, ${org.accounts.fxGainLoss}, ${org.subsidiaryId}, 5.00, 'CAD', 5.00, 1, false),
          (${org.orgId}, ${opexId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, -5.00, 'CAD', -5.00, 1, false)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${opexId}`)
    })
    await withOrgContext(org.orgId, async () => {
      const from = '2026-07-01', to = '2026-07-31'
      const direct = await cashFlow(from, to, undefined, org.orgId)
      const operating = direct.sections.find((s) => s.section === 'operating')!
      const investing = direct.sections.find((s) => s.section === 'investing')!
      // Gross proceeds (120) belong in investing; operating holds the real 5.00
      // cash expense from the shared gain account, never the disposal gain.
      assert.equal(toUnits(operating.subtotal), toUnits('-5.0000'), `direct operating misclassifies: ${JSON.stringify(operating.lines)}`)
      assert.equal(toUnits(investing.subtotal), toUnits('120.0000'), `direct investing must show gross proceeds: ${JSON.stringify(investing.lines)}`)
      assert.equal(toUnits(direct.netChange), toUnits('115.0000'))
      assert.equal(toUnits(direct.reconciliationGap), 0n, `direct statement must tie: gap ${direct.reconciliationGap}`)
      const indirect = await cashFlowIndirect(from, to, undefined, org.orgId)
      assert.equal(toUnits(indirect.operating), toUnits(operating.subtotal), 'indirect and direct operating disagree')
      assert.equal(toUnits(indirect.investingTotal), toUnits(investing.subtotal), 'indirect and direct investing disagree')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
