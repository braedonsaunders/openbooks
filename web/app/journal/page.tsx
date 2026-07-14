import Link from "next/link";
import { journalPage } from "../../lib/data";
import { money } from "../../lib/format";

export const dynamic = "force-dynamic";

export default async function Journal({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const p = Math.max(0, Number(page ?? 0));
  const { entries, total } = await journalPage(p * 50);

  return (
    <>
      <h1>Journal</h1>
      <p className="sub">{total.toLocaleString()} posted entries · immutable, append-only</p>
      <table className="data">
        <thead>
          <tr>
            <th>Date</th><th>Entry</th><th>Memo</th><th>Origin</th>
            <th className="num">Lines</th><th className="num">Debits</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e: any) => (
            <tr key={e.id} className="row-link">
              <td>{e.posting_date}</td>
              <td><Link href={`/journal/${e.id}`} className="mono" style={{ color: "var(--accent)", fontWeight: 600 }}>{e.entry_number}</Link></td>
              <td className="muted">{e.memo}</td>
              <td><span className="pill neutral">{e.origin}</span></td>
              <td className="num">{e.line_count}</td>
              <td className="num">{money(e.total_debits)}</td>
              <td><span className={`pill ${e.status === "posted" ? "ok" : e.status === "reversed" ? "bad" : "neutral"}`}>{e.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="query-meta">
        {p > 0 && <Link href={`/journal?page=${p - 1}`} style={{ color: "var(--accent)", marginRight: 16 }}>← Newer</Link>}
        {(p + 1) * 50 < total && <Link href={`/journal?page=${p + 1}`} style={{ color: "var(--accent)" }}>Older →</Link>}
      </p>
    </>
  );
}
