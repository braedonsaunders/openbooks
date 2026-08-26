import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

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
      import { db, withOrgContext } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
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
        accumulatedEarnings: "Accumulated earnings",
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
        // May exists because the house equal-length comparative window starts
        // one day before the period's own start (2026-06-31-30 = 2026-05-31).
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
          const view = await resolveSubsidiaryView(undefined, period.to);
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
          const netIncome = findLine(pnl, "Net income");
          assert.deepEqual(netIncome.values.slice(0, 3).map(n), [140, 120, 20]);

          // Balance sheet: accumulated earnings are the lifetime P&L bucket, so
          // each cumulative column mixes both periods' averages — 260 total
          // (120 + 140), not 280. Assets translate at the current rate AS OF
          // each column's end (125 = 100 x 1.25 prior, 290 = 200 x 1.45 now),
          // and the CTA plug keeps every column balanced by construction.
          const bs = await balanceSheetView(period, "July 2026", bsLabels, { ...opts, compare: "prior_period" });
          assert.deepEqual(findLine(bs, "Accumulated earnings").values.slice(0, 2).map(n), [260, 120]);
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
          const refreshedView = await resolveSubsidiaryView(undefined, period.to);
          const refreshedOpts = { orgId: org.orgId, subsidiary: refreshedView.subsidiary };
          const refreshedPnl = await profitAndLossView(period, "July 2026", pnlLabels, { ...refreshedOpts, compare: "prior_period" });
          assert.deepEqual(findLine(refreshedPnl, "Net income").values.slice(0, 3).map(n), [150, 120, 30]);
          const refreshedBs = await balanceSheetView(period, "July 2026", bsLabels, { ...refreshedOpts, compare: "prior_period" });
          assert.deepEqual(findLine(refreshedBs, "Accumulated earnings").values.slice(0, 2).map(n), [270, 120]);
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
          const gappedView = await resolveSubsidiaryView(undefined, period.to);
          const gappedOpts = { orgId: org.orgId, subsidiary: gappedView.subsidiary };
          await assert.rejects(
            profitAndLossView(period, "July 2026", pnlLabels, { ...gappedOpts, compare: "prior_period" }),
            (error) => error instanceof MissingRatesError && /covering 2026-05-31\.\.2026-07-31/.test(error.message),
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
            resolveSubsidiaryView(undefined, period.to),
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
        "./engine/src/test-database-bypass.ts",
        "--input-type=module",
        "-e",
        source,
      ],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);
