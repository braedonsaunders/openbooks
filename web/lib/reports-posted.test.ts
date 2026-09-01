import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test("transaction detail scopes both reads to the statement accounting book", () => {
  const source = readFileSync(new URL("./reports/transaction-detail.ts", import.meta.url), "utf8");
  assert.match(source, /bookId\?: string \| null/);
  assert.match(source, /statementBookExpr/);
  assert.match(source, /const bookFilter = sql`e\.book_id = \$\{statementBookExpr\(orgId, opts\.bookId\)\}`/);
  assert.match(source, /and \$\{bookFilter\}/);
});

test("financial statements exclude draft and other unposted journals", { skip: !env.OPENBOOKS_DB_URL }, () => {
  // Web report modules intentionally import `server-only`. Run this DB-backed
  // contract in React's server condition so the test exercises the production
  // report implementation rather than copying its aggregation logic here.
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/db.ts";
    import { toUnits } from "./engine/src/money.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
    import { agingByParty, agingDetail, cashFlow, financialTrends, journalReport, profitAndLoss, projectProfitability, transactionDetail } from "./web/lib/reports.ts";

    // Exercise persistent application tenants only. Other DB-backed test files
    // create and delete short-lived orgs in parallel; sampling one between its
    // report query and expected-value query makes this contract race against
    // unrelated fixture teardown.
    const orgs = await db.execute(sql\`
      select o.id from orgs o
       where exists (select 1 from users u where u.org_id = o.id and u.is_active)
       order by o.id
    \`);
    for (const org of orgs.rows) {
      await withOrg(org.id, async () => {
        const report = await profitAndLoss("0001-01-01", "9999-12-31");
        const expected = await db.execute(sql\`
          select coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0)::text as revenue,
                 coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs,
                 coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0)::text as expenses
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
            join accounts a on a.id = l.account_id
           where l.org_id = \${org.id}
        \`);
        const row = expected.rows[0];
        assert.equal(toUnits(report.revenue), toUnits(row.revenue), org.id + " revenue");
        assert.equal(toUnits(report.cogs), toUnits(row.cogs), org.id + " COGS");
        assert.equal(toUnits(report.expenses), toUnits(row.expenses), org.id + " expenses");
        assert.equal(
          toUnits(report.netIncome),
          toUnits(row.revenue) - toUnits(row.cogs) - toUnits(row.expenses),
          org.id + " net income",
        );
        const journal = await journalReport("0001-01-01", "9999-12-31");
        assert.equal(
          new Set(journal.entries.map((entry) => entry.id)).size,
          journal.entries.length,
          org.id + " journal entries are grouped exactly once",
        );
        const projectReport = await projectProfitability("0001-01-01", "9999-12-31");
        assert.deepEqual(
          projectReport.customers.flatMap((customer) => customer.rows.map((row) => row.projectId)).sort(),
          projectReport.rows.map((row) => row.projectId).sort(),
          org.id + " every project appears in exactly one customer group",
        );
        for (const customer of projectReport.customers) {
          const moneySum = (key) => customer.rows.reduce((total, row) => total + toUnits(row[key]), 0n);
          for (const key of ["revenue", "cogs", "grossProfit", "expenses", "net"]) {
            assert.equal(
              toUnits(customer.totals[key]),
              moneySum(key),
              org.id + " " + (customer.customerName ?? "unassigned") + " " + key + " subtotal",
            );
          }
          assert.equal(customer.totals.hours, customer.rows.reduce((total, row) => total + row.hours, 0), org.id + " customer hours subtotal");
          if (customer.customerId) {
            const filtered = await projectProfitability("0001-01-01", "9999-12-31", { customerId: customer.customerId });
            assert.ok(filtered.rows.every((row) => row.customerId === customer.customerId), org.id + " customer filter scope");
            assert.deepEqual(
              filtered.rows.map((row) => row.projectId).sort(),
              customer.rows.map((row) => row.projectId).sort(),
              org.id + " customer filter completeness",
            );
            break;
          }
        }
        const sampleProject = projectReport.rows[0];
        if (sampleProject) {
          const grossDetail = await transactionDetail({
            accountTypes: ["income", "income_other", "cogs"],
            from: "0001-01-01", to: "9999-12-31", mode: "flow",
            dims: { projectId: sampleProject.projectId }, profitSigned: true,
          });
          const netDetail = await transactionDetail({
            accountTypes: ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"],
            from: "0001-01-01", to: "9999-12-31", mode: "flow",
            dims: { projectId: sampleProject.projectId }, profitSigned: true,
          });
          assert.equal(toUnits(grossDetail.net), toUnits(sampleProject.grossProfit), org.id + " project gross-profit drill tie-out");
          assert.equal(toUnits(netDetail.net), toUnits(sampleProject.net), org.id + " project net-profit drill tie-out");
        }
        const databaseToday = await db.execute(sql\`select current_date::text as today\`);
        const asOf = databaseToday.rows[0].today;
        for (const side of ["ar", "ap"]) {
          const positiveKind = side === "ar" ? "customer_invoice" : "vendor_bill";
          const creditKind = side === "ar" ? "customer_credit" : "vendor_credit";
          const aging = await agingByParty(side, asOf);
          const detail = await agingDetail(side, asOf);
          const open = await db.execute(sql\`
            select round(coalesce(sum(
                     (case when kind = \${creditKind} then -1 else 1 end)
                     * open_balance * fx_rate
                   ), 0), 4)::text as total
              from documents
             where org_id = \${org.id} and status = 'posted'
               and kind in (\${positiveKind}, \${creditKind}) and open_balance > 0
               and coalesce(posting_date, document_date) <= \${asOf}
          \`);
          assert.equal(
            toUnits(aging.totals.total),
            toUnits(open.rows[0].total),
            org.id + " " + side.toUpperCase() + " aging",
          );
          assert.equal(
            toUnits(detail.totals.total),
            toUnits(aging.totals.total),
            org.id + " " + side.toUpperCase() + " detail tie-out",
          );
          assert.equal(
            [aging.totals.current, aging.totals.b1, aging.totals.b2, aging.totals.b3, aging.totals.b4]
              .reduce((sum, value) => sum + toUnits(value), 0n),
            toUnits(aging.totals.total),
            org.id + " " + side.toUpperCase() + " bucket tie-out",
          );
        }

        const trends = await financialTrends(org.id, 15);
        for (const period of trends) {
          const statement = await cashFlow(period.starts_on, period.ends_on);
          assert.equal(
            toUnits(Number(period.closing_cash).toFixed(4)),
            toUnits(statement.closingCash),
            org.id + " " + period.name + " trend cash sign",
          );
        }
      });
    }

    // Adjustment periods can overlap a regular period's calendar dates.
    // Period analytics must use the ledger's exact period identity, not infer
    // it from posting_date.
    const scratch = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
      const calendar = await db.execute(sql\`
        select fiscal_calendar_id
          from accounting_periods
         where id = \${scratch.periodId}
      \`);
      await db.execute(sql\`
        update accounting_periods
           set fiscal_year = 2025, period_number = 6, name = '2025-06',
               starts_on = '2025-06-01', ends_on = '2025-06-30'
         where id = \${scratch.periodId}
      \`);
      const adjustmentPeriodId = randomUUID();
      await db.execute(sql\`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (
          \${adjustmentPeriodId}, \${scratch.orgId},
          \${calendar.rows[0].fiscal_calendar_id},
          2025, 13, 'FY25 Adjustment', '2025-06-01', '2025-06-30', true,
          '{}'::jsonb
        )
      \`);
      const regularEntryId = randomUUID();
      const adjustmentEntryId = randomUUID();
      await db.execute(sql\`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin, posted_at)
        values
          (\${regularEntryId}, \${scratch.orgId}, \${scratch.bookId},
           \${scratch.subsidiaryId}, 'REGULAR-ACTIVITY', '2025-06-30',
           \${scratch.periodId}, 'Regular period revenue', 'draft', 'manual', null),
          (\${adjustmentEntryId}, \${scratch.orgId}, \${scratch.bookId},
           \${scratch.subsidiaryId}, 'ADJUSTMENT-ACTIVITY', '2025-06-30',
           \${adjustmentPeriodId}, 'Adjustment period revenue', 'draft', 'manual', null)
      \`);
      await db.execute(sql\`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (\${scratch.orgId}, \${regularEntryId}, 1, \${scratch.accounts.bank},
           \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
          (\${scratch.orgId}, \${regularEntryId}, 2, \${scratch.accounts.revenue},
           \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1'),
          (\${scratch.orgId}, \${adjustmentEntryId}, 1, \${scratch.accounts.bank},
           \${scratch.subsidiaryId}, '900.0000', 'CAD', '900.0000', '1'),
          (\${scratch.orgId}, \${adjustmentEntryId}, 2, \${scratch.accounts.revenue},
           \${scratch.subsidiaryId}, '-900.0000', 'CAD', '-900.0000', '1')
      \`);
      await db.execute(sql\`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (\${regularEntryId}, \${adjustmentEntryId})
      \`);
      });

      await withOrg(scratch.orgId, async () => {
        const trends = await financialTrends(scratch.orgId, 15);
        const regularPeriod = trends.find((row) => row.id === scratch.periodId);
        assert.ok(regularPeriod, "regular completed period appears in trends");
        assert.equal(regularPeriod.revenue, "100.0000");
        assert.equal(regularPeriod.net_income, "100.0000");
      });

      // Statement drill-downs must stay on the same accounting book as the
      // statement cell. Seed different revenue amounts in the primary and a
      // parallel tax book so both the default and explicit scopes are visible.
      const taxBookId = randomUUID();
      await withBypass(async () => {
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);
        const postRevenue = async (bookId, amount, tag) => {
          const entryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${'DRILL-' + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, \${amount}, 'CAD', \${amount}, '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${'-' + amount}, 'CAD', \${'-' + amount}, '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
        };
        await postRevenue(scratch.bookId, '100.0000', 'PRIMARY');
        await postRevenue(taxBookId, '250.0000', 'TAX');
      });

      await withOrg(scratch.orgId, async () => {
        const detail = (bookId) => transactionDetail({
          accountTypes: ['income'],
          from: scratch.date,
          to: scratch.date,
          mode: 'flow',
          orgId: scratch.orgId,
          bookId,
        });
        const primary = await detail(undefined);
        assert.equal(primary.net, '100.0000', 'default drill-down uses the primary book');
        assert.equal(primary.count, 1, 'default drill-down excludes parallel-book lines');
        const tax = await detail(taxBookId);
        assert.equal(tax.net, '250.0000', 'explicit drill-down uses the selected book');
        assert.equal(tax.count, 1, 'explicit drill-down excludes primary-book lines');
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
});

test("journal report truncation keeps entries complete", { skip: !env.OPENBOOKS_DB_URL }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/db.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
    import { journalReport } from "./web/lib/reports.ts";

    const scratch = await withBypass(() => createScratchOrg());
    const newestEntryId = randomUUID();
    const olderEntryId = randomUUID();
    try {
      await withBypass(async () => {
        await db.execute(sql\`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin, posted_at)
          values
            (\${newestEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'TRUNC-2', '2026-07-16', \${scratch.periodId}, 'Newest entry', 'draft', 'manual', null),
            (\${olderEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'TRUNC-1', '2026-07-15', \${scratch.periodId}, 'Older entry', 'draft', 'manual', null)
        \`);
        await db.execute(sql\`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (\${scratch.orgId}, \${newestEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
            (\${scratch.orgId}, \${newestEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1'),
            (\${scratch.orgId}, \${olderEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '200.0000', 'CAD', '200.0000', '1'),
            (\${scratch.orgId}, \${olderEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '-200.0000', 'CAD', '-200.0000', '1')
        \`);
        await db.execute(sql\`
          update journal_entries
             set status = 'posted', posted_at = now()
           where id in (\${newestEntryId}, \${olderEntryId})
        \`);
      });

      await withOrg(scratch.orgId, async () => {
        const capped = await journalReport('2026-07-01', '2026-07-31', { maxLines: 3 });
        assert.equal(capped.truncated, true);
        assert.deepEqual(capped.entries.map((entry) => entry.id), [newestEntryId]);
        assert.equal(capped.entries[0].lines.length, 2, 'the included entry retains all lines');
        assert.equal(capped.entries[0].totalDebit, '100.0000');

        const complete = await journalReport('2026-07-01', '2026-07-31', { maxLines: 4 });
        assert.equal(complete.truncated, false);
        assert.deepEqual(complete.entries.map((entry) => entry.id), [newestEntryId, olderEntryId]);
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
});

test("layout statements include posted and reversed entries but exclude draft and voided activity", { skip: !env.OPENBOOKS_DB_URL }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/db.ts";
    import { toUnits } from "./engine/src/money.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
    import { renderLayout } from "./web/lib/layouts.ts";

    const scratch = await withBypass(() => createScratchOrg());
    const layoutId = randomUUID();
    const sourceEntryId = randomUUID();
    const reversalEntryId = randomUUID();
    const postedEntryId = randomUUID();
    const draftEntryId = randomUUID();
    try {
      await withBypass(async () => {
        await db.execute(sql\`
          insert into statement_layouts (id, org_id, name, statement, rows)
          values (\${layoutId}, \${scratch.orgId}, 'Posted P&L', 'pnl', \${JSON.stringify([
            { kind: "group", label: "Revenue", match: { types: ["income"] } },
          ])}::jsonb)
        \`);
        await db.execute(sql\`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin, posted_at, reverses_entry_id)
          values
            (\${sourceEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'LAYOUT-SOURCE', \${scratch.date}, \${scratch.periodId}, 'Voided source', 'draft', 'manual', null, null),
            (\${reversalEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'LAYOUT-REVERSAL', \${scratch.date}, \${scratch.periodId}, 'Voided reversal', 'draft', 'manual', null, \${sourceEntryId}),
            (\${postedEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'LAYOUT-POSTED', \${scratch.date}, \${scratch.periodId}, 'Posted revenue', 'draft', 'manual', null, null),
            (\${draftEntryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
             'LAYOUT-DRAFT', \${scratch.date}, \${scratch.periodId}, 'Unposted draft', 'draft', 'manual', null, null)
        \`);
        await db.execute(sql\`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (\${scratch.orgId}, \${sourceEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
            (\${scratch.orgId}, \${sourceEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1'),
            (\${scratch.orgId}, \${reversalEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1'),
            (\${scratch.orgId}, \${reversalEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
            (\${scratch.orgId}, \${postedEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '50.0000', 'CAD', '50.0000', '1'),
            (\${scratch.orgId}, \${postedEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '-50.0000', 'CAD', '-50.0000', '1'),
            (\${scratch.orgId}, \${draftEntryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, '900.0000', 'CAD', '900.0000', '1'),
            (\${scratch.orgId}, \${draftEntryId}, 2, \${scratch.accounts.revenue}, \${scratch.subsidiaryId}, '-900.0000', 'CAD', '-900.0000', '1')
        \`);
        await db.execute(sql\`
          update journal_entries
             set status = 'posted', posted_at = now()
           where id in (\${sourceEntryId}, \${reversalEntryId}, \${postedEntryId})
        \`);
        await db.execute(sql\`
          update journal_entries set status = 'reversed' where id = \${sourceEntryId}
        \`);
      });

      await withOrg(scratch.orgId, async () => {
        const rendered = await renderLayout(layoutId, scratch.date, scratch.date);
        const revenue = rendered?.lines.find((line) => line.kind === "total" && line.label === "Total Revenue");
        assert.ok(revenue, "the layout emits the configured Revenue total");
        assert.equal(toUnits(String(revenue.amount)), 50n * 10_000n, "draft and voided activity cannot affect the layout balance");
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
});
