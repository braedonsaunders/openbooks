import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "./db.ts";
import { dashboardFinancialMetricsQuery, type DashboardFinancialMetricsRow } from "./dashboard-reporting.ts";
import { fromUnits, mulRate, toUnits } from "./money.ts";

type OpenDocument = {
  kind: "customer_invoice" | "vendor_bill";
  open_balance: string;
  fx_rate: string;
  overdue: boolean;
};

function sumBase(rows: OpenDocument[], kind: OpenDocument["kind"], overdueOnly = false): string {
  const units = rows
    .filter((row) => row.kind === kind && (!overdueOnly || row.overdue))
    .reduce((total, row) => total + toUnits(mulRate(row.open_balance, row.fx_rate)), 0n);
  return fromUnits(units);
}

test("dashboard financial totals match exact per-document FX conversion", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgs = (await db.execute(sql`select id from orgs order by id`)) as unknown as { rows: Array<{ id: string }> };

  for (const org of orgs.rows) {
    const [actualResult, documentsResult, cashResult] = await Promise.all([
      db.execute(dashboardFinancialMetricsQuery(org.id)),
      db.execute(sql`
        select kind, open_balance, fx_rate, due_date < current_date as overdue
          from documents
         where org_id = ${org.id}
           and kind in ('customer_invoice', 'vendor_bill')
           and status = 'posted' and open_balance > 0
      `),
      db.execute(sql`
        select coalesce(sum(l.amount), 0) as cash_balance
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
          join accounts a on a.id = l.account_id and a.type = 'asset_bank'
         where e.org_id = ${org.id}
      `),
    ]);

    const actual = (actualResult as unknown as { rows: DashboardFinancialMetricsRow[] }).rows[0]!;
    const documents = (documentsResult as unknown as { rows: OpenDocument[] }).rows;
    const cash = (cashResult as unknown as { rows: Array<{ cash_balance: string }> }).rows[0]!.cash_balance;

    assert.equal(toUnits(actual.cash_balance), toUnits(cash), `${org.id} cash balance`);
    assert.equal(toUnits(actual.open_receivables), toUnits(sumBase(documents, "customer_invoice")), `${org.id} open receivables`);
    assert.equal(toUnits(actual.overdue_receivables), toUnits(sumBase(documents, "customer_invoice", true)), `${org.id} overdue receivables`);
    assert.equal(toUnits(actual.open_payables), toUnits(sumBase(documents, "vendor_bill")), `${org.id} open payables`);
    assert.equal(toUnits(actual.overdue_payables), toUnits(sumBase(documents, "vendor_bill", true)), `${org.id} overdue payables`);
  }
});
