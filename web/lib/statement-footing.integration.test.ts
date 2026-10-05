import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { balanceSheetView } = await import('./statement-matrix.ts')
const { balanceSheet, trialBalance } = await import('./reports/statements.ts')
const { decimalAdd } = await import('./statement-format.ts')

/**
 * Fixed-asset cost lines printed NET of their contra while the
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
      retainedEarningsPrior: 'Retained earnings (prior years)', currentYearEarnings: 'Current year earnings', translationAdjustment: 'Translation adjustment',
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


const consolidatedRows = [
  { label: "statement fx periods", register: async () => {
        const { spawnSync }=await import("node:child_process");
        /**
         * Regression (fnd_mt9f3fnu_tztsoy): comparative statements and accumulated
         * earnings reused the CURRENT period's consolidated FX rates for historical
         * activity — prior columns and lifetime buckets translated at whichever rate
         * set the report's periodTo resolved, hiding the residual in CTA. Every column
         * and every historical flow bucket must bind to the rate set of the period its
         * activity actually falls in (-120 prior / -260 cumulative, not -140/-280),
         * survive a concurrent refresh of the current period's rates, and fail loudly,
         * side-effect-free, when a needed period has no derived rates.
         */
        test(
          "comparative statements translate historical activity at each period's own consolidated rates",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            const source = `
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db, withOrgContext } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
              import { MissingRatesError, resolveSubsidiaryView } from "./web/lib/consolidation.ts";
              import { balanceSheetView, profitAndLossView, statementMatrix }
                from "./web/lib/statement-matrix.ts";

              installTrustedTestDatabaseBypass();

              const n = (value) => Number(value ?? 0);
              const findLine = (view, label) => {
                const line = view.lines.find((l) => l.label === label);
                assert.ok(line, \`\${label} line missing from the statement view\`);
                return line;
              };
              const pnlLabels = {
                revenue: "Revenue",
                costOfGoodsSold: "Cost of goods sold",
                grossProfit: "Gross profit",
                expenses: "Expenses",
                netIncome: "Net income",
                totalOf: (section) => \`Total \${section}\`,
              };
              const bsLabels = {
                assets: "Assets",
                liabilities: "Liabilities",
                equity: "Equity",
                totalAssets: "Total assets",
                totalLiabilities: "Total liabilities",
                totalEquity: "Total equity",
                retainedEarningsPrior: "Retained earnings (prior years)",
                currentYearEarnings: "Current year earnings",
                translationAdjustment: "Translation adjustment",
                liabilitiesAndEquity: "Liabilities and equity",
                totalOf: (section) => \`Total \${section}\`,
              };

              const org = await createScratchOrg();
              try {
                // A June 2026 comparative period on the scratch fiscal calendar, plus a
                // foreign-currency child subsidiary with two months of revenue activity.
                const calendar = (await db.execute(sql\`
                  select fiscal_calendar_id from accounting_periods where id = \${org.periodId}
                \`)).rows[0];
                // May exists to prove rate sets load for EVERY period up to the report
                // date, not only the ones a column reads. The July comparative is the
                // preceding ACCOUNTING period (June 1-30, see priorAccountingWindow),
                // never an equal-day window reaching back into May.
                const mayPeriodId = randomUUID();
                const priorPeriodId = randomUUID();
                await db.execute(sql\`
                  insert into accounting_periods
                    (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                  values
                    (\${mayPeriodId}, \${org.orgId}, 2026, 5, '2026-05', '2026-05-01', '2026-05-31', false, \${calendar.fiscal_calendar_id}),
                    (\${priorPeriodId}, \${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, \${calendar.fiscal_calendar_id})
                \`);
                const usdId = randomUUID();
                await db.execute(sql\`
                  insert into subsidiaries
                    (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
                  values (\${usdId}, \${org.orgId}, \${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)
                \`);
                const rateRows = [
                  [mayPeriodId, "1.1000000000", "1.1500000000", "1.0500000000"],
                  [priorPeriodId, "1.2000000000", "1.2500000000", "1.1000000000"],
                  [org.periodId, "1.4000000000", "1.4500000000", "1.3000000000"],
                ];
                for (const [periodId, average, current, historical] of rateRows) {
                  await db.execute(sql\`
                    insert into consolidated_fx_rates
                      (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
                    values (\${org.orgId}, \${periodId}, 'USD', 'CAD', \${current}, \${average}, \${historical}, 'manual')
                  \`);
                }
                const postRevenue = async (tag, date, periodId) => {
                  const entry = randomUUID();
                  await db.execute(sql\`
                    insert into journal_entries
                      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                    values (\${entry}, \${org.orgId}, \${org.bookId}, \${usdId}, \${tag}, \${date}, \${periodId}, \${tag}, 'draft', 'manual')
                  \`);
                  await db.execute(sql\`
                    insert into journal_lines
                      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                    values
                      (\${org.orgId}, \${entry}, 1, \${org.accounts.bank}, \${usdId}, '100.0000', 'USD', '100.0000', '1'),
                      (\${org.orgId}, \${entry}, 2, \${org.accounts.revenue}, \${usdId}, '-100.0000', 'USD', '-100.0000', '1')
                  \`);
                  await db.execute(sql\`update journal_entries set status = 'posted', posted_at = now() where id = \${entry}\`);
                };
                await postRevenue("STMT-FX-PRIOR", "2026-06-20", priorPeriodId);
                await postRevenue("STMT-FX-CURRENT", "2026-07-15", org.periodId);
                const period = { from: "2026-07-01", to: "2026-07-31" };

                await withOrgContext(org.orgId, async () => {
                  const view = await resolveSubsidiaryView(org.subsidiaryId, period.to);
                  assert.ok(view.consolidated && view.subsidiary?.rates?.length);
                  // The context now carries one rate set PER PERIOD per foreign entity,
                  // not a single set borrowed from the report's own period.
                  const usdSets = view.subsidiary.rates.filter((r) => r.subsidiaryId === usdId);
                  assert.deepEqual(
                    usdSets.map((r) => [r.periodFrom, r.periodTo, n(r.averageRate)]),
                    [
                      ["2026-05-01", "2026-05-31", 1.1],
                      ["2026-06-01", "2026-06-30", 1.2],
                      ["2026-07-01", "2026-07-31", 1.4],
                    ],
                  );
                  const subsidiary = view.subsidiary;
                  const opts = { orgId: org.orgId, subsidiary };

                  // Comparative P&L: the PRIOR column translates at the PRIOR period's
                  // average rate (revenue credit -100 x 1.20 = 120 displayed), never at
                  // July's 1.40 (which would show 140).
                  const pnl = await profitAndLossView(period, "July 2026", pnlLabels, { ...opts, compare: "prior_period" });
                  assert.equal(pnl.columns.length, 4, "current + prior + variance pair");
                  assert.deepEqual([pnl.columns[1].from, pnl.columns[1].to], ["2026-06-01", "2026-06-30"], "prior column is the preceding accounting period");
                  const netIncome = findLine(pnl, "Net income");
                  assert.deepEqual(netIncome.values.slice(0, 3).map(n), [140, 120, 20]);

                  // Balance sheet: current-year earnings are FYTD P&L (all 2026 here),
                  // so each cumulative column mixes both periods' averages — 260 total
                  // (120 + 140), not 280. Assets translate at the current rate AS OF
                  // each column's end (125 = 100 x 1.25 prior, 290 = 200 x 1.45 now),
                  // and the CTA plug keeps every column balanced by construction.
                  const bs = await balanceSheetView(period, "July 2026", bsLabels, { ...opts, compare: "prior_period" });
                  assert.deepEqual(findLine(bs, "Current year earnings").values.slice(0, 2).map(n), [260, 120]);
                  assert.deepEqual(findLine(bs, "Retained earnings (prior years)").values.slice(0, 2).map(n), [0, 0]);
                  assert.deepEqual(findLine(bs, "Translation adjustment").values.slice(0, 2).map(n), [30, 5]);
                  const assets = findLine(bs, "Total assets").values.map(n);
                  const liabAndEquity = findLine(bs, "Liabilities and equity").values.map(n);
                  assert.deepEqual(liabAndEquity.slice(0, 2), assets.slice(0, 2));
                  assert.deepEqual(assets.slice(0, 2), [290, 125]);

                  // Month breakout over both periods: each month's column carries its
                  // own average rate within ONE render.
                  const monthly = await statementMatrix({
                    ...opts, types: ["income"], mode: "flow", period: { from: "2026-06-01", to: "2026-07-31" },
                    breakout: "month", compare: "none",
                  });
                  const revenueRow = monthly.rows.find((r) => r.id === org.accounts.revenue);
                  assert.ok(revenueRow);
                  assert.deepEqual(revenueRow.values.map(n), [120, 140]);

                  // A concurrent refresh of the CURRENT period's rates must move only
                  // the columns that period actually backs. A render already bound to
                  // its resolved context stays internally consistent (no tearing), and
                  // the next resolved request picks up the refreshed set while the
                  // prior column stays pinned to ITS OWN period's derived rates.
                  await db.execute(sql\`
                    update consolidated_fx_rates set average_rate = '1.5000000000'
                     where org_id = \${org.orgId} and period_id = \${org.periodId} and from_currency = 'USD'
                  \`);
                  const inFlightPnl = await profitAndLossView(period, "July 2026", pnlLabels, { ...opts, compare: "prior_period" });
                  assert.deepEqual(findLine(inFlightPnl, "Net income").values.slice(0, 3).map(n), [140, 120, 20]);
                  const refreshedView = await resolveSubsidiaryView(org.subsidiaryId, period.to);
                  const refreshedOpts = { orgId: org.orgId, subsidiary: refreshedView.subsidiary };
                  const refreshedPnl = await profitAndLossView(period, "July 2026", pnlLabels, { ...refreshedOpts, compare: "prior_period" });
                  assert.deepEqual(findLine(refreshedPnl, "Net income").values.slice(0, 3).map(n), [150, 120, 30]);
                  const refreshedBs = await balanceSheetView(period, "July 2026", bsLabels, { ...refreshedOpts, compare: "prior_period" });
                  assert.deepEqual(findLine(refreshedBs, "Current year earnings").values.slice(0, 2).map(n), [270, 120]);
                  assert.deepEqual(findLine(refreshedBs, "Translation adjustment").values.slice(0, 2).map(n), [20, 5]);

                  // A missing HISTORICAL rate fails loudly and side-effect-free. Rate
                  // sets bind at context-resolution time (renders never tear), so the
                  // next resolved request is the one that must refuse to report.
                  const evidenceBefore = (await db.execute(sql\`
                    select
                      (select count(*)::int from journal_entries where org_id = \${org.orgId}) as entries,
                      (select count(*)::int from audit_log where org_id = \${org.orgId}) as audits
                  \`)).rows[0];
                  await db.execute(sql\`
                    delete from consolidated_fx_rates where org_id = \${org.orgId} and period_id = \${priorPeriodId}
                  \`);
                  const gappedView = await resolveSubsidiaryView(org.subsidiaryId, period.to);
                  const gappedOpts = { orgId: org.orgId, subsidiary: gappedView.subsidiary };
                  await assert.rejects(
                    profitAndLossView(period, "July 2026", pnlLabels, { ...gappedOpts, compare: "prior_period" }),
                    (error) => error instanceof MissingRatesError && /covering 2026-06-01\.\.2026-07-31/.test(error.message),
                  );
                  await assert.rejects(
                    balanceSheetView({ from: "2026-06-01", to: "2026-07-31" }, "June-July 2026", bsLabels, gappedOpts),
                    (error) => error instanceof MissingRatesError && /covering 2026-06-01\.\.2026-07-31/.test(error.message),
                  );
                  const evidenceAfter = (await db.execute(sql\`
                    select
                      (select count(*)::int from journal_entries where org_id = \${org.orgId}) as entries,
                      (select count(*)::int from audit_log where org_id = \${org.orgId}) as audits
                  \`)).rows[0];
                  assert.deepEqual(evidenceAfter, evidenceBefore, "failed renders leave no evidence behind");

                  // And the pre-existing contract holds: a missing rate in the REPORT's
                  // own period is refused when the context resolves at all.
                  await db.execute(sql\`
                    delete from consolidated_fx_rates where org_id = \${org.orgId} and period_id = \${org.periodId}
                  \`);
                  await assert.rejects(
                    resolveSubsidiaryView(org.subsidiaryId, period.to),
                    (error) =>
                      error instanceof MissingRatesError &&
                      /USD.*CAD.*period ending 2026-07-31/.test(error.message),
                  );
                });
              } finally {
                await dropScratchOrg(org.orgId);
              }
            `;
            const result = spawnSync(
              process.execPath,
              [
                "--conditions=react-server",
                "--import",
                "tsx",
                "--import",
                "./engine/src/testing/database-bypass.ts",
                "--input-type=module",
                "-e",
                source,
              ],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(
              result.status,
              0,
              result.stderr ||
                result.stdout ||
                result.error?.message ||
                `statement FX integration subprocess failed with status ${String(result.status)}`,
            );
          },
        );
  } },
  { label: "statement quarter breakout", register: async () => {
        const { pathToFileURL }=await import("node:url");
        /**
         * Quarter breakout columns must follow the org's fiscal calendar, not the
         * calendar year: with a February fiscal start, Jan 2026 belongs to Q4 FY2026
         * and Feb 2026 opens Q1 FY2027. A January-hardcoded quarter split reports
         * calendar quarters ("Q1 2026") and groups fiscal straddlers wrongly.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')

        test('quarter breakout follows the org fiscal start month, not January', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(async () => {
              await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 2}'::jsonb where id = ${org.orgId}`)
              const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
              const periodIds: Record<string, string> = {}
              for (const [n, from, to] of [[11, '2025-11-01', '2025-11-30'], [12, '2025-12-01', '2025-12-31'], [1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [3, '2026-03-01', '2026-03-31']] as const) {
                const id = randomUUID()
                periodIds[from] = id
                await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                  values (${id}, ${org.orgId}, 2026, ${n}, ${'P' + n}, ${from}, ${to}, false, ${calendar.fiscal_calendar_id})`)
              }
              const post = async (date: string, amount: string) => {
                const periodId = periodIds[date.slice(0, 8) + '01'] ?? org.periodId
                const entry = randomUUID()
                await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                  values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'QB-' + date}, ${date}, ${periodId}, ${'QB-' + date}, 'draft', 'manual')`)
                await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                  values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                         (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
                await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
              }
              await post('2026-01-15', '100.0000')
              await post('2026-02-15', '200.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-01-01', to: '2026-03-31' },
                periodLabel: 'Q4 FY2026 – Q1 FY2027',
                breakout: 'quarter',
              })
              assert.equal(matrix.columns.length, 2)
              assert.deepEqual(
                matrix.columns.map((c) => [c.label, c.from, c.to]),
                [
                  ['Q4 FY 2026', '2025-11-01', '2026-01-31'],
                  ['Q1 FY 2027', '2026-02-01', '2026-04-30'],
                ],
              )
              const revenue = matrix.rows.find((r) => r.name && r.type === 'income')
              assert.ok(revenue, 'expected a revenue row')
              // Jan revenue sits in the fiscal quarter ending January, Feb in the next.
              assert.deepEqual(revenue.values.slice(0, 2).map(String), ['100.0000', '200.0000'])
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
  { label: "statement fiscal period breakout", register: async () => {
        const { pathToFileURL }=await import("node:url");
        /**
         * Statement month/quarter breakouts must follow the org's configured fiscal
         * periods for retail calendars — not calendar months. A 4-4-5 org's 5-week
         * period is ONE column (labelled with the fiscal period name) even when it
         * straddles two calendar months, and quarter columns group the calendar's
         * declared periods. Monthly-cadence orgs (January or April start) must stay
         * byte-identical to calendar math.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { generateAccountingPeriods } = (await import(root + "engine/src/close/calendar.ts")) as typeof import("@openbooks/engine/src/close/calendar.ts");
        const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')
        const { resolvePeriod } = (await import(root + 'web/lib/periods.ts')) as typeof import('./periods')

        type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

        /** Post revenue `amount` on `date` (bank debit / revenue credit, like the
         *  quarter-breakout fixture). Entries are uniquely numbered per call. */
        async function postRevenue(org: ScratchOrg, calendarId: string, date: string, amount: string): Promise<void> {
          const periodId = (
            await db.execute<{ id: string }>(sql`
              select id from accounting_periods
               where org_id = ${org.orgId} and fiscal_calendar_id = ${calendarId}
                 and not is_adjustment and starts_on <= ${date} and ${date} <= ends_on
               limit 1`)
          ).rows[0]?.id
          assert.ok(periodId, `no fiscal period covers ${date}`)
          const entry = randomUUID()
          const memo = `W09-${date}-${entry.slice(0, 8)}`
          await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
            values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${memo}, ${date}, ${periodId}, ${memo}, 'draft', 'manual')`)
          await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
            values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                   (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
          await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
        }

        async function revenueValues(matrix: Awaited<ReturnType<typeof statementMatrix>>, width: number): Promise<string[]> {
          const revenue = matrix.rows.find((r) => r.type === 'income')
          assert.ok(revenue, 'expected a revenue row')
          return revenue.values.slice(0, width).map(String)
        }

        /**
         * Scratch org converted to a 4-4-5 retail calendar: the monthly default is
         * retired and FY2026 is generated from a Monday 2026-02-02 anchor, giving
         * P01 02-02..03-01 (4w), P02 03-02..03-29 (4w), P03 03-30..05-03 (5w),
         * P04 05-04..05-31 (4w), … P12 ending 2027-01-31.
         */
        async function release445Org(org: ScratchOrg, calendarId: string, baselineCalendarId: string) {
          // Undo the default switch before release: the fixture reset restores
          // baseline calendar rows in place, and a surviving second default trips
          // fiscal_calendars_one_default, tainting the lease. Retail off first so
          // two defaults never coexist; the baseline row then re-arms exactly.
          await withBypassContext(() => db.execute(sql`update fiscal_calendars set is_default = false where id = ${calendarId} and org_id = ${org.orgId}`))
          await withBypassContext(() => db.execute(sql`update fiscal_calendars set is_default = true where id = ${baselineCalendarId} and org_id = ${org.orgId}`))
          await withBypassContext(() => dropScratchOrg(org.orgId))
        }

        async function make445Org(): Promise<{ org: ScratchOrg; calendarId: string; baselineCalendarId: string }> {
          const org = await withBypassContext(() => createScratchOrg())
          const baselineCalendarId = await withBypassContext(async () => {
            const row = (await db.execute<{ id: string }>(sql`select id from fiscal_calendars where org_id = ${org.orgId} and is_default`)).rows[0]
            assert.ok(row, 'expected a baseline default calendar')
            return row.id
          })
          const calendarId = await withBypassContext(async () => {
            const id = randomUUID()
            await db.execute(sql`update fiscal_calendars set is_default = false where org_id = ${org.orgId} and is_default`)
            await db.execute(sql`insert into fiscal_calendars
              (id, org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone, is_default, is_active, config)
              values (${id}, ${org.orgId}, 'Retail 4-4-5', 'four_four_five', 2, 1, '2026-02-02', 'UTC', true, true, '{"anchorFiscalYear": 2026}'::jsonb)`)
            await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 2}'::jsonb where id = ${org.orgId}`)
            const actorId = await createScratchUser(org.orgId, 'Calendar keeper', 'admin')
            const generated = await generateAccountingPeriods(org.orgId, id, 2026, actorId)
            assert.equal(generated.periods.length, 12)
            assert.deepEqual(
              generated.periods.slice(0, 4).map((p) => [p.number, p.startsOn, p.endsOn]),
              [
                [1, '2026-02-02', '2026-03-01'],
                [2, '2026-03-02', '2026-03-29'],
                [3, '2026-03-30', '2026-05-03'],
                [4, '2026-05-04', '2026-05-31'],
              ],
            )
            return id
          })
          return { org, calendarId, baselineCalendarId }
        }

        test('month breakout follows 4-4-5 fiscal periods; a 5-week period is one column', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const { org, calendarId, baselineCalendarId } = await make445Org()
          try {
            await withBypassContext(async () => {
              // Mar 31 and Apr 15 both fall in the 5-week P03 (03-30..05-03):
              // calendar math would split them across March/April columns.
              await postRevenue(org, calendarId, '2026-02-10', '400.0000')
              await postRevenue(org, calendarId, '2026-03-31', '100.0000')
              await postRevenue(org, calendarId, '2026-04-15', '200.0000')
              await postRevenue(org, calendarId, '2026-05-10', '500.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-02-02', to: '2026-05-31' },
                periodLabel: 'Q1 4-4-5',
                breakout: 'month',
              })
              assert.deepEqual(
                matrix.columns.map((c) => [c.label, c.from, c.to]),
                [
                  ['P01 FY2026', '2026-02-02', '2026-03-01'],
                  ['P02 FY2026', '2026-03-02', '2026-03-29'],
                  ['P03 FY2026', '2026-03-30', '2026-05-03'],
                  ['P04 FY2026', '2026-05-04', '2026-05-31'],
                ],
              )
              assert.deepEqual(await revenueValues(matrix, 4), ['400.0000', '0.0000', '300.0000', '500.0000'])
            })
          } finally {
            await release445Org(org, calendarId, baselineCalendarId)
          }
        })

        test('quarter breakout groups the 4-4-5 calendar declared periods', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const { org, calendarId, baselineCalendarId } = await make445Org()
          try {
            await withBypassContext(async () => {
              await postRevenue(org, calendarId, '2026-02-10', '400.0000')
              await postRevenue(org, calendarId, '2026-03-31', '100.0000')
              await postRevenue(org, calendarId, '2026-04-15', '200.0000')
              await postRevenue(org, calendarId, '2026-05-10', '500.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-02-02', to: '2026-05-31' },
                periodLabel: 'Q1–Q2 4-4-5',
                breakout: 'quarter',
              })
              assert.deepEqual(
                matrix.columns.map((c) => [c.label, c.from, c.to]),
                [
                  ['Q1 FY 2026', '2026-02-02', '2026-05-03'],
                  // Q2 spans the full known group (P04–P06 generated for FY2026),
                  // like a calendar quarter spans its full bounds.
                  ['Q2 FY 2026', '2026-05-04', '2026-08-02'],
                ],
              )
              assert.deepEqual(await revenueValues(matrix, 2), ['700.0000', '500.0000'])
            })
          } finally {
            await release445Org(org, calendarId, baselineCalendarId)
          }
        })

        test('month breakout falls back to calendar math past generated periods', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          // Fail-safe gate: FY2027 was never generated for this calendar, so a
          // window reaching past FY2026 must keep the old calendar columns rather
          // than silently dropping activity outside declared periods.
          const { org, calendarId, baselineCalendarId } = await make445Org()
          try {
            await withBypassContext(async () => {
              await postRevenue(org, calendarId, '2026-04-15', '200.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-02-02', to: '2027-06-30' },
                periodLabel: 'spillover',
                breakout: 'month',
              })
              assert.equal(matrix.columns.length, 17)
              assert.equal(matrix.columns[0]!.label, '2026-02')
              assert.equal(matrix.columns[2]!.label, '2026-04')
              assert.deepEqual(await revenueValues(matrix, 17).then((v) => [v[0], v[2]]), ['0.0000', '200.0000'])
            })
          } finally {
            await release445Org(org, calendarId, baselineCalendarId)
          }
        })

        test('monthly January-start orgs keep calendar-month breakouts byte-identical', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const calendarId: string = await withBypassContext(async () => {
              const id = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
              for (const [n, from, to] of [['2026-01', '2026-01-01', '2026-01-31'], ['2026-02', '2026-02-01', '2026-02-28'], ['2026-03', '2026-03-01', '2026-03-31']] as const) {
                await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                  values (${randomUUID()}, ${org.orgId}, 2026, ${Number(n.slice(5))}, ${n}, ${from}, ${to}, false, ${id})`)
              }
              await postRevenue(org, id, '2026-01-15', '100.0000')
              await postRevenue(org, id, '2026-02-15', '200.0000')
              await postRevenue(org, id, '2026-03-15', '300.0000')
              return id
            })
            assert.ok(calendarId)
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-01-01', to: '2026-03-31' },
                periodLabel: 'Q1 2026',
                breakout: 'month',
              })
              assert.deepEqual(
                matrix.columns.map((c) => [c.label, c.from, c.to]),
                [
                  ['2026-01', '2026-01-01', '2026-01-31'],
                  ['2026-02', '2026-02-01', '2026-02-28'],
                  ['2026-03', '2026-03-01', '2026-03-31'],
                ],
              )
              assert.deepEqual(await revenueValues(matrix, 3), ['100.0000', '200.0000', '300.0000'])
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })

        test('monthly April-start orgs keep fiscal quarter breakouts byte-identical', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(async () => {
              await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 4}'::jsonb where id = ${org.orgId}`)
              const calendarId = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
              for (const [n, from, to] of [[1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [5, '2026-05-01', '2026-05-31']] as const) {
                await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                  values (${randomUUID()}, ${org.orgId}, 2026, ${n}, ${'2026-' + String(n).padStart(2, '0')}, ${from}, ${to}, false, ${calendarId})`)
              }
              await postRevenue(org, calendarId, '2026-01-15', '100.0000')
              await postRevenue(org, calendarId, '2026-05-15', '200.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period: { from: '2026-01-01', to: '2026-06-30' },
                periodLabel: 'H1',
                breakout: 'quarter',
              })
              assert.deepEqual(
                matrix.columns.map((c) => [c.label, c.from, c.to]),
                [
                  ['Q4 FY 2026', '2026-01-01', '2026-03-31'],
                  ['Q1 FY 2027', '2026-04-01', '2026-06-30'],
                ],
              )
              assert.deepEqual(await revenueValues(matrix, 2), ['100.0000', '200.0000'])
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })

        test('period presets agree with fiscal periods on a 4-4-5 org', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const { org, calendarId, baselineCalendarId } = await make445Org()
          try {
            await withOrgContext(org.orgId, async () => {
              const today = '2026-04-15' // inside the 5-week P03
              assert.deepEqual(await resolvePeriod('this_period', { today, orgId: org.orgId }), {
                presetId: 'this_period',
                from: '2026-03-30',
                to: '2026-05-03',
                label: 'P03 FY2026',
              })
              assert.deepEqual(await resolvePeriod('this_month', { today, orgId: org.orgId }), {
                presetId: 'this_month',
                from: '2026-03-30',
                to: '2026-05-03',
                label: 'P03 FY2026',
              })
              assert.deepEqual(await resolvePeriod('last_period', { today, orgId: org.orgId }), {
                presetId: 'last_period',
                from: '2026-03-02',
                to: '2026-03-29',
                label: 'P02 FY2026',
              })
              assert.deepEqual(await resolvePeriod('this_fiscal_quarter', { today, orgId: org.orgId }), {
                presetId: 'this_fiscal_quarter',
                from: '2026-02-02',
                to: '2026-05-03',
                label: 'Q1 FY 2026',
              })
              assert.deepEqual(await resolvePeriod('this_fiscal_year', { today, orgId: org.orgId }), {
                presetId: 'this_fiscal_year',
                from: '2026-02-02',
                to: '2027-01-31',
                label: 'FY 2026',
              })
            })
          } finally {
            await release445Org(org, calendarId, baselineCalendarId)
          }
        })
  } },
  { label: "statement prior period", register: async () => {
        const { pathToFileURL }=await import("node:url");
        /**
         * RP8 — `compare=prior_period` built the comparative as an EQUAL-DAY window
         * (Feb 1–28 compared to Jan 4–31, dropping Jan 1–3). The comparative for a
         * window that aligns to accounting periods is the same number of periods
         * immediately preceding it; a non-aligned window keeps the equal-length
         * comparative and says so in the column label.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { profitAndLoss } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')
        const { priorAccountingWindow, profitAndLossView } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')

        const labels = {
          revenue: 'Revenue', costOfGoodsSold: 'Cost of goods sold', grossProfit: 'Gross profit', expenses: 'Expenses',
          netIncome: 'Net income', totalOf: (section: string) => `Total ${section}`,
        }

        test('prior_period compares against the preceding accounting period(s), not an equal-day window', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const periodIds: Record<string, string> = {}
            await withBypassContext(async () => {
              const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
              // Jan–Jun 2026 on the fixture's calendar (the fixture ships July only).
              for (const [n, from, to] of [[1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [3, '2026-03-01', '2026-03-31'], [4, '2026-04-01', '2026-04-30'], [5, '2026-05-01', '2026-05-31'], [6, '2026-06-01', '2026-06-30']] as const) {
                const id = randomUUID()
                periodIds[from] = id
                await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
                  values (${id}, ${org.orgId}, 2026, ${n}, ${'2026-' + String(n).padStart(2, '0')}, ${from}, ${to}, false, ${calendar.fiscal_calendar_id})`)
              }
              const post = async (date: string, amount: string) => {
                const periodId = periodIds[date.slice(0, 8) + '01'] ?? org.periodId
                const entry = randomUUID()
                await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                  values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'PP-' + date}, ${date}, ${periodId}, ${'PP-' + date}, 'draft', 'manual')`)
                await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                  values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                         (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
                await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
              }
              // Jan 1–3 carry revenue the equal-day window (Jan 4–31) would drop.
              await post('2026-01-02', '300.0000')
              await post('2026-01-20', '100.0000')
              await post('2026-02-10', '50.0000')
              await post('2026-03-05', '20.0000')
              await post('2026-05-09', '7.0000')
            })
            await withOrgContext(org.orgId, async () => {
              const february = { from: '2026-02-01', to: '2026-02-28' }
              const view = await profitAndLossView(february, 'February 2026', labels, { orgId: org.orgId, compare: 'prior_period' })
              const prior = view.columns[1]!
              assert.equal(prior.label, 'Prior period')
              assert.deepEqual([prior.from, prior.to], ['2026-01-01', '2026-01-31'], 'February compares to ALL of January')
              const netIncome = view.lines.find((l) => l.label === 'Net income')!.values!
              const january = await profitAndLoss('2026-01-01', '2026-01-31', undefined, org.orgId)
              assert.equal(toUnits(netIncome[0]!), toUnits('50.0000'))
              assert.equal(toUnits(netIncome[1]!), toUnits(january.netIncome), 'prior column equals the January P&L')
              assert.equal(toUnits(netIncome[1]!), toUnits('400.0000'))

              // A run of periods (a quarter) compares to the preceding run.
              const q2 = await priorAccountingWindow(org.orgId, { from: '2026-04-01', to: '2026-06-30' })
              assert.deepEqual(q2, { from: '2026-01-01', to: '2026-03-31', aligned: true })
              const quarter = await profitAndLossView({ from: '2026-04-01', to: '2026-06-30' }, 'Q2 2026', labels, { orgId: org.orgId, compare: 'prior_period' })
              const quarterNet = quarter.lines.find((l) => l.label === 'Net income')!.values!
              assert.deepEqual([toUnits(quarterNet[0]!), toUnits(quarterNet[1]!)], [toUnits('7.0000'), toUnits('470.0000')], 'Q2 compares to Q1 (300 + 100 + 50 + 20)')

              // Not period-aligned: equal-length comparative, labelled as such.
              const partial = await priorAccountingWindow(org.orgId, { from: '2026-02-03', to: '2026-02-28' })
              assert.deepEqual(partial, { from: '2026-01-08', to: '2026-02-02', aligned: false })
              const partialView = await profitAndLossView({ from: '2026-02-03', to: '2026-02-28' }, 'Feb 3–28', labels, { orgId: org.orgId, compare: 'prior_period' })
              assert.equal(partialView.columns[1]!.label, 'Prior period (equal length)')
              // Aligned, but the calendar starts here: equal length, disclosed.
              const first = await priorAccountingWindow(org.orgId, { from: '2026-01-01', to: '2026-01-31' })
              assert.deepEqual(first, { from: '2025-12-01', to: '2025-12-31', aligned: false })
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
  { label: "statement fx adjustment period", register: async () => {
        const { spawnSync }=await import("node:child_process");
        /**
         * Regression (G5): a calendar's adjustment period starts AND ends on the
         * final regular period's last day. Consolidated rate windows are selected by
         * posting date, so loading a rate set for both P12 and the adjustment period
         * produced two windows covering Dec 31 and the in-query rate lookup returned
         * two rows (Postgres 21000) — every consolidated statement as of year end
         * failed. Rate windows must partition the calendar: only regular periods
         * supply windows, and an overlap is refused before any rows are read.
         */
        test(
          "consolidated statements at the fiscal year end resolve one rate window when an adjustment period exists",
          { skip: !env.OPENBOOKS_DB_URL },
          () => {
            const source = `
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { generateAccountingPeriods } from "./engine/src/close/calendar.ts";
              import { deriveConsolidatedRates } from "./engine/src/consolidation/consolidation.ts";
              import { db, withOrgContext } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./engine/src/testing/fixtures.ts";
              import { resolveSubsidiaryView } from "./web/lib/consolidation.ts";
              import { balanceSheetView, profitAndLossView } from "./web/lib/statement-matrix.ts";

              installTrustedTestDatabaseBypass();

              const n = (value) => Number(value ?? 0);
              const findLine = (view, label) => {
                const line = view.lines.find((l) => l.label === label);
                assert.ok(line, \`\${label} line missing from the statement view\`);
                return line;
              };
              const pnlLabels = {
                revenue: "Revenue",
                costOfGoodsSold: "Cost of goods sold",
                grossProfit: "Gross profit",
                expenses: "Expenses",
                netIncome: "Net income",
                totalOf: (section) => \`Total \${section}\`,
              };
              const bsLabels = {
                assets: "Assets",
                liabilities: "Liabilities",
                equity: "Equity",
                totalAssets: "Total assets",
                totalLiabilities: "Total liabilities",
                totalEquity: "Total equity",
                retainedEarningsPrior: "Retained earnings (prior years)",
                currentYearEarnings: "Current year earnings",
                translationAdjustment: "Translation adjustment",
                liabilitiesAndEquity: "Liabilities and equity",
                totalOf: (section) => \`Total \${section}\`,
              };

              const org = await createScratchOrg();
              try {
                const actorId = (await seedFlowActors(org.orgId)).adminId;
                // The real calendar path: enable the adjustment period and generate the
                // fiscal year, which appends the adjustment period on P12's last day.
                const calendar = (await db.execute(sql\`
                  select fiscal_calendar_id from accounting_periods where id = \${org.periodId}
                \`)).rows[0];
                await db.execute(sql\`
                  update fiscal_calendars set adjustment_period_enabled = true where id = \${calendar.fiscal_calendar_id}
                \`);
                await generateAccountingPeriods(org.orgId, calendar.fiscal_calendar_id, 2026, actorId);
                const periods = (await db.execute(sql\`
                  select id, period_number, starts_on, ends_on, is_adjustment
                    from accounting_periods where org_id = \${org.orgId} and fiscal_year = 2026
                   order by period_number
                \`)).rows;
                const december = periods.find((p) => p.period_number === 12 && !p.is_adjustment);
                const adjustment = periods.find((p) => p.is_adjustment);
                assert.ok(december && adjustment, "P12 and the adjustment period both exist");
                assert.equal(adjustment.starts_on, december.ends_on);
                assert.equal(adjustment.ends_on, december.ends_on);

                const usdId = randomUUID();
                await db.execute(sql\`
                  insert into subsidiaries
                    (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
                  values (\${usdId}, \${org.orgId}, \${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)
                \`);
                await db.execute(sql\`
                  insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
                  values
                    (\${org.orgId}, 'USD', 'CAD', '2026-12-15', 'spot', '1.2500000000'),
                    (\${org.orgId}, 'USD', 'CAD', '2026-12-31', 'spot', '1.3000000000')
                \`);
                // Both P12 and the adjustment period carry derived rates, exactly as a
                // period-close controller who consolidates both would leave them.
                assert.equal(await deriveConsolidatedRates(org.orgId, december.id, actorId), 1);
                assert.equal(await deriveConsolidatedRates(org.orgId, adjustment.id, actorId), 1);

                const entry = randomUUID();
                await db.execute(sql\`
                  insert into journal_entries
                    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                  values (\${entry}, \${org.orgId}, \${org.bookId}, \${usdId}, 'DEC-REV', '2026-12-20', \${december.id}, 'December revenue', 'draft', 'manual')
                \`);
                await db.execute(sql\`
                  insert into journal_lines
                    (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
                  values
                    (\${org.orgId}, \${entry}, 1, \${org.accounts.bank}, \${usdId}, '100.0000', 'USD', '100.0000', '1'),
                    (\${org.orgId}, \${entry}, 2, \${org.accounts.revenue}, \${usdId}, '-100.0000', 'USD', '-100.0000', '1')
                \`);
                await db.execute(sql\`update journal_entries set status = 'posted', posted_at = now() where id = \${entry}\`);

                await withOrgContext(org.orgId, async () => {
                  const view = await resolveSubsidiaryView(org.subsidiaryId, "2026-12-31");
                  assert.ok(view.consolidated && view.subsidiary?.rates?.length);
                  const usdSets = view.subsidiary.rates.filter((r) => r.subsidiaryId === usdId);
                  assert.deepEqual(
                    usdSets.map((r) => [r.periodFrom, r.periodTo]),
                    [["2026-12-01", "2026-12-31"]],
                    "only the regular period supplies a rate window; the adjustment period never overlaps it",
                  );
                  const opts = { orgId: org.orgId, subsidiary: view.subsidiary };
                  const period = { from: "2026-12-01", to: "2026-12-31" };

                  // Year-end consolidated balance sheet and P&L render (no 21000) and
                  // translate at P12's rates: assets at current 1.30, revenue at the
                  // period average (1.25 + 1.30) / 2 = 1.275.
                  const bs = await balanceSheetView(period, "December 2026", bsLabels, opts);
                  assert.deepEqual(findLine(bs, "Total assets").values.slice(0, 1).map(n), [130]);
                  assert.deepEqual(findLine(bs, "Current year earnings").values.slice(0, 1).map(n), [127.5]);
                  assert.deepEqual(findLine(bs, "Retained earnings (prior years)").values.slice(0, 1).map(n), [0]);
                  assert.deepEqual(findLine(bs, "Translation adjustment").values.slice(0, 1).map(n), [2.5]);
                  const pnl = await profitAndLossView(period, "December 2026", pnlLabels, opts);
                  assert.deepEqual(findLine(pnl, "Net income").values.slice(0, 1).map(n), [127.5]);
                });
              } finally {
                await dropScratchOrg(org.orgId);
              }
            `;
            const result = spawnSync(
              process.execPath,
              [
                "--conditions=react-server",
                "--import",
                "tsx",
                "--import",
                "./engine/src/testing/database-bypass.ts",
                "--input-type=module",
                "-e",
                source,
              ],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(
              result.status,
              0,
              result.stderr ||
                result.stdout ||
                result.error?.message ||
                `statement FX adjustment-period subprocess failed with status ${String(result.status)}`,
            );
          },
        );
  } },
  { label: "statement matrix precision", register: async () => {
        type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')

        const { resolveSubsidiaryView } = await import('./consolidation')
        const { statementMatrix } = await import('./statement-matrix')

        async function postManual(org: ScratchOrg, tag: string, date: string, periodId: string, subId: string, lines: [string, string][]) {
          const entry = randomUUID()
          await db.execute(sql`insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
            values (${entry}, ${org.orgId}, ${org.bookId}, ${subId}, ${tag}, ${date}, ${periodId}, ${tag}, 'draft', 'manual')`)
          for (let i = 0; i < lines.length; i++) {
            const [accountId, amount] = lines[i]!
            await db.execute(sql`insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
              values (${org.orgId}, ${entry}, ${i + 1}, ${accountId}, ${subId}, ${amount}, 'CAD', ${amount}, '1')`)
          }
          await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
          return entry
        }

        /**
         * Translated consolidated columns multiply each line by a 10dp rate and
         * cash-basis columns by a fractional settled share — both carry material
         * digits past 4dp, which the exact-decimal tree rollup cannot hold. Column
         * sums must be rounded to ledger scale once, in SQL, before the rollup.
         */
        test('translated matrix columns round to 4dp instead of throwing', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const usdId = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into subsidiaries
                (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
                values (${usdId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
              await db.execute(sql`insert into consolidated_fx_rates
                (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
                values (${scratch.orgId}, ${scratch.periodId}, 'USD', 'CAD', '1.2345678901', '1.2345678901', '1.2345678901', 'manual')`)
              await postManual(scratch, 'MATRIX-FX', scratch.date, scratch.periodId, usdId, [
                [scratch.accounts.bank, '100.0000'],
                [scratch.accounts.revenue, '-100.0000'],
              ])
            })
            const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => {
              const view = await resolveSubsidiaryView(scratch.subsidiaryId, '2026-07-31')
              return statementMatrix({
                orgId: scratch.orgId, types: ['income'], mode: 'flow',
                period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
                subsidiary: view.subsidiary,
              })
            }))
            const revenue = matrix.rows.find((r) => r.id === scratch.accounts.revenue)
            assert.ok(revenue)
            // round(100 x 1.2345678901, 4) = 123.4568, reader-signed positive.
            assert.deepEqual(revenue.values, ['123.4568'])
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })

        test('cash-basis matrix columns round fractional settled shares to 4dp', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            await withBypass(async () => {
              // Invoice 30 (open-item AR leg) + payment 10 through the bank: the
              // settled share 10/30 does not terminate, so the recognized revenue
              // line carries digits past 4dp.
              const inv = randomUUID()
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${inv}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'MATRIX-INV', ${scratch.date}, ${scratch.periodId}, 'inv', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
                values (${scratch.orgId}, ${inv}, 1, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, '30', 'CAD', '30', '1', true),
                       (${scratch.orgId}, ${inv}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, '-30', 'CAD', '-30', '1', false)`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${inv}`)
              const pay = randomUUID()
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'MATRIX-PAY', ${scratch.date}, ${scratch.periodId}, 'pay', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
                values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, '10', 'CAD', '10', '1', false),
                       (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, '-10', 'CAD', '-10', '1', true)`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
              const arLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${inv} and is_open_item`)).rows[0]!.id
              const payArLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${pay} and is_open_item`)).rows[0]!.id
              await db.execute(sql`insert into applications
                (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
                 source_transaction_currency, target_transaction_amount, target_transaction_currency,
                 settlement_rate, settlement_rate_source, settlement_rate_reference)
                values (${scratch.orgId}, ${payArLine}, ${arLine}, '10', ${scratch.date}, '10', '10', 'CAD', '10', 'CAD',
                  '1', 'same_currency', 'MATRIX-TEST')`)
            })
            // Scoped like the translated case above: the web request-org resolver
            // denies unscoped reads under pooled RLS, so a bare call returns zero
            // rows instead of the settled share.
            const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
              orgId: scratch.orgId, types: ['income'], mode: 'flow', basis: 'cash',
              period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
            })))
            const revenue = matrix.rows.find((r) => r.id === scratch.accounts.revenue)
            assert.ok(revenue)
            // 30 recognized at a 1/3 share = 10.0000, reader-signed positive.
            assert.deepEqual(revenue.values, ['10.0000'])
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })


        const consolidatedRows = [
          { label: "statement matrix control loss", register: async () => {
                const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
                const { randomUUID } = await import("node:crypto");
                const test = (await import("node:test")).default;
                type StatementSubsidiaryContext = import("./statement-matrix").StatementSubsidiaryContext;
                const { sql } = await import("drizzle-orm");
                const { db, env, withBypass, withOrgContext } =
                  await import("@openbooks/engine/src/platform/db.ts");
                const { createScratchOrg, dropScratchOrg } =
                  await import("@openbooks/engine/src/testing/fixtures.ts");
                const { statementMatrix } = await import("./statement-matrix");


                test(
                  "disposed foreign subsidiary retains pre-disposal income and frozen balances without future rates",
                  { skip: !env.OPENBOOKS_DB_URL },
                  async () => {
                    const org = await withBypass(() => createScratchOrg());
                    try {
                      const child = randomUUID(),
                        equity = randomUUID();
                      await withBypass(async () => {
                        await db.execute(
                          sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination) values(${child},${org.orgId},${org.subsidiaryId},'Disposed foreign entity','USD','US',true,false)`,
                        );
                        await db.execute(
                          sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary) values(${equity},${org.orgId},'LOSS-EQ','Historic equity','equity',true,false)`,
                        );
                        for (const [date, amount, credit] of [
                          ["2026-07-01", "1000", equity],
                          ["2026-07-15", "100", org.accounts.revenue],
                          ["2026-07-25", "900", org.accounts.revenue],
                        ]) {
                          const id = randomUUID();
                          await db.execute(
                            sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values(${id},${org.orgId},${org.bookId},${child},${id},${date},${org.periodId},'draft','manual')`,
                          );
                          await db.execute(
                            sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate) values(${org.orgId},${id},1,${org.accounts.bank},${child},${amount},'USD',${amount},1),(${org.orgId},${id},2,${credit},${child},-${amount}::numeric,'USD',-${amount}::numeric,1)`,
                          );
                          await db.execute(
                            sql`update journal_entries set status='posted',posted_at=now() where org_id=${org.orgId} and id=${id}`,
                          );
                        }
                      });
                      const subsidiary: StatementSubsidiaryContext = {
                        ids: [org.subsidiaryId, child],
                        rates: [
                          {
                            subsidiaryId: child,
                            currency: "USD",
                            periodFrom: "2026-07-01",
                            periodTo: "2026-07-31",
                            averageRate: "1.2",
                            currentRate: "1.3",
                            historicalRate: "0.9",
                          },
                        ],
                        controlLosses: [
                          {
                            subsidiaryId: child,
                            through: "2026-07-20",
                            closingRate: "1.1",
                            factor: "1",
                          },
                        ],
                      };
                      await withBypass(() =>
                        withOrgContext(org.orgId, async () => {
                          const flow = await statementMatrix({
                            orgId: org.orgId,
                            types: ["income"],
                            mode: "flow",
                            period: { from: "2026-07-01", to: "2026-08-31" },
                            periodLabel: "Through August",
                            subsidiary,
                          });
                          assert.deepEqual(
                            flow.rows.find((r) => r.id === org.accounts.revenue)?.values,
                            ["120.0000"],
                          );
                          const later = await statementMatrix({
                            orgId: org.orgId,
                            types: ["income"],
                            mode: "flow",
                            period: { from: "2026-08-01", to: "2026-08-31" },
                            periodLabel: "August",
                            subsidiary,
                          });
                          assert.ok(
                            !later.rows.find((r) => r.id === org.accounts.revenue) ||
                              later.rows
                                .find((r) => r.id === org.accounts.revenue)!
                                .values.every((value) => value === "0.0000"),
                          );
                          const balance = await statementMatrix({
                            orgId: org.orgId,
                            types: ["asset_bank", "equity"],
                            mode: "balance",
                            period: { from: "2026-08-01", to: "2026-08-31" },
                            periodLabel: "August",
                            subsidiary,
                          });
                          assert.deepEqual(
                            balance.rows.find((r) => r.id === org.accounts.bank)?.values,
                            ["1210.0000"],
                          );
                          assert.deepEqual(balance.rows.find((r) => r.id === equity)?.values, [
                            "900.0000",
                          ]);
                          // A comparative before disposal still translates using its own period.
                          const before = await statementMatrix({
                            orgId: org.orgId,
                            types: ["asset_bank"],
                            mode: "balance",
                            period: { from: "2026-07-01", to: "2026-07-10" },
                            periodLabel: "Before sale",
                            subsidiary,
                          });
                          assert.deepEqual(
                            before.rows.find((r) => r.id === org.accounts.bank)?.values,
                            ["1300.0000"],
                          );
                          // Missing pre-disposal history must still refuse; a cutoff is no waiver.
                          await assert.rejects(
                            () =>
                              statementMatrix({
                                orgId: org.orgId,
                                types: ["income"],
                                mode: "flow",
                                period: { from: "2026-06-01", to: "2026-08-31" },
                                periodLabel: "Missing June",
                                subsidiary,
                              }),
                            /exchange rates/,
                          );
                        }),
                      );
                    } finally {
                      await withBypass(() => dropScratchOrg(org.orgId));
                    }
                  },
                );
          } },
          { label: "statement matrix draft columns", register: async () => {
                const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
                const { randomUUID } = await import("node:crypto");
                const test = (await import("node:test")).default;
                const { sql } = await import('drizzle-orm')
                const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
                const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
                const { statementMatrix } = await import('./statement-matrix')

                /**
                 * Breakout columns must come from the same posted set the aggregation reads.
                 * A draft entry tagging an otherwise-inactive department must not mint a
                 * zero-valued column (which, at the 24-column cap, can displace a real one),
                 * and draft-only untagged lines must not mint an "Unassigned" column.
                 */
                test('department breakout ignores draft entries when discovering columns', { skip: !env.OPENBOOKS_DB_URL }, async () => {
                  const scratch = await withBypass(() => createScratchOrg())
                  try {
                    const deptA = randomUUID(), deptB = randomUUID()
                    const postEntry = randomUUID(), draftEntry = randomUUID()
                    await withBypass(async () => {
                      await db.execute(sql`insert into departments (id, org_id, name, is_active)
                        values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true),
                               (${deptB}, ${scratch.orgId}, 'ZZZ Draft Dept', true)`)
                      await db.execute(sql`insert into journal_entries
                        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                        values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                          'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
                          (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                          'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
                      await db.execute(sql`insert into journal_lines
                        (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
                        values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
                          (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
                          (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptB}, '50', 'CAD', '50', '1'),
                          (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptB}, '-50', 'CAD', '-50', '1')`)
                      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
                    })
                    // Scoped like the cash-basis precision case: the web
                    // request-org resolver denies unscoped reads under pooled RLS, so a bare
                    // call returns zero rows and mints no columns at all.
                    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
                      orgId: scratch.orgId, types: ['income'], mode: 'flow',
                      period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
                      breakout: 'department',
                    })))
                    assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
                    assert.equal(matrix.truncated, false)
                  } finally {
                    await withBypass(() => dropScratchOrg(scratch.orgId))
                  }
                })

                test('department breakout ignores draft-only untagged lines for the Unassigned column', { skip: !env.OPENBOOKS_DB_URL }, async () => {
                  const scratch = await withBypass(() => createScratchOrg())
                  try {
                    const deptA = randomUUID()
                    const postEntry = randomUUID(), draftEntry = randomUUID()
                    await withBypass(async () => {
                      await db.execute(sql`insert into departments (id, org_id, name, is_active)
                        values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true)`)
                      await db.execute(sql`insert into journal_entries
                        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                        values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                          'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
                          (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                          'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
                      await db.execute(sql`insert into journal_lines
                        (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
                        values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
                          (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
                          (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, null, '50', 'CAD', '50', '1'),
                          (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, null, '-50', 'CAD', '-50', '1')`)
                      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
                    })
                    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
                      orgId: scratch.orgId, types: ['income'], mode: 'flow',
                      period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
                      breakout: 'department',
                    })))
                    assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
                  } finally {
                    await withBypass(() => dropScratchOrg(scratch.orgId))
                  }
                })
          } },
        ] as const;

        for (const row of consolidatedRows) await row.register();
  } },
] as const;

for(const row of consolidatedRows) await row.register();


const statementActivityCases = [
  { label: "transaction detail cash basis", register: async () => {
        const { pathToFileURL } = await import('node:url');
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { randomUUID } = await import('node:crypto');
        /**
         * Cash-basis statement cells recognize accrual documents at their settled
         * share (the matrix's settlement-share cash logic), but the ledger drill-down
         * behind those cells only listed entries that themselves touch a bank account —
         * so a partially paid invoice's revenue never appeared and the drill net could
         * not tie to the clicked cell. The drill must mirror the matrix engine.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')
        const { transactionDetail } = (await import(root + 'web/lib/reports/transaction-detail.ts')) as typeof import('./reports/transaction-detail')

        test('cash-basis drill-down ties to the cash-basis statement cell', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, 'Cash drill writer', 'admin')
              const invoiceLine = randomUUID()
              const paymentLine = randomUUID()
              const paymentArLine = randomUUID()
              const invoice = randomUUID()
              await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${invoice}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CASH-INV-1', '2026-07-05', ${org.periodId}, 'CASH-INV-1', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
                values (${invoiceLine}, ${org.orgId}, ${invoice}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, true, '1000.0000', 'CAD', '1000.0000', '1'),
                       (${randomUUID()}, ${org.orgId}, ${invoice}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${org.customerId}, false, '-1000.0000', 'CAD', '-1000.0000', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${invoice}`)
              const payment = randomUUID()
              await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${payment}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CASH-PAY-1', '2026-07-10', ${org.periodId}, 'CASH-PAY-1', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
                values (${paymentLine}, ${org.orgId}, ${payment}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.customerId}, false, '600.0000', 'CAD', '600.0000', '1'),
                       (${paymentArLine}, ${org.orgId}, ${payment}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, true, '-600.0000', 'CAD', '-600.0000', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${payment}`)
              await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on, created_by, updated_by)
                values (${org.orgId}, ${paymentArLine}, ${invoiceLine}, '600.0000', '600.0000', '600.0000', 'CAD', '600.0000', 'CAD', '1', 'same_currency', 'cash drill tie-out', '2026-07-10', ${actor}, ${actor})`)
            })
            await withOrgContext(org.orgId, async () => {
              const period = { from: '2026-07-01', to: '2026-07-31' }
              const matrix = await statementMatrix({
                orgId: org.orgId,
                types: [...PNL_TYPES],
                mode: 'flow',
                period,
                periodLabel: 'July 2026',
                basis: 'cash',
              })
              const revenue = matrix.rows.find((r) => r.type === 'income')
              assert.ok(revenue, 'expected a revenue row')
              assert.equal(toUnits(String(revenue.values[0])), toUnits('600.0000'), 'cash basis recognizes the 60% settled share')

              const drill = await transactionDetail({
                orgId: org.orgId,
                accountTypes: ['income', 'income_other'],
                from: period.from,
                to: period.to,
                mode: 'flow',
                basis: 'cash',
              })
              assert.equal(toUnits(String(drill.net)), toUnits('600.0000'), 'cash-basis drill net ties to the cash-basis cell')

              // Accrual drill is unchanged: the full invoice.
              const accrual = await transactionDetail({
                orgId: org.orgId,
                accountTypes: ['income', 'income_other'],
                from: period.from,
                to: period.to,
                mode: 'flow',
                basis: 'accrual',
              })
              assert.equal(toUnits(String(accrual.net)), toUnits('1000.0000'))
            })
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
  { label: "trial balance activity", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { trialBalance } = await import('./reports/statements.ts')

        /**
         * The trial balance is headed "accounts with activity" but dropped
         * zero-balance accounts with real postings (an investment account with
         * several fiscal-year legs that closed at zero), understating gross
         * debit/credit flows. Every account with postings must appear with its
         * debit/credit legs on both TB paths (summary-backed and line-backed).
         */
        test('trial balance keeps zero-balance accounts that had activity', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const washId = randomUUID()
            const deptId = randomUUID()
            await withBypass(async () => {
              await db.execute(sql`insert into accounts (id, org_id, number, name, type)
                values (${washId}, ${scratch.orgId}, '1997', 'Wash Account', 'asset_current_other')`)
              await db.execute(sql`insert into departments (id, org_id, name)
                values (${deptId}, ${scratch.orgId}, 'Wash Department')`)
              // A wash: debits = credits = 500, closing balance zero — the 1055 shape.
              const entry = randomUUID()
              await db.execute(sql`insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
                values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
                  'WASH-1', ${scratch.date}, ${scratch.periodId}, 'wash', 'draft', 'manual')`)
              await db.execute(sql`insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
                values (${scratch.orgId}, ${entry}, 1, ${washId}, ${scratch.subsidiaryId}, ${deptId}, '500', 'CAD', '500', '1'),
                       (${scratch.orgId}, ${entry}, 2, ${washId}, ${scratch.subsidiaryId}, ${deptId}, '-500', 'CAD', '-500', '1')`)
              await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
            })

            const asOf = scratch.date
            const summaryRows = await withBypassContext(() => trialBalance(asOf, undefined, scratch.orgId))
            const wash = summaryRows.find((r) => r.number === '1997')
            assert.ok(wash, 'zero-balance wash account appears on the summary path')
            assert.equal(wash.debits, '500.0000')
            assert.equal(wash.credits, '500.0000')

            const lineRows = await withBypassContext(() => trialBalance(asOf, { departmentId: deptId }, scratch.orgId))
            const washDept = lineRows.find((r) => r.number === '1997')
            assert.ok(washDept, 'zero-balance wash account appears on the line path')
            assert.equal(washDept.debits, '500.0000')
            assert.equal(washDept.credits, '500.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for (const row of statementActivityCases) await row.register();


const partnerStatementCases = [
  { label: "partner statement quiet party", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { partnerStatement } = await import('./reports/registers')

        /**
         * A party statement is addressed to ONE party: its opening and closing must
         * reflect that party's control-account balance even when the party has no
         * lines inside the window. A July invoice with no August activity still owes
         * 100 on an August statement — opening 100, no lines, closing 100 — never a
         * zero statement beside a 100 aging footer.
         */
        test('partner statement keeps the balance for a party with no window activity', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Statement Controller', 'admin'))
            await withBypass(async () => {
              const id = randomUUID()
              await db.execute(sql`insert into documents
                (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
                 currency, fx_rate, subtotal, tax_total, total, created_by)
                values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
                  ${scratch.customerId}, '2026-07-10', 'CAD', '1', 100, 0, 100, ${actor})`)
              await db.execute(sql`insert into document_lines
                (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
                values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
              await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
              await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
            })
            // The statement reader issues bare queries with explicit org predicates,
            // which pooled RLS denies outside an explicit scope (unscoped it reads
            // zero rows and the balance asserts below read '0.0000'/undefined).
            const st = await withOrgContext(scratch.orgId, () => partnerStatement(scratch.customerId, scratch.orgId, {
              from: '2026-08-01', to: '2026-08-31', side: 'ar',
            }))
            assert.equal(st.opening, '100.0000')
            assert.equal(st.closing, '100.0000')
            assert.deepEqual(st.lines, [])
            assert.equal(st.aging.total, '100.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for (const row of partnerStatementCases) await row.register();

const multiBookStatementsCases = [{ label: "multi-book-statements", register: async () => {
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { spawnSync } = await import("node:child_process");
const test = (await import("node:test")).default;
const { env } = await import("@openbooks/engine/src/platform/db.ts");
test(
  "statements answer per accounting book across summary, raw, and trial-balance paths",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { readFileSync } from "node:fs";
      import { sql } from "drizzle-orm";
      import { db, withBypass, withBypassContext, withOrg } from "./engine/src/platform/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
      import {
        createScratchOrg,
        createScratchUser,
        dropScratchOrg,
      } from "./engine/src/testing/fixtures.ts";

      // Web modules install the normal request resolver during evaluation.
      // Re-establish the explicit test-only trusted boundary afterwards.
      installTrustedTestDatabaseBypass();
      const scratch = await createScratchOrg();
      try {
        // A second, parallel book. journal_entries.book_id is mandatory, so
        // identical activity in both books must never fuse into one total.
        const taxBookId = randomUUID();
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);

        const departmentId = randomUUID();
        await db.execute(sql\`
          insert into departments (id, org_id, name)
          values (\${departmentId}, \${scratch.orgId}, 'Ops')\`);

        // Post the SAME -100 revenue to each book CONCURRENTLY. Pre-0016 this
        // raced into one gl_month_activity row crediting 200 for the pair.
        const postRevenue = async (bookId, tag) => {
          const entryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${'MULTIBOOK-' + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               department_id, amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, \${departmentId}, '100.0000', 'CAD', '100.0000', '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${departmentId}, '-100.0000', 'CAD', '-100.0000', '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
          return entryId;
        };
        const [primaryEntryId] = await Promise.all([
          postRevenue(scratch.bookId, 'PRI'),
          postRevenue(taxBookId, 'TAX'),
        ]);
        assert.ok(primaryEntryId);

        // The derived key carries book_id and the trigger maintenance kept the
        // books apart under concurrent posting: two rows, -100 revenue credit
        // each — not one fused row of -200.
        const summaryRows = await db.execute(sql\`
          select g.book_id, g.debit_total, g.credit_total, g.line_count
            from gl_month_activity g
           where g.org_id = \${scratch.orgId}
             and g.account_id = \${scratch.accounts.revenue}\`);
        const byBook = new Map(summaryRows.rows.map((r) => [r.book_id, r]));
        assert.equal(summaryRows.rows.length, 2, "summary keeps one row per book: " + JSON.stringify(summaryRows.rows));
        for (const bookId of [scratch.bookId, taxBookId]) {
          const row = byBook.get(bookId);
          assert.ok(row, "row exists for each book");
          assert.equal(row.credit_total, "100.0000");
          assert.equal(row.debit_total, "0.0000");
          assert.equal(row.line_count, "1");
        }

        // The trigger-maintained summary agrees with the ledger per book
        // (verify returns only mismatching rows).
        const mismatches = await db.execute(sql\`
          select * from openbooks_gl_activity_verify(\${scratch.orgId})\`);
        assert.deepEqual(mismatches.rows, []);

        await withOrg(scratch.orgId, async () => {
          const { statementMatrix, PNL_TYPES } = await import("./web/lib/statement-matrix.ts");
          const { partnerBalances, trialBalance } = await import("./web/lib/reports/statements.ts");
          const period = { from: scratch.date, to: scratch.date };
          const readerRevenue = (matrix) => {
            const row = matrix.rows.find((r) => r.id === scratch.accounts.revenue);
            return row ? String(row.values[0]) : null;
          };

          // Summarized path (whole months from gl_month_activity): -100 of
          // revenue reads as +100 for EACH selected book; omitting the book
          // answers for the primary book only — never the merged pair.
          for (const [bookId, expected] of [[scratch.bookId, "100.0000"], [taxBookId, "100.0000"]]) {
            const matrix = await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
              bookId,
            });
            assert.equal(readerRevenue(matrix), expected, "summarized path book-scoped");
          }
          const defaultMatrix = await statementMatrix({
            types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook" });
          assert.equal(readerRevenue(defaultMatrix), "100.0000", "default report scope is the primary book");

          // Raw path (a line-level dimension filter disables the summary): a
          // department slice matches both books' lines, yet each book still
          // reports exactly its own -100 — no double counting.
          for (const bookId of [scratch.bookId, taxBookId]) {
            const raw = await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
              dims: { departmentId }, bookId,
            });
            assert.equal(raw.truncated, false);
            assert.equal(readerRevenue(raw), "100.0000", "raw path book-scoped");
          }

          // Split-month windows ride the union leg (lines) for the boundary
          // month; the book filter must hold there too.
          const splitFrom = scratch.date.slice(0, 8) + "10";
          const splitTo = scratch.date.slice(0, 8) + "20";
          for (const bookId of [scratch.bookId, taxBookId]) {
            const split = await statementMatrix({
              types: PNL_TYPES, mode: "flow",
              period: { from: splitFrom, to: splitTo }, periodLabel: "multibook",
              bookId,
            });
            assert.equal(readerRevenue(split), "100.0000", "split-month union leg book-scoped");
          }

          // Trial balance: per book the revenue credit shows as 100 credits /
          // -100 balance; the default scope stays primary-only.
          for (const [bookId, label] of [[scratch.bookId, "primary"], [taxBookId, "tax"]]) {
            const tb = await trialBalance(scratch.date, undefined, scratch.orgId, bookId);
            const revenue = tb.find((r) => r.id === scratch.accounts.revenue);
            const bank = tb.find((r) => r.id === scratch.accounts.bank);
            assert.ok(revenue, label + " book trial balance has revenue");
            assert.equal(revenue.credits, "100.0000");
            assert.equal(revenue.balance, "-100.0000");
            assert.ok(bank, label + " book trial balance has bank");
            assert.equal(bank.debits, "100.0000");
          }
          const defaultTb = await trialBalance(scratch.date, undefined, scratch.orgId);
          assert.equal(defaultTb.find((r) => r.id === scratch.accounts.revenue)?.credits, "100.0000");

          // Partner control totals must follow the same one-book statement
          // scope as account/trial-balance readers. Seed different AR/AP
          // balances in each book so an unscoped query cannot pass by
          // returning an indistinguishable value.
          const postPartnerBalance = async (bookId, accountId, partyId, controlAmount, tag) => {
            const entryId = randomUUID();
            const offsetAmount = controlAmount.startsWith("-")
              ? controlAmount.slice(1)
              : "-" + controlAmount;
            await db.execute(sql\`
              insert into journal_entries
                (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                 period_id, memo, status, origin)
              values
                (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
                 \${"MULTIBOOK-PARTNER-" + tag}, \${scratch.date}, \${scratch.periodId},
                 \${tag}, 'draft', 'manual')\`);
            await db.execute(sql\`
              insert into journal_lines
                (org_id, entry_id, line_number, account_id, subsidiary_id,
                 amount, currency, txn_amount, fx_rate, party_id, is_open_item)
              values
                (\${scratch.orgId}, \${entryId}, 1, \${accountId}, \${scratch.subsidiaryId},
                 \${controlAmount}, 'CAD', \${controlAmount}, '1', \${partyId}, true),
                (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.bank}, \${scratch.subsidiaryId},
                 \${offsetAmount}, 'CAD', \${offsetAmount}, '1', null, false)\`);
            await db.execute(sql\`
              update journal_entries set status = 'posted', posted_at = now()
               where id = \${entryId}\`);
          };
          await postPartnerBalance(scratch.bookId, scratch.accounts.ar, scratch.customerId, "125.0000", "AR-PRI");
          await postPartnerBalance(taxBookId, scratch.accounts.ar, scratch.customerId, "275.0000", "AR-TAX");
          await postPartnerBalance(scratch.bookId, scratch.accounts.ap, scratch.vendorId, "-80.0000", "AP-PRI");
          await postPartnerBalance(taxBookId, scratch.accounts.ap, scratch.vendorId, "-190.0000", "AP-TAX");

          const partnerBalance = async (kind, bookId, partyId, expected) => {
            const rows = await partnerBalances(kind, scratch.orgId, scratch.date, bookId);
            const row = rows.find((r) => r.id === partyId);
            assert.ok(row, kind + " row exists for selected book");
            assert.equal(row.balance, expected, kind + " balance is scoped to selected book");
          };
          await partnerBalance("receivable", scratch.bookId, scratch.customerId, "125.0000");
          await partnerBalance("receivable", taxBookId, scratch.customerId, "275.0000");
          await partnerBalance("payable", scratch.bookId, scratch.vendorId, "-80.0000");
          await partnerBalance("payable", taxBookId, scratch.vendorId, "-190.0000");
          const defaultReceivables = await partnerBalances("receivable", scratch.orgId, scratch.date);
          const defaultPayables = await partnerBalances("payable", scratch.orgId, scratch.date);
          assert.equal(defaultReceivables.find((r) => r.id === scratch.customerId)?.balance, "125.0000");
          assert.equal(defaultPayables.find((r) => r.id === scratch.vendorId)?.balance, "-80.0000");

          // Cash basis recognizes an accrual invoice through its settlement.
          // The matrix rewrites line VALUES on cash basis: bank-backed entries
          // count in full, and a settled accrual document enters at the settled
          // share of its control leg — so revenue booked on an invoice
          // (DR AR / CR revenue) must surface once a bank payment applies to
          // it, instead of being dropped because neither entry alone carries
          // both the bank line and the revenue line.
          const actorId = await createScratchUser(scratch.orgId, "Tester", "accountant");
          const cashRevenue = async () => {
            const matrix = await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
              basis: "cash",
            });
            return readerRevenue(matrix);
          };
          // Control: the direct bank-backed entry still reports on cash basis.
          assert.equal(await cashRevenue(), "100.0000", "bank-backed entry reports on cash basis");

          const invoiceId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${invoiceId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
               'MULTIBOOK-INV', \${scratch.date}, \${scratch.periodId},
               'cash-basis invoice', 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate, party_id, is_open_item)
            values
              (\${scratch.orgId}, \${invoiceId}, 1, \${scratch.accounts.ar},
               \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1',
               \${scratch.customerId}, true),
              (\${scratch.orgId}, \${invoiceId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1',
               \${scratch.customerId}, false)\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${invoiceId}\`);
          assert.equal(await cashRevenue(), "100.0000", "unpaid accrual invoice stays off cash basis");
          assert.equal(
            readerRevenue(await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
            })),
            "200.0000", "accrual books the invoice at once");

          // Settle it: DR bank 100 / CR AR 100 applied to the invoice's open AR
          // line. Cash-basis revenue must now recognize the settled invoice's
          // revenue — before settlements pulled accrual documents onto cash
          // basis this read only the bank entry's 100.
          const paymentId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${paymentId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
               'MULTIBOOK-PAY', \${scratch.date}, \${scratch.periodId},
               'cash-basis payment', 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate, party_id, is_open_item)
            values
              (\${scratch.orgId}, \${paymentId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1',
               \${scratch.customerId}, false),
              (\${scratch.orgId}, \${paymentId}, 2, \${scratch.accounts.ar},
               \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1',
               \${scratch.customerId}, true)\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${paymentId}\`);
          const [invoiceArLine] = (await db.execute(sql\`
            select id from journal_lines
             where org_id = \${scratch.orgId} and entry_id = \${invoiceId} and is_open_item\`)).rows.map((r) => r.id);
          const [paymentArLine] = (await db.execute(sql\`
            select id from journal_lines
             where org_id = \${scratch.orgId} and entry_id = \${paymentId} and is_open_item\`)).rows.map((r) => r.id);
          await db.execute(sql\`
            insert into applications
              (org_id, from_line_id, to_line_id, amount, source_amount,
               source_transaction_amount, source_transaction_currency,
               target_transaction_amount, target_transaction_currency,
               settlement_rate, settlement_rate_source, settlement_rate_reference,
               applied_on, created_by, updated_by)
            values
              (\${scratch.orgId}, \${paymentArLine}, \${invoiceArLine},
               '100.0000', '100.0000', '100.0000', 'CAD', '100.0000', 'CAD',
               1, 'same_currency', 'multi-book cash-basis regression',
               \${scratch.date}, \${actorId}, \${actorId})\`);
          assert.equal(await cashRevenue(), "200.0000", "paid accrual invoice recognizes revenue on cash basis");
        });

        // Migration atomicity: replaying 0016 inside a transaction that then
        // FAILS must leave the prior summary exactly as it was — same shape,
        // same rows, working trigger maintenance — after rollback recovers it.
        // Explicit bypass scope: the lazy web imports above replace the test
        // bypass resolver, so past this point an unscoped client runs deny-all
        // and this whole check goes vacuous (replay touches zero rows, the
        // forced insert inserts zero rows and never conflicts).
        await withBypassContext(async () => {
                const migration = readFileSync(
                  "schema/migrations/generated/0016_gl_month_activity_book_id.sql", "utf8");
                const before = await db.execute(sql\`
                  select book_id, account_id, month, subsidiary_id, debit_total, credit_total, line_count
                    from gl_month_activity where org_id = \${scratch.orgId} order by account_id, book_id\`);
                await assert.rejects(
                  withBypass(async () => {
                    await db.execute(sql.raw(migration));
                    // The trusted maintenance transaction must see the seeded
                    // summary row; a constrained raw pool could see zero rows.
                    const visible = await db.execute(sql\`
                      select account_id from gl_month_activity where org_id = \${scratch.orgId} limit 1\`);
                    assert.equal(visible.rows.length, 1, "migration rollback probe sees seeded summary evidence");
                    // Force a duplicate against the NEW constraint mid-flight.
                    await db.execute(sql\`
                      insert into gl_month_activity (org_id, account_id, book_id, month, subsidiary_id)
                      select org_id, account_id, book_id, month, subsidiary_id
                        from gl_month_activity where org_id = \${scratch.orgId} limit 1\`);
                    assert.fail("forced duplicate-key failure did not raise");
                  }),
                  (error) => {
                    let current = error;
                    while (current && typeof current === "object") {
                      if (current.code === "23505" && current.constraint === "gl_month_activity_pkey") return true;
                      current = current.cause;
                    }
                    return false;
                  },
                  "duplicate summary evidence rolls back the whole migration replay",
                );
                const after = await db.execute(sql\`
                  select book_id, account_id, month, subsidiary_id, debit_total, credit_total, line_count
                    from gl_month_activity where org_id = \${scratch.orgId} order by account_id, book_id\`);
                assert.deepEqual(after.rows, before.rows, "failed migration preserved the prior summary rows");

                // And the recovered summary still maintains itself: another posting
                // lands on its own per-book row via the triggers.
                const extraEntry = randomUUID();
                await db.execute(sql\`
                  insert into journal_entries
                    (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                     period_id, memo, status, origin)
                  values
                    (\${extraEntry}, \${scratch.orgId}, \${taxBookId}, \${scratch.subsidiaryId},
                     'MULTIBOOK-AFTER', \${scratch.date}, \${scratch.periodId}, 'after',
                     'draft', 'manual')\`);
                await db.execute(sql\`
                  insert into journal_lines
                    (org_id, entry_id, line_number, account_id, subsidiary_id,
                     amount, currency, txn_amount, fx_rate)
                  values
                    (\${scratch.orgId}, \${extraEntry}, 1, \${scratch.accounts.bank},
                     \${scratch.subsidiaryId}, '50.0000', 'CAD', '50.0000', '1'),
                    (\${scratch.orgId}, \${extraEntry}, 2, \${scratch.accounts.revenue},
                     \${scratch.subsidiaryId}, '-50.0000', 'CAD', '-50.0000', '1')\`);
                await db.execute(sql\`
                  update journal_entries set status = 'posted', posted_at = now()
                   where id = \${extraEntry}\`);
                const postRollback = await db.execute(sql\`
                  select g.credit_total from gl_month_activity g
                   where g.org_id = \${scratch.orgId}
                     and g.account_id = \${scratch.accounts.revenue}
                     and g.book_id = \${taxBookId}\`);
                assert.deepEqual(postRollback.rows.map((r) => r.credit_total).sort(), ["150.0000"]);
        });
      } finally {
        await withBypass(() => dropScratchOrg(scratch.orgId));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);

const consolidatedRows = [
  { label: "multi book balance readers", register: async () => {
        // Database partition: this drives the real balance readers against
        // PostgreSQL (scratch org, parallel tax book, July fiscal year). The unit
        // partition has no database, so it lives under the .integration suffix
        // with no skip guard.
        test("all balance readers stay on the primary accounting book", () => {
            const source = `
              import assert from "node:assert/strict";
              import { randomUUID } from "node:crypto";
              import { sql } from "drizzle-orm";
              import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
              import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
              import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

              installTrustedTestDatabaseBypass();
              const scratch = await createScratchOrg();
              try {
                const taxBookId = randomUUID();
                await db.execute(sql\`
                  insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
                  values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);

                // A July fiscal year makes the June summary row prior-year P&L. The
                // accounts list, the COA balance AND the GL opening must all exclude
                // it: P&L resets at the fiscal-year boundary, so only balance-sheet
                // accounts carry inception-to-date openings into a mid-year report.
                // The boundary is declared for real (a July-start default calendar),
                // not just flipped in settings, and the June seed row below is what
                // proves all three readers exclude it.
                await db.execute(sql\`
                  update orgs
                     set settings = jsonb_set(settings, '{fiscalYearStartMonth}', '7'::jsonb, true)
                   where id = \${scratch.orgId}\`);
                await db.execute(sql\`
                  update fiscal_calendars set is_default = false
                   where org_id = \${scratch.orgId} and is_default\`);
                await db.execute(sql\`
                  insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, is_default, is_active)
                  values (\${randomUUID()}, \${scratch.orgId}, 'July fiscal year', 'monthly', 7, true, true)\`);
                await db.execute(sql\`
                  insert into gl_month_activity
                    (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
                  values
                    (\${scratch.orgId}, \${scratch.accounts.revenue}, \${scratch.bookId}, '2026-06-01',
                     \${scratch.subsidiaryId}, '0.0000', '25.0000', 1)\`);

                const postEntry = async (bookId, tag) => {
                  const entryId = randomUUID();
                  await db.execute(sql\`
                    insert into journal_entries
                      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                       period_id, memo, status, origin)
                    values
                      (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
                       \${'BALANCE-' + tag}, \${scratch.date}, \${scratch.periodId},
                       \${tag}, 'draft', 'manual')\`);
                  await db.execute(sql\`
                    insert into journal_lines
                      (org_id, entry_id, line_number, account_id, subsidiary_id,
                       amount, currency, txn_amount, fx_rate)
                    values
                      (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
                       \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
                      (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
                       \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1')\`);
                  await db.execute(sql\`
                    update journal_entries set status = 'posted', posted_at = now()
                     where id = \${entryId}\`);
                };

                const categoryId = randomUUID();
                await db.execute(sql\`
                  insert into asset_categories
                    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
                     depreciation_expense_account_id)
                  values
                    (\${categoryId}, \${scratch.orgId}, 'Equipment', \${scratch.accounts.invAsset},
                     \${scratch.accounts.invAsset}, \${scratch.accounts.adjustment})\`);
                const assetId = randomUUID();
                await db.execute(sql\`
                  insert into fixed_assets
                    (id, org_id, category_id, asset_number, name, acquisition_cost,
                     subsidiary_id, status, acquired_on)
                  values
                    (\${assetId}, \${scratch.orgId}, \${categoryId}, 'FA-001', 'Equipment',
                     '100.0000', \${scratch.subsidiaryId}, 'in_service', \${scratch.date})\`);

                const seedDepreciation = async (bookId, tag) => {
                  const scheduleId = randomUUID();
                  await db.execute(sql\`
                    insert into depreciation_schedules
                      (id, org_id, asset_id, book_id, method, life_months)
                    values
                      (\${scheduleId}, \${scratch.orgId}, \${assetId}, \${bookId}, 'straight_line', 12)\`);
                  await db.execute(sql\`
                    insert into depreciation_schedule_lines
                      (id, org_id, schedule_id, period_id, sequence, planned_amount,
                       posted_amount, source)
                    values
                      (\${randomUUID()}, \${scratch.orgId}, \${scheduleId}, \${scratch.periodId},
                       1, '10.0000', '10.0000', 'imported')\`);
                  return tag;
                };

                await postEntry(scratch.bookId, 'PRIMARY');
                await seedDepreciation(scratch.bookId, 'PRIMARY');

                await withOrg(scratch.orgId, async () => {
                  const { generalLedger, journalReport } = await import("./web/lib/reports/ledger-reports.ts");
                  const { accountsWithBalances } = await import("./web/lib/data.ts");
                  const { accountBaseJoins } = await import("./web/lib/customization/entity-list-query/accounts.ts");
                  const { FIXED_ASSET_BASE_JOINS } = await import("./web/lib/customization/entity-list-query/fixed-assets.ts");

                  const readAll = async () => {
                    const ledger = await generalLedger(scratch.date, scratch.date, {
                      orgId: scratch.orgId,
                      accountId: scratch.accounts.revenue,
                    });
                    const journal = await journalReport(scratch.date, scratch.date, { orgId: scratch.orgId });
                    const balances = await accountsWithBalances(scratch.orgId, scratch.date);
                    const accountList = await db.execute(sql\`
                      select a.id, account_balance.amount
                        from accounts a
                        \${accountBaseJoins(scratch.date)}
                       where a.org_id = \${scratch.orgId} and a.id = \${scratch.accounts.revenue}\`);
                    const assets = await db.execute(sql\`
                      select a.id, a.acquisition_cost - depr.accumulated as net_book_value
                        from fixed_assets a
                        \${FIXED_ASSET_BASE_JOINS}
                       where a.org_id = \${scratch.orgId} and a.id = \${assetId}\`);
                    return {
                      ledger: ledger.accounts.map((account) => ({
                        id: account.id,
                        opening: String(account.opening),
                        closing: String(account.closing),
                        lines: account.lines.length,
                      })),
                      journal: journal.entries.map((entry) => ({
                        id: entry.id,
                        lines: entry.lines.length,
                        totalDebit: String(entry.totalDebit),
                      })),
                      revenueBalance: String(balances.find((row) => row.id === scratch.accounts.revenue)?.balance),
                      accountListBalance: String(accountList.rows[0]?.amount),
                      netBookValue: String(assets.rows[0]?.net_book_value),
                    };
                  };

                  const before = await readAll();
                  assert.equal(before.ledger.length, 1);
                  assert.equal(before.ledger[0].lines, 1);
                  assert.equal(before.ledger[0].opening, '0.0000');
                  assert.equal(before.ledger[0].closing, '-100.0000');
                  assert.equal(before.journal.length, 1);
                  assert.equal(before.journal[0].lines, 2);
                  assert.equal(before.revenueBalance, '100.0000');
                  assert.equal(before.accountListBalance, '100.0000');
                  assert.equal(before.netBookValue, '90.0000');

                  await postEntry(taxBookId, 'TAX');
                  await seedDepreciation(taxBookId, 'TAX');
                  const after = await readAll();
                  assert.deepEqual(after, before, 'adding a tax book must not alter any primary-book reader');
                });
              } finally {
                await withBypass(() => dropScratchOrg(scratch.orgId));
              }
            `;
            const result = spawnSync(
              process.execPath,
              ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
              { cwd: process.cwd(), env: process.env, encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stderr || result.stdout);
          },
        );
  } },
] as const;

for(const row of consolidatedRows) await row.register();
}}] as const; for (const row of multiBookStatementsCases) await row.register();
