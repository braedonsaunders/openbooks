import Link from "next/link";
import { accountRegister } from "../../../lib/reports";
import { money } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function Register({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page } = await searchParams;
  const p = Math.max(0, Number(page ?? 0));
  const { account, lines, total, balance } = await accountRegister(id, 100, p * 100);
  if (!account) return <h1>Account not found</h1>;

  return (
    <>
      <h1><span className="mono muted">{account.number}</span> {account.name}</h1>
      <p className="sub">
        register · {total.toLocaleString()} lines · running balance {money(balance)} ·{" "}
        <Link href="/accounts" style={{ color: "var(--accent)" }}>all accounts</Link>
      </p>
      <table className="data">
        <thead>
          <tr><th>Date</th><th>Entry</th><th>Party</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th></tr>
        </thead>
        <tbody>
          {lines.map((l: any, i: number) => {
            const amt = Number(l.amount);
            return (
              <tr key={`${l.entry_id}-${l.line_number}-${i}`}>
                <td>{l.posting_date}</td>
                <td><Link href={`/journal/${l.entry_id}`} className="mono" style={{ color: "var(--accent)" }}>{l.entry_number}</Link></td>
                <td className="muted">{l.party}</td>
                <td className="muted">{l.memo ?? l.entry_memo}</td>
                <td className="num">{amt > 0 ? money(amt) : ""}</td>
                <td className="num">{amt < 0 ? money(-amt) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="query-meta">
        {p > 0 && <Link href={`/accounts/${id}?page=${p - 1}`} style={{ color: "var(--accent)", marginRight: 16 }}>← Newer</Link>}
        {(p + 1) * 100 < total && <Link href={`/accounts/${id}?page=${p + 1}`} style={{ color: "var(--accent)" }}>Older →</Link>}
      </p>
    </>
  );
}
