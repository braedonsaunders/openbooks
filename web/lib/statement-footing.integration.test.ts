import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { balanceSheetView } = await import('./statement-matrix.ts')
const { balanceSheet, trialBalance } = await import('./reports/statements.ts')
const { decimalAdd } = await import('./statement-format.ts')

/**
 * F-t08-001: fixed-asset cost lines printed NET of their contra while the
 * contra printed again beside them — depreciation subtracted twice from
 * every visual sum (a cost account printed net of its contra while the
 * contra printed again, so displayed assets no longer footed to Total
 * Assets).
 * Gross presentation: each line shows its OWN balance, contras are sibling
 * lines, and the displayed asset lines foot exactly to Total Assets.
 */
test('balance sheet prints gross cost with contra and foots to total assets', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const costId = randomUUID()
    const contraId = randomUUID()
    const groupId = randomUUID()
    const hwId = randomUUID()
    const groupContraId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type)
        values (${costId}, ${scratch.orgId}, '1520', 'Vehicles', 'asset_fixed'),
               (${contraId}, ${scratch.orgId}, '1525', 'Accum Amort - Vehicles', 'asset_fixed')`)
      await db.execute(sql`update accounts set parent_id = ${costId} where id = ${contraId}`)
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary)
        values (${groupId}, ${scratch.orgId}, '1540', 'Computers', 'asset_fixed', true),
               (${hwId}, ${scratch.orgId}, '1542', 'Hardware', 'asset_fixed', false),
               (${groupContraId}, ${scratch.orgId}, '1545', 'Accum Amort - Computer', 'asset_fixed', false)`)
      await db.execute(sql`update accounts set parent_id = ${groupId} where id in (${hwId}, ${groupContraId})`)
      const post = async (tag: string, debit: string, credit: string, amount: string) => {
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
            ${tag}, ${scratch.date}, ${scratch.periodId}, ${tag}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${scratch.orgId}, ${entry}, 1, ${debit}, ${scratch.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${scratch.orgId}, ${entry}, 2, ${credit}, ${scratch.subsidiaryId}, ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
      await post('FOOT-COST', costId, scratch.accounts.bank, '1000')
      await post('FOOT-AMORT', scratch.accounts.cogs, contraId, '400')
      await post('FOOT-HW', hwId, scratch.accounts.bank, '300')
      await post('FOOT-HWAMORT', scratch.accounts.cogs, groupContraId, '100')
    })

    const labels = {
      assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
      totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', totalEquity: 'Total equity',
      accumulatedEarnings: 'Accumulated earnings', translationAdjustment: 'Translation adjustment',
      liabilitiesAndEquity: 'Liabilities and equity', totalOf: (s: string) => `Total ${s}`,
    }
    const view = await withBypassContext(() => balanceSheetView(
      { from: '2026-07-01', to: scratch.date }, 'July 2026', labels, { orgId: scratch.orgId },
    ))
    const assetsIdx = view.lines.findIndex((l) => l.kind === 'section' && l.label === 'Assets')
    const totalIdx = view.lines.findIndex((l) => l.label === 'Total assets')
    assert.ok(assetsIdx >= 0 && totalIdx > assetsIdx, 'asset section exists')
    const assetLines = view.lines
      .slice(assetsIdx + 1, totalIdx)
      .filter((l) => l.kind === 'account' && (l.values?.length ?? 0) > 0)
    const totalValues = view.lines[totalIdx]?.values?.[0]
    assert.ok(totalValues, 'total assets line exists')
    // The cost line ties to the trial balance (gross), the contra prints beside it.
    const byLabel = new Map(assetLines.map((l) => [l.label, l.values?.[0]]))
    assert.equal(byLabel.get('Vehicles'), '1000.0000')
    assert.equal(byLabel.get('Accum Amort - Vehicles'), '-400.0000')
    assert.equal(byLabel.get('Hardware'), '300.0000')
    assert.equal(byLabel.get('Accum Amort - Computer'), '-100.0000')
    // Displayed asset lines foot exactly to Total Assets.
    let displayed = '0.0000'
    for (const line of assetLines) displayed = decimalAdd(displayed, line.values?.[0] ?? '0.0000')
    assert.equal(displayed, totalValues)

    // The scalar statement agrees: cost line ties the trial balance.
    const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
    const tbCost = tb.find((r) => r.number === '1520')
    assert.equal(tbCost?.balance, '1000.0000')
    const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
    const bsCost = bs.assets.find((r) => r.number === '1520')
    assert.equal(bsCost?.balance, '1000.0000')
    let scalarDisplayed = '0.0000'
    for (const r of bs.assets) scalarDisplayed = decimalAdd(scalarDisplayed, r.balance)
    assert.equal(scalarDisplayed, bs.totalAssets)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
