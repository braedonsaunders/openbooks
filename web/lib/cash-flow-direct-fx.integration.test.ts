import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Direct-method sibling of the indirect FX-revaluation contract: an
 * unrealized restatement of foreign-currency cash is not a cash receipt, so
 * the P&L contra leg of an fx_revaluation bank entry must not enter the
 * operating section. It belongs on the effect-of-exchange-rate-changes line,
 * and the two cash-flow statements must classify it identically.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { runRevaluation } = (await import(root + 'engine/src/close/fx-revaluation.ts')) as typeof import('@openbooks/engine/src/close/fx-revaluation.ts')
const { cashFlow, cashFlowIndirect } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')

test('direct cash flow routes unrealized FX revaluation of cash to the FX-effect line', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
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
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
          from accounting_periods where id = ${org.periodId}`)
      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
        values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`)
      // USD 100 of foreign-currency cash carried at the historical 1.36,
      // funded by a CAD 136 cash sale so operating has a real baseline.
      const seedId = randomUUID()
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
        values (${seedId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'USD-BANK-SEED', '2026-07-10', ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${seedId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 136.00, 'USD', 100.00, 1.36, false),
          (${org.orgId}, ${seedId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, -136.00, 'CAD', -136.00, 1, false)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${seedId}`)
      const run = await withOrgContext(org.orgId, () => runRevaluation(org.orgId, org.periodId, actorId))
      assert.deepEqual(run.problems, [], 'revaluation must post cleanly')
    })
    await withOrgContext(org.orgId, async () => {
      const direct = await cashFlow('2026-07-01', '2026-07-31', undefined, org.orgId)
      const operating = direct.sections.find((s) => s.section === 'operating')!
      // Real cash baseline: the 136.00 sale. The +1.00 unrealized restatement
      // of the bank balance is not a receipt from customers.
      assert.equal(toUnits(operating.subtotal), toUnits('136.0000'), `direct operating books the unrealized gain as cash: ${JSON.stringify(operating.lines)}`)
      assert.equal(toUnits(direct.fxEffectOnCash), toUnits('1.0000'), `direct FX effect must carry the bank remeasurement, got ${direct.fxEffectOnCash}`)
      assert.equal(toUnits(direct.netChange), toUnits('137.0000'))
      assert.equal(toUnits(direct.reconciliationGap), 0n, `direct statement must tie: gap ${direct.reconciliationGap}`)
      // The two cash-flow statements classify the remeasurement identically.
      const indirect = await cashFlowIndirect('2026-07-01', '2026-07-31', undefined, org.orgId)
      assert.equal(toUnits(indirect.operating), toUnits(operating.subtotal), 'indirect and direct operating disagree')
      assert.equal(toUnits(indirect.fxEffectOnCash), toUnits(direct.fxEffectOnCash), 'indirect and direct FX effect disagree')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
