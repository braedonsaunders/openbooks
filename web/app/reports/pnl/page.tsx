import Link from "next/link";
import { currentFiscalYearEnd, dimensionOptions, fiscalYearRange, profitAndLoss } from "../../../lib/reports";
import { money } from "../../../lib/format";
import { StatementTable } from "../StatementTable";
import { DimensionFilter } from "../DimensionFilter";
import { SaveViewButton } from "../SaveViewButton";
import { layoutsFor, renderLayout, type RenderedLine } from "../../../lib/layouts";

export const dynamic = "force-dynamic";

function shiftYear(d: string, years: number): string {
  return `${Number(d.slice(0, 4)) + years}${d.slice(4)}`;
}

export default async function PnL({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; dept?: string; project?: string; compare?: string; layout?: string }>;
}) {
  const sp = await searchParams;
  const fyNow = currentFiscalYearEnd();
  const def = fiscalYearRange(fyNow);
  const from = sp.from ?? def.from;
  const to = sp.to ?? def.to;
  const dims = { departmentId: sp.dept || undefined, projectId: sp.project || undefined };
  const comparing = sp.compare === "1";
  const [pl, prior, opts, layouts, laid] = await Promise.all([
    profitAndLoss(from, to, dims),
    comparing ? profitAndLoss(shiftYear(from, -1), shiftYear(to, -1), dims) : null,
    dimensionOptions(),
    layoutsFor("pnl"),
    sp.layout ? renderLayout(sp.layout, from, to, dims) : null,
  ]);

  return (
    <>
      <h1>Profit &amp; Loss</h1>
      <p className="sub">
        {from} → {to} ·{" "}
        {[fyNow, fyNow - 1, fyNow - 2].map((y) => {
          const r = fiscalYearRange(y);
          return (
            <Link key={y} href={`/reports/pnl?from=${r.from}&to=${r.to}&dept=${sp.dept ?? ""}&project=${sp.project ?? ""}`}
              style={{ color: "var(--accent)", marginRight: 12 }}>{r.label}</Link>
          );
        })}
        <Link
          href={`/reports/pnl?from=${from}&to=${to}&dept=${sp.dept ?? ""}&project=${sp.project ?? ""}${comparing ? "" : "&compare=1"}`}
          style={{ color: "var(--accent)", fontWeight: 600, marginRight: 12 }}
        >
          {comparing ? "single period" : "vs prior year"}
        </Link>
        {layouts.map((l) => (
          <Link key={l.id}
            href={`/reports/pnl?from=${from}&to=${to}&dept=${sp.dept ?? ""}&project=${sp.project ?? ""}${sp.layout === l.id ? "" : `&layout=${l.id}`}`}
            style={{ color: "var(--accent)", fontWeight: sp.layout === l.id ? 700 : 400, marginRight: 12 }}>
            {sp.layout === l.id ? `✕ ${l.name}` : l.name}
          </Link>
        ))}
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <DimensionFilter
          departments={opts.departments} projects={opts.projects}
          current={{ dept: sp.dept, project: sp.project }}
          extraParams={{ from, to }}
        />
        <SaveViewButton />
      </div>

      <div className="grid">
        <div className="card"><div className="label">Revenue</div><div className="value small">{money(pl.revenue)}</div></div>
        <div className="card"><div className="label">Gross profit</div><div className="value small">{money(pl.grossProfit)}</div></div>
        <div className={`card ${pl.netIncome >= 0 ? "good" : "bad"}`}>
          <div className="label">Net income</div><div className="value small">{money(pl.netIncome)}</div>
        </div>
      </div>

      {laid ? (
        <LayoutTable lines={laid.lines} />
      ) : prior ? (
        <ComparativeTable current={pl} prior={prior} />
      ) : (
        <StatementTable
          sections={[
            { title: "Revenue", types: ["income", "income_other"], rows: pl.items, total: pl.revenue },
            { title: "Cost of Goods Sold", types: ["cogs"], rows: pl.items, total: pl.cogs },
            { title: "Expenses", types: ["expense", "expense_other", "expense_deferred"], rows: pl.items, total: pl.expenses },
          ]}
          grandTotal={{ label: "Net income", value: pl.netIncome }}
        />
      )}
    </>
  );
}

