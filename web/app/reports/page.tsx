import Link from "next/link";
import { currentFiscalYearEnd, fiscalYearRange } from "../../lib/reports";

export const dynamic = "force-dynamic";

export default function Reports() {
  const fy = currentFiscalYearEnd();
  const cur = fiscalYearRange(fy);
  const prev = fiscalYearRange(fy - 1);
  const today = new Date().toISOString().slice(0, 10);

  const reports = [
    { href: `/reports/pnl?from=${cur.from}&to=${cur.to}`, title: "Profit & Loss", desc: `Income statement — ${cur.label} to date, with fiscal-year presets` },
    { href: `/reports/balance-sheet?asof=${today}`, title: "Balance Sheet", desc: "Financial position as of any date, retained earnings computed" },
    { href: `/reports/trial-balance?asof=${today}`, title: "Trial Balance", desc: "Every account with debits, credits, and net balance" },
    { href: `/reports/partners?kind=payable`, title: "Payables by Vendor", desc: "Outstanding AP position per party" },
    { href: `/reports/partners?kind=receivable`, title: "Receivables by Customer", desc: "Outstanding AR position per party" },
  ];

  return (
    <>
      <h1>Reports</h1>
      <p className="sub">Statements are computed live from the ledger — never cached snapshots.</p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {reports.map((r) => (
          <Link key={r.href} href={r.href} className="card" style={{ display: "block" }}>
            <div className="value small" style={{ marginTop: 0 }}>{r.title}</div>
            <div className="label" style={{ textTransform: "none", letterSpacing: 0, marginTop: 6 }}>{r.desc}</div>
          </Link>
        ))}
      </div>
      <p className="query-meta">
        Quick ranges: <Link href={`/reports/pnl?from=${cur.from}&to=${cur.to}`} style={{ color: "var(--accent)" }}>{cur.label}</Link>
        {" · "}
        <Link href={`/reports/pnl?from=${prev.from}&to=${prev.to}`} style={{ color: "var(--accent)" }}>{prev.label}</Link>
      </p>
    </>
  );
}
