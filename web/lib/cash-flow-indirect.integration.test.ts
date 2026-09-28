import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/platform/db.ts";

test("indirect cash flow ties to bank balances and net income", { skip: !env.OPENBOOKS_DB_URL }, () => {
  // Web report modules intentionally import `server-only`, so the contract
  // runs in React's server condition (same pattern as reports-posted.test.ts).
  const source = `
    import assert from "node:assert/strict";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { cashFlowIndirect, financialTrends } from "./web/lib/reports.ts";

    // Persistent application tenants only — scratch orgs come and go in
    // parallel test files and would race fixture teardown.
    const orgs = await db.execute(sql\`
      select o.id from orgs o
       where exists (select 1 from users u where u.org_id = o.id and u.is_active)
       order by o.id
    \`);
    for (const org of orgs.rows) {
      await withOrg(org.id, async () => {
        const trends = await financialTrends(org.id, 15);
        for (const period of trends) {
          const cf = await cashFlowIndirect(period.starts_on, period.ends_on);

          // The statement reconciles to the proven bank-balance movement.
          assert.ok(
            (toUnits(cf.reconciliationGap) < 0n ? -toUnits(cf.reconciliationGap) : toUnits(cf.reconciliationGap)) < 50n,
            org.id + " " + period.name + " reconciliation gap " + cf.reconciliationGap,
          );

          // Sections assemble to the net change.
          const assembled = [cf.operating, cf.investingTotal, cf.financingTotal, cf.fxEffectOnCash]
            .reduce((sum, value) => sum + toUnits(value), 0n);
          assert.equal(assembled, toUnits(cf.netChange), org.id + " " + period.name + " section assembly");

          // Opening + change = closing.
          assert.ok(
            toUnits(cf.openingCash) + toUnits(cf.netChange) === toUnits(cf.closingCash),
            org.id + " " + period.name + " opening/closing tie",
          );

          // Net income is the posted P&L of the window, no more and no less.
          const expected = await db.execute(sql\`
            select coalesce(-sum(l.amount), 0)::text as ni
              from journal_lines l
              join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
              join accounts a on a.id = l.account_id
             where l.org_id = \${org.id}
               and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
               and e.posting_date >= \${period.starts_on} and e.posting_date <= \${period.ends_on}
          \`);
          assert.equal(
            toUnits(cf.netIncome),
            toUnits(expected.rows[0].ni),
            org.id + " " + period.name + " net income",
          );

          // Operating = NI + adjustments + working capital (line arithmetic).
          const op = [cf.netIncome, ...cf.adjustments.map((line) => line.amount), ...cf.workingCapital.map((line) => line.amount)]
            .reduce((sum, value) => sum + toUnits(value), 0n);
          assert.equal(op, toUnits(cf.operating), org.id + " " + period.name + " operating arithmetic");
        }
      });
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


const consolidatedRows = [
  { label: "cash flow direct disposal", register: async () => {
        const { pathToFileURL } = await import("node:url");
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { randomUUID } = await import("node:crypto");
        /**
         * A cash disposal's gain/loss is part of investing proceeds, not operating
         * cash flow: the indirect statement reclassifies the P&L leg of cash
         * disposal entries from operating into investing (gross proceeds = NBV
         * movement + gain). The direct statement must classify it identically —
         * otherwise the two statements' operating and investing sections disagree
         * while both still tie.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
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
  } },
  { label: "cash flow direct fx", register: async () => {
        const { pathToFileURL } = await import("node:url");
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { randomUUID } = await import("node:crypto");
        /**
         * Direct-method sibling of the indirect FX-revaluation contract: an
         * unrealized restatement of foreign-currency cash is not a cash receipt, so
         * the P&L contra leg of an fx_revaluation bank entry must not enter the
         * operating section. It belongs on the effect-of-exchange-rate-changes line,
         * and the two cash-flow statements must classify it identically.
         */
        const root = pathToFileURL(process.cwd() + '/').href
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
  } },
  { label: "cash flow fx revaluation", register: async () => {
        const { pathToFileURL } = await import("node:url");
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { randomUUID } = await import("node:crypto");
        /**
         * Unrealized FX revaluation (origin 'fx_revaluation') is non-cash
         * re-measurement: its P&L leg must be added back out of operating and its
         * foreign-currency bank legs must surface as the effect of exchange-rate
         * changes on cash — never as operating cash flow. The statement still ties
         * either way (both errors land in the total), so the assertions pin the
         * classification, not just the reconciliation gap.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { runRevaluation } = (await import(root + 'engine/src/close/fx-revaluation.ts')) as typeof import('@openbooks/engine/src/close/fx-revaluation.ts')
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
  } },
  { label: "cash flow scope", register: async () => {
        const { pathToFileURL } = await import("node:url");
        const assert = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { randomUUID } = await import("node:crypto");
        /**
         * RP3 — the indirect cash flow's summary-backed net-income and cash legs
         *       treated an EMPTY subsidiary allowlist (a restricted reader with
         *       nothing visible) as "no filter" and reported org-wide figures.
         * RP4 — the direct cash flow read every accounting book while its proof
         *       balances came from the primary book only, so a parallel book's mirror
         *       entries doubled the sections and broke the tie-out.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { cashFlow, cashFlowIndirect, generalLedger } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')

        test('cash flow statements answer for one book and fail closed on an empty subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          const taxBookId = randomUUID()
          try {
            await withBypassContext(async () => {
              await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
                values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax book', false, true, true)`)
              const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
              const junePeriodId = randomUUID()
              await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                values (${junePeriodId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${calendar.fiscal_calendar_id})`)
              const post = async (bookId: string, date: string, periodId: string, amount: string, tag: string) => {
                const entry = randomUUID()
                await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                  values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${tag}, ${date}, ${periodId}, ${tag}, 'draft', 'manual')`)
                await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                  values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                         (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
                await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
              }
              // Opening cash in June, July activity in the primary book, and a tax-book
              // mirror of the July activity (parallel book, same amount).
              await post(org.bookId, '2026-06-15', junePeriodId, '40.0000', 'CF-OPENING')
              await post(org.bookId, org.date, org.periodId, '100.0000', 'CF-PRIMARY')
              await post(taxBookId, org.date, org.periodId, '100.0000', 'CF-TAX-MIRROR')
            })
            await withOrgContext(org.orgId, async () => {
              const from = '2026-07-01', to = '2026-07-31'

              // RP4 — primary book by default: the mirror never reaches the sections.
              const primary = await cashFlow(from, to, undefined, org.orgId)
              const income = primary.sections.find((s) => s.section === 'operating')!.lines.find((l) => l.type === 'income')
              assert.equal(toUnits(income?.amount ?? '0'), toUnits('100.0000'), 'direct cash flow fused the tax book into operating income')
              assert.equal(toUnits(primary.openingCash), toUnits('40.0000'))
              assert.equal(toUnits(primary.closingCash), toUnits('140.0000'))
              assert.equal(toUnits(primary.reconciliationGap), 0n, `direct cash flow must tie: gap ${primary.reconciliationGap}`)
              // An explicit book reads that book everywhere (sections and proof legs).
              const tax = await cashFlow(from, to, undefined, org.orgId, taxBookId)
              assert.equal(toUnits(tax.netChange), toUnits('100.0000'))
              assert.equal(toUnits(tax.openingCash), 0n)
              assert.equal(toUnits(tax.closingCash), toUnits('100.0000'))
              assert.equal(toUnits(tax.reconciliationGap), 0n)
              const indirectTax = await cashFlowIndirect(from, to, undefined, org.orgId, taxBookId)
              assert.equal(toUnits(indirectTax.netIncome), toUnits('100.0000'))
              assert.equal(toUnits(indirectTax.reconciliationGap), 0n)

              // RP3 — an empty allowlist reads NOTHING on every leg (summary path).
              const none = await cashFlowIndirect(from, to, { subsidiaryIds: [] }, org.orgId)
              assert.equal(toUnits(none.netIncome), 0n, `empty scope reported org-wide net income ${none.netIncome}`)
              assert.equal(toUnits(none.openingCash), 0n, `empty scope reported org-wide opening cash ${none.openingCash}`)
              assert.equal(toUnits(none.closingCash), 0n, `empty scope reported org-wide closing cash ${none.closingCash}`)
              assert.equal(toUnits(none.netChange), 0n)
              const noneDirect = await cashFlow(from, to, { subsidiaryIds: [] }, org.orgId)
              assert.equal(toUnits(noneDirect.closingCash), 0n)
              assert.equal(toUnits(noneDirect.netChange), 0n)
              // The same scope, non-empty, still reads the entity's own figures.
              const scoped = await cashFlowIndirect(from, to, { subsidiaryIds: [org.subsidiaryId] }, org.orgId)
              assert.equal(toUnits(scoped.netIncome), toUnits('100.0000'))
              assert.equal(toUnits(scoped.openingCash), toUnits('40.0000'))
              assert.equal(toUnits(scoped.reconciliationGap), 0n)
              // General ledger opening balances (summary leg) under the same scopes.
              const glScoped = await generalLedger(from, to, { dims: { subsidiaryIds: [org.subsidiaryId] }, orgId: org.orgId })
              assert.equal(toUnits(glScoped.accounts.find((a) => a.id === org.accounts.bank)!.opening), toUnits('40.0000'))
              const glNone = await generalLedger(from, to, { dims: { subsidiaryIds: [] }, orgId: org.orgId })
              assert.deepEqual(glNone.accounts, [], 'empty scope must list no ledger activity')
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();


const cashLedgerRows = [
  { label: "cash ledger", register: async () => {
        const { randomUUID }=await import("node:crypto");
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { bankBalances, openItems } = await import("./cash/core");
        for (const path of ["partial month", "completed month", "receivables", "payables"] as const) {
          for (const mode of ["all", "restricted", "empty"] as const) {
            test(`Cash ledger ${path}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
              const org = await withBypassContext(() => createScratchOrg());
              let foreignOrgId: string | undefined;
              try {
                const hidden = randomUUID(); const secondBook = randomUUID();
                await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
                await withBypassContext(() => db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${secondBook},${org.orgId},'TAX','Tax book',false,true,true)`));
                const subIds = mode === 'all' ? undefined : mode === 'empty' ? [] : [org.subsidiaryId];
                if (path === 'partial month' || path === 'completed month') {
                  foreignOrgId = (await withBypassContext(() => createScratchOrg())).orgId;
                  for (const [sub, book, amount] of [[org.subsidiaryId,org.bookId,'100'], [hidden,org.bookId,'999'], [org.subsidiaryId,secondBook,'700']]) {
                    const entry = randomUUID();
                    await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
                      values (${entry},${org.orgId},${book},${sub},${entry},${org.date},${org.periodId},'draft','manual')`));
                    await withBypassContext(() => db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
                      values (${org.orgId},${entry},1,${org.accounts.bank},${sub},${amount},'CAD',${amount},1),
                        (${org.orgId},${entry},2,${org.accounts.revenue},${sub},${'-'+amount},'CAD',${'-'+amount},1)`));
                    await withBypassContext(() => db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`));
                  }
                  await withOrgContext(org.orgId, async () => {
                    const banks = await bankBalances(path === 'completed month' ? '2026-08-15' : org.date, subIds);
                    if (mode === 'empty') assert.deepEqual(banks, []);
                    else {
                      assert.equal(banks.find(bank => bank.id === org.accounts.bank)?.balance, mode === 'all' ? '1099.0000' : '100.0000');
                      assert.equal(banks.length, 1);
                      assert.equal(banks[0]?.id, org.accounts.bank);
                    }
                  });
                } else {
                  await withBypassContext(() => db.execute(sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id)
                    values (${org.orgId},${org.customerId},${hidden}),(${org.orgId},${org.vendorId},${hidden})`));
                  for (const [sub, amount, label] of [[org.subsidiaryId,'100','Visible'],[hidden,'999','Hidden']]) {
                    const id = randomUUID();
                    const receivable = path === 'receivables';
                    await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate)
                      values (${id},${org.orgId},${receivable ? 'customer_invoice' : 'vendor_bill'},'draft',${label},${sub},${receivable ? org.customerId : org.vendorId},${org.date},'CAD',1)`));
                    await withBypassContext(() => db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
                      values (${org.orgId},${id},1,${receivable ? org.accounts.revenue : org.accounts.adjustment},1,${amount},${amount},0,0)`));
                    await withBypassContext(() => db.execute(sql`update documents set status='approved' where id=${id}`));
                    // The engine reads the document through ambient org scope.
                    await withOrgContext(org.orgId, () => postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }));
                  }
                  await withOrgContext(org.orgId, async () => {
                    const items = await openItems(org.orgId, path === 'receivables' ? 'ar' : 'ap', org.date, subIds);
                    assert.equal(items.length, mode === 'all' ? 2 : mode === 'empty' ? 0 : 1);
                    if (mode === 'restricted') {
                      assert.equal(items[0]?.docNumber, 'Visible');
                      assert.equal(items[0]?.remaining, '100.0000');
                    }
                  });
                }
              } finally { await dropScratchOrg(org.orgId); if (foreignOrgId) await dropScratchOrg(foreignOrgId); }
            });
          }
        }

        for (const method of ['gl_history_average', 'credit_card_cycle', 'bank_register_history'] as const) {
          for (const mode of ['all', 'restricted', 'empty'] as const) {
            test(`Cash history ${method}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
              const org = await withBypassContext(() => createScratchOrg());
              try {
                const hidden = randomUUID(); const secondBook = randomUUID(); const card = randomUUID();
                await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
                await withBypassContext(() => db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${secondBook},${org.orgId},'TAX','Tax book',false,true,true)`));
                await withBypassContext(() => db.execute(sql`insert into accounts(id,org_id,number,name,type) values (${card},${org.orgId},'2090','Card','liability_card')`));
                const target = method === 'credit_card_cycle' ? card : method === 'bank_register_history' ? org.accounts.bank : org.accounts.adjustment;
                const counter = method === 'gl_history_average' ? org.accounts.bank : org.accounts.adjustment;
                for (const [sub, book, amount, status] of [[org.subsidiaryId,org.bookId,'100','posted'], [hidden,org.bookId,'999','posted'], [org.subsidiaryId,secondBook,'700','posted'], [org.subsidiaryId,org.bookId,'900','draft']]) {
                  const entry = randomUUID(); const signed = method === 'gl_history_average' ? amount : '-'+amount;
                  const opposite = method === 'gl_history_average' ? '-'+amount : amount;
                  await withBypassContext(() => db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
                    values (${entry},${org.orgId},${book},${sub},${entry},${org.date},${org.periodId},'draft','manual')`));
                  await withBypassContext(() => db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
                    values (${org.orgId},${entry},1,${target},${sub},${signed},'CAD',${signed},1),
                      (${org.orgId},${entry},2,${counter},${sub},${opposite},'CAD',${opposite},1)`));
                  if (status === 'posted') await withBypassContext(() => db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`));
                }
                await withOrgContext(org.orgId, async () => {
                  const { categoryWeekly } = await import('./cash/core');
                  const category = await categoryWeekly(org.orgId, { id: randomUUID(), name: 'Review', direction: 'outflow', method,
                    accountIds: [target], cardAccountIds: [target], bankAccountIds: [target], includeJournals: true, historyWeeks: 4 },
                    '2026-07-20', ['2026-07-19','2026-07-26','2026-08-02','2026-08-09'],
                    { arWeekly: {}, apWeekly: {}, cashStart: '0.0000', subIds: mode === 'all' ? undefined : mode === 'empty' ? [] : [org.subsidiaryId] });
                  const amount = mode === 'all' ? '1099.0000' : mode === 'empty' ? '0.0000' : '100.0000';
                  const field = method === 'gl_history_average' ? 'sourceTotal' : method === 'credit_card_cycle' ? 'currentBalance' : 'rawAverage';
                  assert.equal(category.meta[field], amount);
                  if (mode === 'empty') assert.equal(category.total, '0.0000');
                });
              } finally { await dropScratchOrg(org.orgId); }
            });
          }
        }
  } },
  { label: "cash payment scope", register: async () => {
        const { randomUUID }=await import("node:crypto");
        const {sql} = await import('drizzle-orm');
        const {db,withBypassContext,withOrgContext} = await import('@openbooks/engine/src/platform/db.ts');
        const {createScratchOrg,createScratchUser,dropScratchOrg} = await import('@openbooks/engine/src/testing/fixtures.ts');
        const {paymentStats} = await import('./cash/core');
        for (const side of ['ar','ap'] as const) {
          for (const mode of ['all','restricted','empty'] as const) {
            test(`Payment-history subsidiary scope ${side}: ${mode}`, {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
              const org=await withBypassContext(()=>createScratchOrg());
              try {
                const actor=await withBypassContext(()=>createScratchUser(org.orgId,'History writer','admin'));
                const hidden=randomUUID();const party=side === 'ar' ? org.customerId : org.vendorId;
                const account=side === 'ar' ? org.accounts.ar : org.accounts.ap;
                await withBypassContext(async()=>{
                await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
                for(const [sub,paidOn] of [[org.subsidiaryId,'2026-07-06'],[hidden,'2026-07-21']]) {
                  const invoiceLine=randomUUID();const paymentLine=randomUUID();
                  for(const [payment,line,date] of [[false,invoiceLine,'2026-07-01'],[true,paymentLine,paidOn]] as const) {
                    const entry=randomUUID();const debit=side === 'ar' ? !payment : payment;
                    const amount=debit ? '1' : '-1';const opposite=debit ? '-1' : '1';
                    await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values (${entry},${org.orgId},${org.bookId},${sub},${entry},${date},${org.periodId},'draft','manual')`);
                    await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate)
                      values (${line},${org.orgId},${entry},1,${account},${sub},${party},true,${amount},'CAD',${amount},1),
                        (${randomUUID()},${org.orgId},${entry},2,${org.accounts.bank},${sub},${party},false,${opposite},'CAD',${opposite},1)`);
                    await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
                  }
                  await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by,updated_by)
                    values (${org.orgId},${paymentLine},${invoiceLine},1,1,1,'CAD',1,'CAD',1,'same_currency','History scope regression',${paidOn},${actor},${actor})`);
                }
                });
                await withOrgContext(org.orgId,async()=>{
                  const stats=await paymentStats(side,'2026-07-31',mode === 'all' ? undefined : mode === 'empty' ? [] : [org.subsidiaryId]);
                  assert.equal(stats.globalAvg,mode === 'all' ? 13 : mode === 'empty' ? 45 : 5);
                  assert.equal(stats.map.size,mode === 'empty' ? 0 : 1);
                  if(mode !== 'empty')assert.equal(stats.map.get(party)?.avg,mode === 'all' ? 12.5 : 5);
                });
              } finally {await dropScratchOrg(org.orgId);}
            });
          }
        }
  } },
] as const;

for(const row of cashLedgerRows) await row.register();
