import Link from "next/link";
import type { StatementRow } from "../../lib/reports";
import { money } from "../../lib/format";

export function StatementTable({
  sections,
  grandTotal,
}: {
  sections: { title: string; types: string[]; rows: StatementRow[]; total: number }[];
  grandTotal?: { label: string; value: number };
}) {
  return (
    <table className="data">
      <tbody>
        {sections.map((s) => {
          const rows = s.rows.filter((r) => s.types.includes(r.type));
          if (rows.length === 0) return null;
          return (
            <SectionRows key={s.title} title={s.title} rows={rows} total={s.total} />
          );
        })}
        {grandTotal && (
          <tr>
            <td style={{ fontWeight: 700 }}>{grandTotal.label}</td>
            <td className={`num ${grandTotal.value < 0 ? "neg" : ""}`} style={{ fontWeight: 700 }}>
              {money(grandTotal.value)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function SectionRows({ title, rows, total }: { title: string; rows: StatementRow[]; total: number }) {
  return (
    <>
      <tr><td colSpan={2} style={{ background: "#fbfbfa", fontWeight: 650, fontSize: 13 }}>{title}</td></tr>
      {rows.map((r) => (
        <tr key={r.id} className={`indent-${Math.min(r.depth + 1, 2)}`}>
          <td style={r.isSummary ? { fontWeight: 600 } : undefined}>
            <Link href={`/accounts/${r.id}`} style={{ color: "inherit" }}>
              <span className="mono muted">{r.number}</span> {r.name}
            </Link>
          </td>
          <td className={`num ${r.balance < 0 ? "neg" : ""}`}>{money(r.balance)}</td>
        </tr>
      ))}
      <tr>
        <td style={{ fontWeight: 650 }}>Total {title}</td>
        <td className={`num ${total < 0 ? "neg" : ""}`} style={{ fontWeight: 650 }}>{money(total)}</td>
      </tr>
    </>
  );
}
