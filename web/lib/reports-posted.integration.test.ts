import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Database partition: every case here needs PostgreSQL (scratch orgs,
// posted journals, parallel books). The unit partition has no database, so
// these live under the .integration suffix with no skip guards.

test("financial statements exclude draft and other unposted journals", () => {
  // Web report modules intentionally import `server-only`. Run this DB-backed
  // contract in React's server condition so the test exercises the production
  // report implementation rather than copying its aggregation logic here.
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
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
    // it from posting_date: the regular row carries only its own entries, an
    // adjustment period is never a row, and closing cash is the balance as at
    // the period end across every ledger period ending on or before it.
    const scratch = await withBypass(() => createScratchOrg());
    const taxBookId = randomUUID();
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
      await db.execute(sql\`
        insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)
      \`);
      const regularEntryId = randomUUID();
      const adjustmentEntryId = randomUUID();
      const adjustmentExpenseId = randomUUID();
      const taxBookEntryId = randomUUID();
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
           \${adjustmentPeriodId}, 'Adjustment period revenue', 'draft', 'manual', null),
          (\${adjustmentExpenseId}, \${scratch.orgId}, \${scratch.bookId},
           \${scratch.subsidiaryId}, 'ADJUSTMENT-EXPENSE', '2025-06-30',
           \${adjustmentPeriodId}, 'Adjustment period accrual', 'draft', 'manual', null),
          (\${taxBookEntryId}, \${scratch.orgId}, \${taxBookId},
           \${scratch.subsidiaryId}, 'TAX-BOOK-ACTIVITY', '2025-06-30',
           \${scratch.periodId}, 'Parallel book revenue', 'draft', 'manual', null)
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
           \${scratch.subsidiaryId}, '-900.0000', 'CAD', '-900.0000', '1'),
          (\${scratch.orgId}, \${adjustmentExpenseId}, 1, \${scratch.accounts.cogs},
           \${scratch.subsidiaryId}, '25.0000', 'CAD', '25.0000', '1'),
          (\${scratch.orgId}, \${adjustmentExpenseId}, 2, \${scratch.accounts.bank},
           \${scratch.subsidiaryId}, '-25.0000', 'CAD', '-25.0000', '1'),
          (\${scratch.orgId}, \${taxBookEntryId}, 1, \${scratch.accounts.bank},
           \${scratch.subsidiaryId}, '5000.0000', 'CAD', '5000.0000', '1'),
          (\${scratch.orgId}, \${taxBookEntryId}, 2, \${scratch.accounts.revenue},
           \${scratch.subsidiaryId}, '-5000.0000', 'CAD', '-5000.0000', '1')
      \`);
      await db.execute(sql\`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (\${regularEntryId}, \${adjustmentEntryId}, \${adjustmentExpenseId}, \${taxBookEntryId})
      \`);
      });

      await withOrg(scratch.orgId, async () => {
        const trends = await financialTrends(scratch.orgId, 15);
        const regularPeriod = trends.find((row) => row.id === scratch.periodId);
        assert.ok(regularPeriod, "regular completed period appears in trends");
        assert.equal(trends.some((row) => row.name === "FY25 Adjustment"), false, "adjustment periods are not trend rows");
        // The regular row carries the entries the ledger assigned to it: the
        // adjustment period's revenue and accrual are that period's, and the
        // parallel book is excluded.
        assert.equal(regularPeriod.revenue, "100.0000");
        assert.equal(toUnits(regularPeriod.expenses), 0n);
        assert.equal(regularPeriod.net_income, "100.0000");
        // Closing cash is the balance as at the period end across every ledger
        // period ending on or before it — the adjustment period included.
        assert.equal(regularPeriod.closing_cash, "975.0000");
        // A restricted caller with nothing visible sees zero activity, not the org.
        const none = (await financialTrends(scratch.orgId, 15, [])).find((row) => row.id === scratch.periodId);
        assert.ok(none);
        assert.equal(toUnits(none.revenue), 0n, "empty subsidiary scope must not widen to the org");
        assert.equal(toUnits(none.closing_cash), 0n, "empty subsidiary scope must not widen closing cash to the org");
        // An explicit book reads that book only.
        const tax = (await financialTrends(scratch.orgId, 15, undefined, taxBookId)).find((row) => row.id === scratch.periodId);
        assert.ok(tax);
        assert.equal(tax.revenue, "5000.0000");
        assert.equal(tax.closing_cash, "5000.0000");
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


test("transaction detail excludes parallel-book lines", () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
    import { transactionDetail } from "./web/lib/reports.ts";

    const scratch = await withBypass(() => createScratchOrg());
    const taxBookId = randomUUID();
    try {
      await withBypass(async () => {
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);
        const postRevenue = async (bookId, amount, tag) => {
          const entryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin, posted_at)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${"DRILL-" + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual', null)\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, \${amount}, 'CAD', \${amount}, '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${"-" + amount}, 'CAD', \${"-" + amount}, '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
        };
        await postRevenue(scratch.bookId, "100.0000", "PRIMARY");
        await postRevenue(taxBookId, "250.0000", "TAX");
      });

      await withOrg(scratch.orgId, async () => {
        const detail = (bookId) => transactionDetail({
          accountTypes: ["income"],
          from: scratch.date,
          to: scratch.date,
          mode: "flow",
          orgId: scratch.orgId,
          bookId,
        });
        const primary = await detail(undefined);
        assert.equal(primary.net, "100.0000");
        assert.equal(primary.count, 1);
        const tax = await detail(taxBookId);
        assert.equal(tax.net, "250.0000");
        assert.equal(tax.count, 1);
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


test("journal report truncation keeps entries complete", () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
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


test("ledger-backed detail reports read one accounting book (omitted means primary)", () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
    import { cashFlow, generalLedger, journalReport, partnerBalances, partyRegister, trialBalance } from "./web/lib/reports.ts";

    const scratch = await withBypass(() => createScratchOrg());
    const taxBookId = randomUUID();
    try {
      await withBypass(async () => {
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);
        const post = async (bookId, tag, cash, receivable) => {
          const cashEntryId = randomUUID();
          const arEntryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin, posted_at)
            values
              (\${cashEntryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${"BOOK-" + tag + "-CASH"}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual', null),
              (\${arEntryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${"BOOK-" + tag + "-AR"}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual', null)\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
               amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${cashEntryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, null, \${cash}, 'CAD', \${cash}, '1'),
              (\${scratch.orgId}, \${cashEntryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, null, \${"-" + cash}, 'CAD', \${"-" + cash}, '1'),
              (\${scratch.orgId}, \${arEntryId}, 1, \${scratch.accounts.ar},
               \${scratch.subsidiaryId}, \${scratch.customerId}, \${receivable}, 'CAD', \${receivable}, '1'),
              (\${scratch.orgId}, \${arEntryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${scratch.customerId}, \${"-" + receivable}, 'CAD', \${"-" + receivable}, '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id in (\${cashEntryId}, \${arEntryId})\`);
        };
        await post(scratch.bookId, "PRIMARY", "100.0000", "400.0000");
        await post(taxBookId, "TAX", "250.0000", "700.0000");
      });

      await withOrg(scratch.orgId, async () => {
        const range = { from: scratch.date, to: scratch.date, orgId: scratch.orgId };
        // General ledger: revenue closing is debit-signed; the AR journal has
        // no bank leg so cash flow only sees the cash journal.
        for (const [bookId, revenue, ar, cash] of [
          [undefined, "-500.0000", "400.0000", "100.0000"],
          [taxBookId, "-950.0000", "700.0000", "250.0000"],
        ]) {
          const gl = await generalLedger(range.from, range.to, { orgId: range.orgId, bookId });
          const glRevenue = gl.accounts.find((a) => a.id === scratch.accounts.revenue);
          assert.equal(glRevenue?.closing, revenue, "general ledger revenue closing follows the book");
          const journal = await journalReport(range.from, range.to, { orgId: range.orgId, bookId });
          assert.equal(journal.entries.length, 2, "journal report sees one book's entries");
          const register = await partyRegister("ar", { ...range, bookId });
          assert.equal(register.parties.length, 1, "receivable register sees one book's parties");
          assert.equal(register.parties[0]?.closing, ar, "receivable register closing follows the book");
          const tb = await trialBalance(range.to, undefined, range.orgId, bookId ?? null);
          assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, revenue, "trial balance follows the book");
          const partners = await partnerBalances("receivable", range.orgId, range.to, bookId ?? null, undefined);
          assert.equal(partners.find((row) => row.id === scratch.customerId)?.balance, ar, "partner balances follow the book");
          const cf = await cashFlow(range.from, range.to, undefined, range.orgId, bookId ?? null);
          assert.equal(cf.closingCash, cash, "cash flow closing cash follows the book");
        }
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


const consolidatedRows = [
  { label: "reports register truncation", register: async () => {
        const { env }=await import("@openbooks/engine/src/platform/db.ts");
        test("truncated ledger and party registers retain complete closing balances", { skip: !env.OPENBOOKS_DB_URL }, () => {
          const source = `
            import assert from "node:assert/strict";
            import { randomUUID } from "node:crypto";
            import { sql } from "drizzle-orm";
            import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
            import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
            import { generalLedger, partyRegister } from "./web/lib/reports.ts";

            const scratch = await withBypass(() => createScratchOrg());
            const amounts = ["100.0000", "50.0000", "25.0000"];
            try {
              await withBypass(async () => {
                for (const [index, amount] of amounts.entries()) {
                  const entryId = randomUUID();
                  const date = \`2026-07-\${String(22 - index).padStart(2, "0")}\`;
                  await db.execute(sql\`
                    insert into journal_entries
                      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                       period_id, memo, status, origin, posted_at)
                    values
                      (\${entryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
                       \${"TRUNC-" + index}, \${date}, \${scratch.periodId}, \${"Truncated " + index},
                       'draft', 'manual', null)
                  \`);
                  await db.execute(sql\`
                    insert into journal_lines
                      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
                       amount, currency, txn_amount, fx_rate)
                    values
                      (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, null,
                       \${amount}, 'CAD', \${amount}, '1'),
                      (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.ap}, \${scratch.subsidiaryId}, \${scratch.vendorId},
                       \${"-" + amount}, 'CAD', \${"-" + amount}, '1')
                  \`);
                  await db.execute(sql\`
                    update journal_entries set status = 'posted', posted_at = now()
                     where id = \${entryId} and org_id = \${scratch.orgId}
                  \`);
                }
              });

              await withOrg(scratch.orgId, async () => {
                const ledger = await generalLedger(scratch.date, scratch.date.replace("15", "31"), { maxLines: 1 });
                assert.equal(ledger.truncated, true);
                const bank = ledger.accounts.find((account) => account.id === scratch.accounts.bank);
                assert.ok(bank);
                assert.equal(bank.lines.length, 1);
                assert.equal(bank.lines[0]?.balance, "25.0000");
                assert.equal(bank.closing, "175.0000");

                const register = await partyRegister("ap", {
                  from: scratch.date,
                  to: scratch.date.replace("15", "31"),
                  maxLines: 1,
                });
                assert.equal(register.truncated, true);
                assert.equal(register.parties.length, 1);
                assert.equal(register.parties[0]?.lines.length, 1);
                assert.equal(register.parties[0]?.lines[0]?.balance, "-25.0000");
                assert.equal(register.parties[0]?.closing, "-175.0000");
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

        /**
         * The line cap is presentation-only: parties whose detail lines are capped
         * out must still get their section with the exact closing — an AP register
         * once dropped capped-out vendors entirely, so closings summed short of
         * the control.
         */
        test("capped-out register parties keep their sections and exact closings", { skip: !env.OPENBOOKS_DB_URL }, () => {
          const source = `
            import assert from "node:assert/strict";
            import { randomUUID } from "node:crypto";
            import { sql } from "drizzle-orm";
            import { db, withBypass, withOrg } from "./engine/src/platform/db.ts";
            import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";
            import { partyRegister } from "./web/lib/reports.ts";

            const scratch = await withBypass(() => createScratchOrg());
            try {
              await withBypass(async () => {
                const vendorB = randomUUID();
                await db.execute(sql\`
                  insert into parties (id, org_id, kind, display_name)
                  values (\${vendorB}, \${scratch.orgId}, 'vendor', 'ZZZ Capped Vendor')\`);
                await db.execute(sql\`
                  update parties set display_name = 'AAA First Vendor'
                   where id = \${scratch.vendorId} and org_id = \${scratch.orgId}\`);
                const bills = [
                  { party: scratch.vendorId, amount: "100.0000", tag: "CAP-A" },
                  { party: vendorB, amount: "200.0000", tag: "CAP-B" },
                ];
                for (const bill of bills) {
                  const entryId = randomUUID();
                  await db.execute(sql\`
                    insert into journal_entries
                      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                       period_id, memo, status, origin, posted_at)
                    values
                      (\${entryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
                       \${bill.tag}, \${scratch.date}, \${scratch.periodId}, \${bill.tag},
                       'draft', 'manual', null)
                  \`);
                  await db.execute(sql\`
                    insert into journal_lines
                      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
                       amount, currency, txn_amount, fx_rate)
                    values
                      (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.cogs}, \${scratch.subsidiaryId}, null,
                       \${bill.amount}, 'CAD', \${bill.amount}, '1'),
                      (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.ap}, \${scratch.subsidiaryId}, \${bill.party},
                       \${"-" + bill.amount}, 'CAD', \${"-" + bill.amount}, '1')
                  \`);
                  await db.execute(sql\`
                    update journal_entries set status = 'posted', posted_at = now()
                     where id = \${entryId} and org_id = \${scratch.orgId}
                  \`);
                }
              });

              await withOrg(scratch.orgId, async () => {
                const register = await partyRegister("ap", {
                  from: scratch.date,
                  to: scratch.date,
                  maxLines: 1,
                });
                assert.equal(register.truncated, true);
                assert.equal(register.parties.length, 2);
                const closings = new Map(register.parties.map((p) => [p.partyName, p.closing]));
                assert.equal(closings.get("AAA First Vendor"), "-100.0000");
                assert.equal(closings.get("ZZZ Capped Vendor"), "-200.0000");
                const first = register.parties[0];
                assert.equal(first?.lines.length, 1);
                const capped = register.parties.find((p) => p.partyName === "ZZZ Capped Vendor");
                assert.equal(capped?.lines.length, 0);
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
  } },
] as const;

for(const row of consolidatedRows) await row.register();


const generalLedgerCases = [
  { label: "gl summary split boundary", register: async () => {
        const { pathToFileURL } = await import("node:url");
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const root = pathToFileURL(process.cwd() + "/").href;
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = (await import(root + "engine/src/platform/db.ts")) as typeof import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } = (await import(root + "engine/src/testing/fixtures.ts")) as typeof import("@openbooks/engine/src/testing/fixtures.ts");
        const { glActivityBuckets } = (await import(root + "web/lib/gl-summary.ts")) as typeof import("./gl-summary");

        test(
          "split-month GL buckets exclude postings after the requested end date",
          { skip: !process.env.OPENBOOKS_DB_URL },
          async () => {
            const org = await withBypassContext(() => createScratchOrg());
            try {
              const post = async (date: string, amount: string, tag: string) => {
                const entryId = randomUUID();
                await db.execute(sql`
                  insert into journal_entries
                    (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                     period_id, memo, status, origin)
                  values
                    (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                     ${`SPLIT-BOUNDARY-${tag}`}, ${date}, ${org.periodId}, ${tag}, 'draft', 'manual')`);
                await db.execute(sql`
                  insert into journal_lines
                    (org_id, entry_id, line_number, account_id, subsidiary_id,
                     amount, currency, txn_amount, fx_rate)
                  values
                    (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
                     ${amount}, 'CAD', ${amount}, '1'),
                    (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
                     ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`);
                await db.execute(sql`
                  update journal_entries set status = 'posted', posted_at = now()
                   where id = ${entryId} and org_id = ${org.orgId}`);
              };

              await withBypassContext(async () => {
                await post("2026-07-05", "100.0000", "inside");
                await post("2026-07-20", "50.0000", "outside");
              });

              await withOrgContext(org.orgId, async () => {
                const buckets = glActivityBuckets(org.orgId, {
                  minDate: "2026-07-01",
                  maxDate: "2026-07-10",
                  boundaries: [],
                  bookId: org.bookId,
                });
                const result = await db.execute<{ amount: string }>(sql`
                  select coalesce(sum(b.amount), 0)::text as amount
                    from ${buckets} b
                   where b.account_id = ${org.accounts.revenue}
                     and b.subsidiary_id = ${org.subsidiaryId}`);
                assert.equal(result.rows[0]?.amount, "-100.0000");
              });
            } finally {
              await withBypassContext(() => dropScratchOrg(org.orgId));
            }
          },
        );
  } },
] as const;

for (const row of generalLedgerCases) await row.register();
