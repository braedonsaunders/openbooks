import { balanceSheet } from "../../../lib/reports";
import { money } from "../../../lib/format";
import { StatementTable } from "../StatementTable";

export const dynamic = "force-dynamic";

const ASSET_TYPES = ["asset_bank", "asset_receivable", "asset_current_other", "asset_fixed", "asset_other"];
const LIAB_TYPES = ["liability_payable", "liability_card", "liability_current_other", "liability_long_term"];

export default async function BalanceSheet({ searchParams }: { searchParams: Promise<{ asof?: string }> }) {
  const { asof } = await searchParams;
  const date = asof ?? new Date().toISOString().slice(0, 10);
  const bs = await balanceSheet(date);
  const balanced = Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity)) < 0.01;

  return (
    <>
      <h1>Balance Sheet</h1>
      <p className="sub">as of {date}</p>
      <div className="grid">
        <div className="card"><div className="label">Assets</div><div className="value small">{money(bs.totalAssets)}</div></div>
        <div className="card"><div className="label">Liabilities</div><div className="value small">{money(bs.totalLiabilities)}</div></div>
        <div className="card"><div className="label">Equity</div><div className="value small">{money(bs.totalEquity)}</div></div>
        <div className={`card ${balanced ? "good" : "bad"}`}>
          <div className="label">A = L + E</div>
          <div className="value small">{balanced ? "balanced" : `off by ${money(bs.totalAssets - bs.totalLiabilities - bs.totalEquity)}`}</div>
        </div>
      </div>
      <StatementTable
        sections={[
          { title: "Assets", types: ASSET_TYPES, rows: bs.assets, total: bs.totalAssets },
          { title: "Liabilities", types: LIAB_TYPES, rows: bs.liabilities, total: bs.totalLiabilities },
          { title: "Equity", types: ["equity"], rows: bs.equity, total: bs.totalEquity },
        ]}
      />
    </>
  );
}
