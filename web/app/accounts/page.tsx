import { accountsWithBalances } from "../../lib/data";
import { money } from "../../lib/format";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  asset_bank: "Bank", asset_receivable: "Accounts Receivable", asset_current_other: "Other Current Asset",
  asset_fixed: "Fixed Asset", asset_other: "Other Asset",
  liability_payable: "Accounts Payable", liability_card: "Corporate Cards",
  liability_current_other: "Other Current Liability", liability_long_term: "Long-Term Liability",
  equity: "Equity", income: "Income", income_other: "Other Income",
  cogs: "Cost of Goods Sold", expense: "Expense", expense_other: "Other Expense",
  expense_deferred: "Deferred Expense",
};

export default async function Accounts() {
  const accounts = await accountsWithBalances();

  // roll balances up into summary parents, order as a tree grouped by type
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rolled = new Map<string, number>(accounts.map((a) => [a.id, Number(a.balance)]));
  for (const a of accounts) {
    let p = a.parent_id;
    while (p) {
      rolled.set(p, (rolled.get(p) ?? 0) + Number(a.balance));
      p = byId.get(p)?.parent_id ?? null;
    }
  }
  const depth = (a: (typeof accounts)[number]) => {
    let d = 0, p = a.parent_id;
    while (p) { d++; p = byId.get(p)?.parent_id ?? null; }
    return Math.min(d, 2);
  };
  const children = new Map<string | null, typeof accounts>();
  for (const a of accounts) {
    const k = a.parent_id;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(a);
  }
  const ordered: typeof accounts = [];
  const walk = (parent: string | null) => {
    for (const a of children.get(parent) ?? []) { ordered.push(a); walk(a.id); }
  };
  walk(null);

  let currentType = "";
  return (
    <>
      <h1>Chart of Accounts</h1>
      <p className="sub">{accounts.length} accounts · balances from the ledger, rolled up through summary accounts</p>
      <table className="data">
        <thead>
          <tr><th style={{ width: 90 }}>Number</th><th>Account</th><th className="num">Balance</th></tr>
        </thead>
        <tbody>
          {ordered.map((a) => {
            const bal = rolled.get(a.id) ?? 0;
            const typeHeader = a.type !== currentType && !a.parent_id;
            if (typeHeader) currentType = a.type;
            return (
              <FragmentRow key={a.id} a={a} bal={bal} depth={depth(a)}
                header={typeHeader ? (TYPE_LABELS[a.type] ?? a.type) : null} />
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function FragmentRow({ a, bal, depth, header }: {
  a: { id: string; number: string | null; name: string; is_summary: boolean; is_active: boolean };
  bal: number; depth: number; header: string | null;
}) {
  return (
    <>
      {header && (
        <tr><td colSpan={3} style={{ background: "#fbfbfa", fontWeight: 650, fontSize: 13 }}>{header}</td></tr>
      )}
      <tr className={`indent-${depth}`}>
        <td className="mono muted">{a.number}</td>
        <td style={a.is_summary ? { fontWeight: 600 } : undefined}>
          {a.name}
          {!a.is_active && <span className="pill neutral" style={{ marginLeft: 8 }}>inactive</span>}
          {a.is_summary && <span className="pill neutral" style={{ marginLeft: 8 }}>summary</span>}
        </td>
        <td className={`num ${bal < 0 ? "neg" : ""}`}>{money(bal)}</td>
      </tr>
    </>
  );
}
