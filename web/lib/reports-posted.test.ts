import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test("financial statements exclude draft and other unposted journals", { skip: !env.OPENBOOKS_DB_URL }, () => {
  // Web report modules intentionally import `server-only`. Run this DB-backed
  // contract in React's server condition so the test exercises the production
  // report implementation rather than copying its aggregation logic here.
  const source = `
    import assert from "node:assert/strict";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/db.ts";
    import { toUnits } from "./engine/src/money.ts";
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
            join journal_entries e on e.id = l.entry_id and e.status = 'posted'
            join accounts a on a.id = l.account_id
           where l.org_id = \${org.id}
        \`);
        const row = expected.rows[0];
        assert.equal(toUnits(report.revenue.toFixed(4)), toUnits(row.revenue), org.id + " revenue");
        assert.equal(toUnits(report.cogs.toFixed(4)), toUnits(row.cogs), org.id + " COGS");
        assert.equal(toUnits(report.expenses.toFixed(4)), toUnits(row.expenses), org.id + " expenses");
        assert.equal(
          toUnits(report.netIncome.toFixed(4)),
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
          const sum = (key) => customer.rows.reduce((total, row) => total + row[key], 0);
          for (const key of ["revenue", "cogs", "grossProfit", "expenses", "net"]) {
            assert.equal(
              toUnits(customer.totals[key].toFixed(4)),
              toUnits(sum(key).toFixed(4)),
              org.id + " " + (customer.customerName ?? "unassigned") + " " + key + " subtotal",
            );
          }
          assert.equal(customer.totals.hours, sum("hours"), org.id + " customer hours subtotal");
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
          assert.equal(toUnits(grossDetail.net.toFixed(4)), toUnits(sampleProject.grossProfit.toFixed(4)), org.id + " project gross-profit drill tie-out");
          assert.equal(toUnits(netDetail.net.toFixed(4)), toUnits(sampleProject.net.toFixed(4)), org.id + " project net-profit drill tie-out");
        }
        for (const side of ["ar", "ap"]) {
          const positiveKind = side === "ar" ? "customer_invoice" : "vendor_bill";
          const creditKind = side === "ar" ? "customer_credit" : "vendor_credit";
          const aging = await agingByParty(side, new Date().toISOString().slice(0, 10));
          const detail = await agingDetail(side, new Date().toISOString().slice(0, 10));
          const open = await db.execute(sql\`
            select coalesce(sum(
                     (case when kind = \${creditKind} then -1 else 1 end)
                     * open_balance * fx_rate
                   ), 0)::text as total
              from documents
             where org_id = \${org.id} and status = 'posted'
               and kind in (\${positiveKind}, \${creditKind}) and open_balance > 0.005
               and coalesce(posting_date, document_date) <= current_date
          \`);
          assert.equal(
            toUnits(aging.totals.total.toFixed(4)),
            toUnits(open.rows[0].total),
            org.id + " " + side.toUpperCase() + " aging",
          );
          assert.equal(
            toUnits(detail.totals.total.toFixed(4)),
            toUnits(aging.totals.total.toFixed(4)),
            org.id + " " + side.toUpperCase() + " detail tie-out",
          );
          assert.equal(
            toUnits((aging.totals.current + aging.totals.b1 + aging.totals.b2 + aging.totals.b3 + aging.totals.b4).toFixed(4)),
            toUnits(aging.totals.total.toFixed(4)),
            org.id + " " + side.toUpperCase() + " bucket tie-out",
          );
        }

        const trends = await financialTrends(org.id, 15);
        for (const period of trends) {
          const statement = await cashFlow(period.starts_on, period.ends_on);
          assert.equal(
            toUnits(Number(period.closing_cash).toFixed(4)),
            toUnits(statement.closingCash.toFixed(4)),
            org.id + " " + period.name + " trend cash sign",
          );
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
