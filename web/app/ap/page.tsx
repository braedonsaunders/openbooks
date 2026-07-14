import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { dateTime, money } from "../../lib/format";
import { BillActions } from "./BillActions";

export const dynamic = "force-dynamic";

export default async function AP() {
  const bills = (await db.execute(sql`
    select d.id, d.document_number, d.document_date, d.due_date, d.status, d.total,
           d.reference_number, d.memo, p.display_name as vendor, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
     where d.kind = 'vendor_bill'
     order by d.created_at desc limit 100
  `)) as any;

  return (
    <>
      <h1>Accounts Payable</h1>
      <p className="sub">
        vendor bills entered in openbooks · draft → approval → posted through the kernel ·{" "}
        <Link href="/ap/new" className="btn" style={{ padding: "6px 12px", fontSize: 13 }}>New bill</Link>
      </p>
      <table className="data">
        <thead>
          <tr><th>Bill</th><th>Vendor</th><th>Date</th><th>Ref</th><th className="num">Total</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {bills.rows.length === 0 && (
            <tr><td colSpan={7} className="muted">No bills yet — enter the first one.</td></tr>
          )}
          {bills.rows.map((b: any) => (
            <tr key={b.id}>
              <td className="mono" style={{ fontWeight: 600 }}>
                {b.entry_id
                  ? <Link href={`/journal/${b.entry_id}`} style={{ color: "var(--accent)" }}>{b.document_number}</Link>
                  : b.document_number}
              </td>
              <td>{b.vendor}</td>
              <td>{b.document_date}</td>
              <td className="muted">{b.reference_number}</td>
              <td className="num">{money(b.total)}</td>
              <td><span className={`pill ${b.status === "posted" ? "ok" : b.status === "pending_approval" ? "neutral" : b.status === "approved" ? "ok" : "neutral"}`}>{b.status.replace("_", " ")}</span></td>
              <td><BillActions id={b.id} status={b.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
