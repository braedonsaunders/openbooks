import Link from "next/link";
import { currentFiscalYearEnd, fiscalYearRange, profitAndLoss } from "../../../lib/reports";
import { money } from "../../../lib/format";
import { StatementTable } from "../StatementTable";

export const dynamic = "force-dynamic";

export default async function PnL({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const fyNow = currentFiscalYearEnd();
  const def = fiscalYearRange(fyNow);
  const from = sp.from ?? def.from;
  const to = sp.to ?? def.to;
  const pl = await profitAndLoss(from, to);

  return (
    <>
      <h1>Profit &amp; Loss</h1>
      <p className="sub">
        {from} → {to} ·{" "}
        {[fyNow, fyNow - 1, fyNow - 2].map((y) => {
          const r = fiscalYearRange(y);
          return (
            <Link key={y} href={`/reports/pnl?from=${r.from}&to=${r.to}`}
              style={{ color: "var(--accent)", marginRight: 12 }}>{r.label}</Link>
          );
        })}
      </p>

      <div className="grid">
        <div className="card"><div className="label">Revenue</div><div className="value small">{money(pl.revenue)}</div></div>
        <div className="card"><div className="label">Gross profit</div><div className="value small">{money(pl.grossProfit)}</div></div>
        <div className={`card ${pl.netIncome >= 0 ? "good" : "bad"}`}>
          <div className="label">Net income</div><div className="value small">{money(pl.netIncome)}</div>
        </div>
      </div>

      <StatementTable
        sections={[
          { title: "Revenue", types: ["income", "income_other"], rows: pl.items, total: pl.revenue },
          { title: "Cost of Goods Sold", types: ["cogs"], rows: pl.items, total: pl.cogs },
          { title: "Expenses", types: ["expense", "expense_other", "expense_deferred"], rows: pl.items, total: pl.expenses },
        ]}
        grandTotal={{ label: "Net income", value: pl.netIncome }}
      />
    </>
  );
}
