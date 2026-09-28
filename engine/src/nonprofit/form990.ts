import { addMoney, subMoney, ZERO_MONEY } from "../money/brands.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import {
  computeTaxReturn,
  TaxReturnError,
  type ComputeTaxReturnOptions,
  type ReturnInputProviderRequest,
  type TaxReturnResult,
} from "../tax-returns/return.ts";
import { NonprofitError } from "./errors.ts";
import { loadNonprofitStatements, type NonprofitStatements } from "./statements.ts";

const FEATURE_REMEDY = "Enable Form 990 workpapers in Company Settings → Features.";
const INPUT_KEYS = [
  "form990.revenue.total",
  "form990.expense.program",
  "form990.expense.management_general",
  "form990.expense.fundraising",
  "form990.position.assets.opening",
  "form990.position.assets.ending",
  "form990.position.liabilities.opening",
  "form990.position.liabilities.ending",
  "form990.position.net_assets.opening",
  "form990.position.net_assets.ending",
] as const;

function featureOff(): NonprofitError {
  return new NonprofitError({
    message: "Form 990 workpaper preparation is disabled; enable form990 in Company Settings → Features.",
    status: 422,
    code: "feature_off",
    remedy: FEATURE_REMEDY,
  });
}

export type Form990TieOut = {
  name: string;
  leftReference: string;
  rightReference: string;
  difference: string;
  tied: boolean;
};

export type Form990Source = {
  lineCode: string;
  inputKey: string;
  name: string;
  value: string;
};

export type Form990Workpaper = TaxReturnResult & {
  sources: Form990Source[];
  tieOuts: Form990TieOut[];
  refusals: [];
};

