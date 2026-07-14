import Link from "next/link";
import { partnerBalances } from "../../../lib/reports";
import { money } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function Partners({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  const k = kind === "receivable" ? "receivable" : "payable";
  const rows = await partnerBalances(k);
  const total = rows.reduce((a, r) => a + Number(r.balance), 0);
  // AP is credit-normal: flip for the reader
  const flip = k === "payable" ? -1 : 1;

  return (
    <>
      <h1>{k === "payable" ? "Payables by Vendor" : "Receivables by Customer"}</h1>
      <p className="sub">
        net position per party ·{" "}
        <Link href="/reports/partners?kind=payable" style={{ color: "var(--accent)", marginRight: 10 }}>payables</Link>
        <Link href="/reports/partners?kind=receivable" style={{ color: "var(--accent)" }}>receivables</Link>
      </p>
      <div className="grid">
        <div className="card">
          <div className="label">Total outstanding</div>
          <div className="value small">{money(flip * total)}</div>
        </div>
        <div className="card">
          <div className="label">Parties with balance</div>
          <div className="value small">{rows.length}</div>
        </div>
      </div>
      <table className="data">
        <thead>
          <tr><th>Party</th><th className="num">Outstanding</th><th className="num">GL lines</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? `none-${i}`}>
              <td>{r.display_name ?? <span className="muted">(no party on lines)</span>}</td>
              <td className={`num ${flip * Number(r.balance) < 0 ? "neg" : ""}`}>{money(flip * Number(r.balance))}</td>
              <td className="num">{r.line_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
