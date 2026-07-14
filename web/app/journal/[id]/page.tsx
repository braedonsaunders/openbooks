import Link from "next/link";
import { entryDetail } from "../../../lib/data";
import { money } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function Entry({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { entry, lines } = await entryDetail(id);
  if (!entry) return <h1>Entry not found</h1>;

  const debits = lines.filter((l: any) => Number(l.amount) > 0).reduce((a: number, l: any) => a + Number(l.amount), 0);

  return (
    <>
      <h1 className="mono">{entry.entry_number}</h1>
      <p className="sub">
        {entry.posting_date} · {entry.memo} · <span className={`pill ${entry.status === "posted" ? "ok" : "bad"}`}>{entry.status}</span>
        {entry.reverses_number && <> · reverses <span className="mono">{entry.reverses_number}</span></>}
        {" "}· origin: {entry.origin}
      </p>
      <table className="data">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th><th>Account</th><th>Party</th><th>Department</th>
            <th className="num">Debit</th><th className="num">Credit</th><th>Open item</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any) => {
            const amt = Number(l.amount);
            return (
              <tr key={l.line_number}>
                <td className="muted">{l.line_number}</td>
                <td><span className="mono muted">{l.account_number}</span> {l.account_name}</td>
                <td className="muted">{l.party}</td>
                <td className="muted">{l.department}</td>
                <td className="num">{amt > 0 ? money(amt) : ""}</td>
                <td className="num">{amt < 0 ? money(-amt) : ""}</td>
                <td>{l.is_open_item ? <span className="pill neutral">open item</span> : ""}</td>
              </tr>
            );
          })}
          <tr>
            <td colSpan={4} style={{ fontWeight: 650 }}>Totals</td>
            <td className="num" style={{ fontWeight: 650 }}>{money(debits)}</td>
            <td className="num" style={{ fontWeight: 650 }}>{money(debits)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="query-meta"><Link href="/journal" style={{ color: "var(--accent)" }}>← Back to journal</Link></p>
    </>
  );
}
