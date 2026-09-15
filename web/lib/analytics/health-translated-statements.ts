import "server-only";
import type { StatementRow } from "../reports";
import {
  statementMatrix,
  sumSection,
  PNL_TYPES,
  ASSET_TYPES,
  LIABILITY_TYPES,
  EQUITY_TYPES,
} from "../statement-matrix";
import { resolveSubsidiaryView } from "../consolidation";
import { decimalSum, decimalNeg, type ExactDecimal } from "../statement-format";

/**
 * Multi-currency consolidated fallback for the health dashboards: when the
 * scope spans functionals the single-functional statement readers refuse,
 * and the dashboard translates through the statement matrix instead — P&L
 * flows at each period's average rate, balance-sheet stocks at the current
 * rate, equity at historical with the CTA plugged — the same numbers the
 * formal statements report.
 *
 * Lives in its own module (loaded dynamically, only on the refusal path)
 * because the consolidation chain pulls Next-server modules that the
 * unit-test loader graphs must never see on the hot path.
 */
export async function translatedHealthStatements(
  orgId: string,
  from: string,
  to: string,
  pFrom: string,
  pTo: string,
  dims: { subsidiaryIds: string[] } | undefined,
  allowed: ReadonlySet<string> | null,
): Promise<{
  pl: { items: StatementRow[]; revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; netIncome: ExactDecimal };
  priorPl: { items: StatementRow[]; revenue: ExactDecimal; cogs: ExactDecimal; grossProfit: ExactDecimal; expenses: ExactDecimal; netIncome: ExactDecimal };
  bs: {
    assets: StatementRow[];
    liabilities: StatementRow[];
    equity: StatementRow[];
    totalAssets: ExactDecimal;
    totalLiabilities: ExactDecimal;
    totalEquity: ExactDecimal;
  };
}> {
  const subView = await resolveSubsidiaryView(undefined, to, allowed ? new Set(allowed) : null);
  const sub = subView.subsidiary;
  const matrixOpts = { orgId, dims, subsidiary: sub };
  const [matrix, priorMatrix, bsMatrix, bsPnl] = await Promise.all([
    statementMatrix({ ...matrixOpts, types: PNL_TYPES, mode: "flow", period: { from, to }, periodLabel: `${from}→${to}` }),
    statementMatrix({ ...matrixOpts, types: PNL_TYPES, mode: "flow", period: { from: pFrom, to: pTo }, periodLabel: `${pFrom}→${pTo}` }),
    statementMatrix({ ...matrixOpts, types: [...ASSET_TYPES, ...LIABILITY_TYPES, ...EQUITY_TYPES], mode: "balance", period: { from, to }, periodLabel: `${from}→${to}` }),
    statementMatrix({ ...matrixOpts, types: PNL_TYPES, mode: "balance", translationMode: "flow", period: { from, to }, periodLabel: `${from}→${to}` }),
  ]);
  const totalOf = (items: StatementRow[], types: string[]): ExactDecimal =>
    decimalSum(items.filter((r) => types.includes(r.type) && r.depth === 0).map((row) => row.balance));
  const section = (m: typeof matrix, types: string[]): StatementRow[] =>
    types.map((type) => ({
      id: type, number: null, name: type, type,
      balance: sumSection(m, [type])[0] ?? "0.0000",
      depth: 0, isSummary: false,
    }));
  const plOf = (m: typeof matrix) => {
    const items = section(m, PNL_TYPES);
    const revenue = totalOf(items, ["income", "income_other"]);
    const cogs = totalOf(items, ["cogs"]);
    const expenses = totalOf(items, ["expense", "expense_other", "expense_deferred"]);
    const grossProfit = decimalSum([revenue, decimalNeg(cogs)]);
    return { items, revenue, cogs, grossProfit, expenses, netIncome: decimalSum([grossProfit, decimalNeg(expenses)]) };
  };
  const pnlOf = (m: typeof matrix, types: string[]): ExactDecimal =>
    decimalSum(types.map((t) => sumSection(m, [t])[0] ?? "0.0000"));
  const assets = pnlOf(bsMatrix, ASSET_TYPES);
  const liabilities = pnlOf(bsMatrix, LIABILITY_TYPES);
  const equityPosted = pnlOf(bsMatrix, EQUITY_TYPES);
  const accumulated = decimalSum([
    pnlOf(bsPnl, ["income", "income_other"]),
    decimalNeg(pnlOf(bsPnl, ["cogs"])),
    decimalNeg(pnlOf(bsPnl, ["expense", "expense_other", "expense_deferred"])),
  ]);
  const translated = (sub?.rates?.length ?? 0) > 0;
  const cta = translated
    ? decimalSum([assets, decimalNeg(liabilities), decimalNeg(equityPosted), decimalNeg(accumulated)])
    : "0.0000";
  const totalEquity = decimalSum([equityPosted, accumulated, cta]);
  return {
    pl: plOf(matrix),
    priorPl: plOf(priorMatrix),
    bs: {
      assets: section(bsMatrix, ASSET_TYPES),
      liabilities: section(bsMatrix, LIABILITY_TYPES),
      equity: [
        ...section(bsMatrix, EQUITY_TYPES),
        { id: "computed-earnings", number: null, name: "Accumulated earnings (computed)", type: "equity", balance: accumulated, depth: 1, isSummary: false },
        ...(translated ? [{ id: "computed-cta", number: null, name: "Cumulative translation adjustment", type: "equity", balance: cta, depth: 1, isSummary: false }] : []),
      ],
      totalAssets: assets,
      totalLiabilities: liabilities,
      totalEquity,
    },
  };
}