/** Resolve report inputs from the same book and snapshot as the return boxes. */
export async function form990ReturnInputProvider(
  request: ReturnInputProviderRequest,
): Promise<Readonly<Record<string, string>>> {
  if (!(await orgFeatureEnabled(request.orgId, "form990", request.runner))) throw featureOff();
  const unknownKeys = request.keys.filter((key) => !(INPUT_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new TaxReturnError(`return input provider "form990" does not define ${unknownKeys.join(", ")}`);
  }

  const bookId = await activePostingPrimaryBookId(request.orgId, request.runner);
  if (!bookId) {
    throw new NonprofitError({
      message: "Form 990 inputs require an active primary posting book.",
      status: 409,
      code: "nonprofit_statement_book_missing",
      remedy: "Set an active primary posting book in Company Settings → Accounting, then recompute the workpaper.",
    });
  }
  let current: NonprofitStatements;
  try {
    current = await loadNonprofitStatements({
      orgId: request.orgId,
      asOf: request.to,
      periodFrom: request.from,
      periodTo: request.to,
      bookId,
      runner: request.runner,
    });
  } catch (error) {
    if (error instanceof NonprofitError && error.code === "functional_mapping_missing") {
      throw new NonprofitError({
        message: `Return box "IX25A" cannot include the unmapped activity: ${error.message}`,
        status: 422,
        code: "return_unmapped_activity",
        remedy: error.remedy,
      });
    }
    throw error;
  }

  const currencySet = new Set([
    ...current.activities.rows.map((row) => row.baseCurrency),
    ...current.functionalExpenses.totals.map((row) => row.baseCurrency),
    ...current.financialPosition.totalAssets.map((row) => row.baseCurrency),
    ...current.financialPosition.totalLiabilities.map((row) => row.baseCurrency),
    ...current.financialPosition.totalNetAssets.map((row) => row.baseCurrency),
    ...current.cashFlows.reconciliation.map((row) => row.baseCurrency),
  ]);
  if (currencySet.size > 1) {
    throw new NonprofitError({
      message: `Form 990 inputs span functional currencies ${[...currencySet].sort().join(" and ")}.`,
      status: 422,
      code: "nonprofit_statement_currency_mismatch",
      remedy: "Prepare the workpaper for one functional currency at a time by separating the reporting organization by currency.",
    });
  }
  const currency = currencySet.values().next().value as string | undefined;
  const total = (rows: readonly { baseCurrency: string; amount: string }[]): string =>
    rows.filter((row) => row.baseCurrency === currency).reduce((sum, row) => addMoney(sum, row.amount), ZERO_MONEY);
  const functionAmount = (key: "program" | "management_general" | "fundraising"): string =>
    total(current.functionalExpenses.totals.filter((row) => row.functionKey === key));
  const openingTotal = (key: "openingAssets" | "openingLiabilities" | "openingNetAssets"): string =>
    total(current.cashFlows.reconciliation.map((row) => ({ baseCurrency: row.baseCurrency, amount: row[key] })));
  const result: Record<string, string> = {
    "form990.revenue.total": total(current.activities.rows.map((row) => ({ baseCurrency: row.baseCurrency, amount: row.revenue }))),
    "form990.expense.program": functionAmount("program"),
    "form990.expense.management_general": functionAmount("management_general"),
    "form990.expense.fundraising": functionAmount("fundraising"),
    "form990.position.assets.opening": openingTotal("openingAssets"),
    "form990.position.assets.ending": total(current.financialPosition.totalAssets),
    "form990.position.liabilities.opening": openingTotal("openingLiabilities"),
    "form990.position.liabilities.ending": total(current.financialPosition.totalLiabilities),
    "form990.position.net_assets.opening": openingTotal("openingNetAssets"),
    "form990.position.net_assets.ending": total(current.financialPosition.totalNetAssets),
  };
  return Object.fromEntries(request.keys.map((key) => [key, result[key]!])) as Record<string, string>;
}

function tieOut(name: string, leftReference: string, rightReference: string, left: string, right: string): Form990TieOut {
  const difference = subMoney(left, right);
  return { name, leftReference, rightReference, difference, tied: difference === ZERO_MONEY };
}

/** Assemble the workpaper evidence expected by printable and review surfaces. */
export async function computeForm990Workpaper(
  orgId: string,
  from: string,
  to: string,
  options: Omit<ComputeTaxReturnOptions, "translation"> = {},
): Promise<Form990Workpaper> {
  const result = await computeTaxReturn(orgId, "US_990", from, to, {}, options);
  const boxes = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
  const requireBox = (code: string): string => {
    const value = boxes.get(code);
    if (value === undefined) throw new TaxReturnError(`Form 990 workpaper is missing box ${code}.`);
    return value;
  };
  const sources = (result.inputSources ?? []).map((source) => ({
    ...source,
    name: source.inputKey === "form990.revenue.total" ? "Statement of Activities" :
      source.inputKey.startsWith("form990.expense.") ? "Functional Expense Statement" :
        "Statement of Financial Position",
  }));
  const sourceValues = new Map(sources.map((source) => [source.inputKey, source.value]));
  const functionTotal = addMoney(
    addMoney(sourceValues.get("form990.expense.program") ?? ZERO_MONEY, sourceValues.get("form990.expense.management_general") ?? ZERO_MONEY),
    sourceValues.get("form990.expense.fundraising") ?? ZERO_MONEY,
  );
  const tieOuts = [
    tieOut("Part VIII revenue to Statement of Activities", "VIII12A", "form990.revenue.total", requireBox("VIII12A"), sourceValues.get("form990.revenue.total") ?? ZERO_MONEY),
    tieOut("Part IX expenses to functional statement", "IX25A", "functional expense totals", requireBox("IX25A"), functionTotal),
    tieOut("Part VIII revenue to Part I revenue", "I12", "VIII12A", requireBox("I12"), requireBox("VIII12A")),
    tieOut("Part IX expenses to Part I expenses", "I18", "IX25A", requireBox("I18"), requireBox("IX25A")),
    tieOut("Part X assets to liabilities and net assets at beginning of year", "X16A", "X33A", requireBox("X16A"), requireBox("X33A")),
    tieOut("Part X assets to liabilities and net assets at end of year", "X16B", "X33B", requireBox("X16B"), requireBox("X33B")),
  ];
  return { ...result, sources, tieOuts, refusals: [] };
}
