import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

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
      import { generateAccountingPeriods } from "./engine/src/close.ts";
      import { deriveConsolidatedRates } from "./engine/src/consolidation.ts";
      import { db, withOrgContext } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./engine/src/test-fixtures.ts";
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
        accumulatedEarnings: "Accumulated earnings",
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
          assert.deepEqual(findLine(bs, "Accumulated earnings").values.slice(0, 1).map(n), [127.5]);
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
        "./engine/src/test-database-bypass.ts",
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
