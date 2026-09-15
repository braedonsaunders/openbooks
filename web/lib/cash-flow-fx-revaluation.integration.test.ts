import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Unrealized FX revaluation (origin 'fx_revaluation') is non-cash
 * re-measurement: its P&L leg must be added back out of operating and its
 * foreign-currency bank legs must surface as the effect of exchange-rate
 * changes on cash — never as operating cash flow. The statement still ties
 * either way (both errors land in the total), so the assertions pin the
 * classification, not just the reconciliation gap.
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
const { runRevaluation } = (await import(root + 'engine/src/fx-revaluation.ts')) as typeof import('@openbooks/engine/src/fx-revaluation.ts')
const { cashFlowIndirect } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')

test('indirect cash flow adds back unrealized FX revaluation and reports foreign-cash remeasurement as the FX effect', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`)
      await db.execute(sql`
        update orgs set settings = settings || jsonb_build_object('controlAccounts',
          coalesce(settings->'controlAccounts', '{}'::jsonb) ||
          jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
        where id=${org.orgId}`)
      // The mandatory reversal needs a following period to land in.
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
          from accounting_periods where id = ${org.periodId}`)
      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
        values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`)
      // USD 100 of foreign-currency cash carried at the historical 1.36.
      const entryId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'USD-BANK-SEED', '2026-07-10', ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 136.00, 'USD', 100.00, 1.36, false),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -136.00, 'CAD', -136.00, 1, false)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`)
      const run = await withOrgContext(org.orgId, () => runRevaluation(org.orgId, org.periodId, actorId))
      assert.deepEqual(run.problems, [], 'revaluation must post cleanly')
      assert.equal(run.posted.length, 1, 'one subsidiary revalued')
      assert.equal(run.posted[0]?.netDelta, '1.0000', 'period-end spot 1.37 restates the bank balance +1.00 CAD')
    })
    await withOrgContext(org.orgId, async () => {
      const cf = await cashFlowIndirect('2026-07-01', '2026-07-31', undefined, org.orgId)
      // Net income still carries the unrealized gain (it is P&L activity).
      assert.equal(toUnits(cf.netIncome), toUnits('1.0000'), `net income must include the unrealized gain, got ${cf.netIncome}`)
      // …but operating adds it back: unrealized remeasurement is not cash.
      const unrealized = cf.adjustments.find((line) => line.key === 'unrealizedFx')
      assert.ok(unrealized, `unrealized FX add-back missing: ${JSON.stringify(cf.adjustments)}`)
      assert.equal(toUnits(unrealized.amount), toUnits('-1.0000'), `add-back must remove the gain from operating, got ${unrealized.amount}`)
      assert.equal(toUnits(cf.operating), toUnits('136.0000'), `operating must exclude the unrealized gain, got ${cf.operating}`)
      // The bank-balance leg is the effect of exchange-rate changes on cash.
      assert.equal(toUnits(cf.fxEffectOnCash), toUnits('1.0000'), `FX effect on cash must carry the bank remeasurement, got ${cf.fxEffectOnCash}`)
      // The statement still ties to the proven bank movement.
      assert.equal(toUnits(cf.netChange), toUnits('137.0000'))
      assert.equal(toUnits(cf.closingCash), toUnits('137.0000'))
      assert.equal(toUnits(cf.reconciliationGap), 0n, `statement must tie: gap ${cf.reconciliationGap}`)

      // The August mirror reverses the classification symmetrically.
      const august = await cashFlowIndirect('2026-08-01', '2026-08-31', undefined, org.orgId)
      assert.equal(toUnits(august.netIncome), toUnits('-1.0000'), `reversal posts the mirror loss, got ${august.netIncome}`)
      assert.equal(toUnits(august.operating), toUnits('0.0000'), `mirror add-back must clear operating, got ${august.operating}`)
      assert.equal(toUnits(august.fxEffectOnCash), toUnits('-1.0000'), `mirror FX effect, got ${august.fxEffectOnCash}`)
      assert.equal(toUnits(august.reconciliationGap), 0n, `mirror month must tie: gap ${august.reconciliationGap}`)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
