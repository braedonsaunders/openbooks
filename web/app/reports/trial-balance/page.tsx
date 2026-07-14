import Link from "next/link";
import { trialBalance } from "../../../lib/reports";
import { money } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function TrialBalance({ searchParams }: { searchParams: Promise<{ asof?: string }> }) {
  const { asof } = await searchParams;
  const date = asof ?? new Date().toISOString().slice(0, 10);
  const rows = await trialBalance(date);
  const totalDebits = rows.reduce((a, r) => a + Number(r.debits), 0);
  const totalCredits = rows.reduce((a, r) => a + Number(r.credits), 0);

  return (
    <>
      <h1>Trial Balance</h1>
      <p className="sub">as of {date} · {rows.length} accounts with activity</p>
      <table className="data">
        <thead>
          <tr><th>Account</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Balance</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/accounts/${r.id}`} style={{ color: "inherit" }}>
                  <span className="mono muted">{r.number}</span> {r.name}
                </Link>
              </td>
              <td className="num">{money(r.debits)}</td>
              <td className="num">{money(r.credits)}</td>
              <td className={`num ${Number(r.balance) < 0 ? "neg" : ""}`}>{money(r.balance)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ fontWeight: 700 }}>Totals</td>
            <td className="num" style={{ fontWeight: 700 }}>{money(totalDebits)}</td>
            <td className="num" style={{ fontWeight: 700 }}>{money(totalCredits)}</td>
            <td className={`num ${Math.abs(totalDebits - totalCredits) < 0.01 ? "" : "neg"}`} style={{ fontWeight: 700 }}>
              {money(totalDebits - totalCredits)}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