function LayoutTable({ lines }: { lines: RenderedLine[] }) {
  return (
    <table className="data">
      <tbody>
        {lines.map((l, i) => {
          if (l.kind === "spacer") return <tr key={i}><td colSpan={2} style={{ border: "none", height: 14 }} /></tr>;
          if (l.kind === "header") {
            return <tr key={i}><td colSpan={2} style={{ background: "#fbfbfa", fontWeight: 650, fontSize: 13 }}>{l.label}</td></tr>;
          }
          if (l.kind === "account") {
            return (
              <tr key={i} className="indent-1">
                <td>
                  <Link href={`/accounts/${l.accountId}`} style={{ color: "inherit" }}>
                    <span className="mono muted">{l.number}</span> {l.label}
                  </Link>
                </td>
                <td className={`num ${(l.amount ?? 0) < 0 ? "neg" : ""}`}>{money(l.amount ?? 0)}</td>
              </tr>
            );
          }
          return (
            <tr key={i}>
              <td style={{ fontWeight: l.emphasis ? 700 : 650 }}>{l.label}</td>
              <td className={`num ${(l.amount ?? 0) < 0 ? "neg" : ""}`} style={{ fontWeight: l.emphasis ? 700 : 650 }}>
                {money(l.amount ?? 0)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ComparativeTable({
  current, prior,
}: {
  current: Awaited<ReturnType<typeof profitAndLoss>>;
  prior: Awaited<ReturnType<typeof profitAndLoss>>;
}) {
  const priorById = new Map(prior.items.map((r) => [r.id, r.balance]));
  const seen = new Set(current.items.map((r) => r.id));
  const rows = [
    ...current.items.map((r) => ({ ...r, prior: priorById.get(r.id) ?? 0 })),
    ...prior.items.filter((r) => !seen.has(r.id)).map((r) => ({ ...r, balance: 0, prior: r.balance })),
  ];
  const totals = [
    { label: "Total Revenue", cur: current.revenue, pri: prior.revenue },
    { label: "Gross profit", cur: current.grossProfit, pri: prior.grossProfit },
    { label: "Net income", cur: current.netIncome, pri: prior.netIncome },
  ];
  return (
    <table className="data">
      <thead>
        <tr><th>Account</th><th className="num">Current</th><th className="num">Prior year</th><th className="num">Δ</th><th className="num">Δ%</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const delta = r.balance - r.prior;
          const pct = r.prior !== 0 ? (delta / Math.abs(r.prior)) * 100 : null;
          return (
            <tr key={r.id} className={`indent-${Math.min(r.depth + 1, 2)}`}>
              <td style={r.isSummary ? { fontWeight: 600 } : undefined}>
                <span className="mono muted">{r.number}</span> {r.name}
              </td>
              <td className={`num ${r.balance < 0 ? "neg" : ""}`}>{money(r.balance)}</td>
              <td className={`num ${r.prior < 0 ? "neg" : ""}`}>{money(r.prior)}</td>
              <td className={`num ${delta < 0 ? "neg" : ""}`}>{money(delta)}</td>
              <td className={`num ${delta < 0 ? "neg" : ""}`}>{pct === null ? "" : `${pct.toFixed(1)}%`}</td>
            </tr>
          );
        })}
        {totals.map((t) => (
          <tr key={t.label}>
            <td style={{ fontWeight: 700 }}>{t.label}</td>
            <td className="num" style={{ fontWeight: 700 }}>{money(t.cur)}</td>
            <td className="num" style={{ fontWeight: 700 }}>{money(t.pri)}</td>
            <td className={`num ${t.cur - t.pri < 0 ? "neg" : ""}`} style={{ fontWeight: 700 }}>{money(t.cur - t.pri)}</td>
            <td className="num" style={{ fontWeight: 700 }}>
              {t.pri !== 0 ? `${(((t.cur - t.pri) / Math.abs(t.pri)) * 100).toFixed(1)}%` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
