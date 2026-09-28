import { sql } from "drizzle-orm";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { addMoney, cmpMoney, negMoney, subMoney, sumMoney, ZERO_MONEY, type Money } from "../money/brands.ts";
import { NonprofitError, fundFeatureOff } from "./errors.ts";
import {
  FUNCTIONAL_CATEGORIES,
  functionalFeatureOff,
  resolveFunctionalAssignment,
  type FunctionalCategory,
  type FunctionalMapping,
} from "./functional.ts";
import { NONPROFIT_FRAMEWORKS, requireNonprofitFramework } from "./frameworks.ts";

type StatementLineRow = {
  line_id: string;
  account_id: string;
  account_number: string;
  account_name: string;
  account_type: string;
  amount: string;
  posting_date: string;
  origin: string;
  fund_id: string | null;
  fund_code: string | null;
  fund_name: string | null;
  restriction_class: string | null;
  base_currency: string;
  department_id: string | null;
  project_id: string | null;
};

type AccountRow = {
  id: string;
  number: string;
  name: string;
  type: string;
};

type MappingRow = {
  id: string;
  org_id: string;
  department_id: string | null;
  project_id: string | null;
  function: string;
  program_key: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  created_by: string;
};

type ReleaseRow = {
  from_class: string | null;
  to_class: string | null;
  amount: string;
  base_currency: string;
};

export type NonprofitStatementInput = {
  orgId: string;
  asOf: string;
  periodFrom: string;
  periodTo: string;
  fundId?: string | null;
  bookId?: string | null;
  /** Reuse an existing read snapshot when another report owns the consistency boundary. */
  runner?: SqlExecutor;
};

export type AccountSnapshot = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  fundId: string | null;
  fundCode: string | null;
  restrictionClass: string | null;
  restrictionClassLabel: string | null;
  baseCurrency: string | null;
  balance: Money;
};

export type NetAssetsByClass = {
  restrictionClass: string | null;
  restrictionClassLabel: string | null;
  baseCurrency: string;
  amount: Money;
};

export type FinancialPositionStatement = {
  asOf: string;
  accounts: AccountSnapshot[];
  netAssetsByClass: NetAssetsByClass[];
  totalAssets: Array<{ baseCurrency: string; amount: Money }>;
  totalLiabilities: Array<{ baseCurrency: string; amount: Money }>;
  totalNetAssets: Array<{ baseCurrency: string; amount: Money }>;
};

export type ActivityStatementRow = {
  restrictionClass: string | null;
  restrictionClassLabel: string | null;
  baseCurrency: string;
  revenue: Money;
  expenses: Money;
  netActivity: Money;
  grossReleasedFromClass: Money;
  grossReleasedToClass: Money;
};

export type FunctionalStatementRow = {
  accountId: string;
  accountNumber: string;
  accountName: string;
  functionKey: FunctionalCategory;
  programKey: string | null;
  baseCurrency: string;
  amount: Money;
};

export type FunctionalStatementTotal = {
  functionKey: FunctionalCategory;
  baseCurrency: string;
  amount: Money;
};

export type CashFlowReconciliation = {
  baseCurrency: string;
  openingCash: Money;
  openingAssets: Money;
  openingLiabilities: Money;
  cashChange: Money;
  closingCash: Money;
  openingNetAssets: Money;
  netActivity: Money;
  otherNetAssetChanges: Money;
  closingNetAssets: Money;
  reconciliationDifference: Money;
};

export type NonprofitStatements = {
  financialPosition: FinancialPositionStatement;
  activities: {
    from: string;
    to: string;
    rows: ActivityStatementRow[];
    netActivityByCurrency: Array<{ baseCurrency: string; amount: Money }>;
  };
  functionalExpenses: {
    from: string;
    to: string;
    rows: FunctionalStatementRow[];
    totals: FunctionalStatementTotal[];
    totalExpenseByCurrency: Array<{ baseCurrency: string; amount: Money }>;
  };
  cashFlows: {
    from: string;
    to: string;
    reconciliation: CashFlowReconciliation[];
  };
};

function requireDate(value: string, field: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new NonprofitError({
      message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
      status: 422,
      code: "nonprofit_statement_date_invalid",
      remedy: "Choose valid asOf, periodFrom, and periodTo dates for the statement.",
      field,
    });
  }
}

function validateInput(input: NonprofitStatementInput): void {
  requireDate(input.asOf, "asOf");
  requireDate(input.periodFrom, "periodFrom");
  requireDate(input.periodTo, "periodTo");
  if (input.periodFrom > input.periodTo || input.periodTo > input.asOf) {
    throw new NonprofitError({
      message: "The statement period must be ordered and cannot end after its as-of date.",
      status: 422,
      code: "nonprofit_statement_period_invalid",
      remedy: "Choose periodFrom ≤ periodTo ≤ asOf.",
      field: "periodTo",
    });
  }
  if (input.fundId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.fundId)) {
    throw new NonprofitError({
      message: "The statement fund filter is not a valid fund identifier.",
      status: 422,
      code: "nonprofit_statement_fund_invalid",
      remedy: "Choose a fund from the report's fund filter.",
      field: "fundId",
    });
  }
  if (input.bookId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.bookId)) {
    throw new NonprofitError({
      message: "The statement book filter is not a valid accounting book identifier.",
      status: 422,
      code: "nonprofit_statement_book_invalid",
      remedy: "Choose an active posting book from the report's book filter.",
      field: "bookId",
    });
  }
}

function featureOff(key: string, label: string): NonprofitError {
  return new NonprofitError({
    message: `${label} is disabled; enable ${key} in Company Settings → Features.`,
    status: 422,
    code: "feature_off",
    remedy: `Enable ${label} in Company Settings → Features.`,
  });
}

function add(map: Map<string, Money>, key: string, amount: string): void {
  map.set(key, addMoney(map.get(key) ?? ZERO_MONEY, amount));
}

function isIncome(type: string): boolean {
  return type === "income" || type.startsWith("income_") || type === "revenue" || type.startsWith("revenue_");
}

function isExpense(type: string): boolean {
  return type === "cogs" || type.startsWith("expense") || type.startsWith("cost_of_goods");
}

function isAsset(type: string): boolean {
  return type.startsWith("asset");
}

function isLiability(type: string): boolean {
  return type.startsWith("liability");
}

/**
 * Posting account types holding cash. Every native cash reader keys on
 * asset_bank; the fund tie-out reuses this predicate instead of its own.
 */
export function isCashAccountType(type: string): boolean {
  return type === "asset_bank";
}

function isCash(type: string): boolean {
  return isCashAccountType(type);
}

async function resolveStatementBookId(orgId: string, requestedBookId?: string | null, runner: SqlExecutor = db): Promise<string> {
  const row = (await runner.execute<{ book_id: string }>(sql`
    select b.id as book_id
      from accounting_books b
      join subsidiaries s on s.org_id = b.org_id
     where b.org_id = ${orgId}
       and b.is_active and b.posts_gl
       and (${requestedBookId ?? null}::uuid is not null and b.id = ${requestedBookId ?? null}::uuid
            or ${requestedBookId ?? null}::uuid is null and b.is_primary)
       and s.is_active and not s.is_elimination and s.parent_id is null
     order by b.created_at, b.id, s.created_at, s.id
     limit 1
  `)).rows[0];
  if (!row) {
    throw new NonprofitError({
      message: requestedBookId
        ? "The requested accounting book is not an active posting book with an active root subsidiary."
        : "No active primary accounting book and root subsidiary are available for the statement.",
      status: 409,
      code: "nonprofit_statement_book_missing",
      remedy: "Set an active primary book and root subsidiary, or choose an active posting book, in Company Settings → Accounting.",
      ...(requestedBookId ? { field: "bookId" } : {}),
    });
  }
  return row.book_id;
}

function mapMapping(row: MappingRow): FunctionalMapping {
  return {
    id: row.id,
    orgId: row.org_id,
    departmentId: row.department_id,
    projectId: row.project_id,
    functionKey: row.function as FunctionalCategory,
    programKey: row.program_key,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

type PositionScopeInput = {
  orgId: string;
  asOf: string;
  bookId?: string | null;
  fundId?: string | null;
};

type PositionScope = {
  bookId: string;
  classLabel: (restrictionClass: string | null) => string | null;
  rows: StatementLineRow[];
  financialPosition: FinancialPositionStatement;
};

/**
 * Single-book posted/reversed financial-position snapshot. Performs no
 * feature-gate checks itself: the full four-statement loader keeps its
 * nonprofit, fundAccounting, and functionalExpenses gates in order, while
 * the fund-only cockpit projection gates nonprofit and fundAccounting only.
 */
async function loadPositionData(scope: PositionScopeInput, runner: SqlExecutor): Promise<PositionScope> {
  const bookId = await resolveStatementBookId(scope.orgId, scope.bookId, runner);
  const framework = await requireNonprofitFramework(scope.orgId, runner);
  const classLabels = new Map(Object.entries(NONPROFIT_FRAMEWORKS[framework.framework].classes));
  const classLabel = (restrictionClass: string | null): string | null => {
    if (restrictionClass === null) return null;
    const label = classLabels.get(restrictionClass);
    if (!label) {
      throw new NonprofitError({
        message: `Fund restriction class ${restrictionClass} is not defined by ${framework.framework}.`,
        status: 409,
        code: "nonprofit_statement_class_invalid",
        remedy: "Use a restriction class defined by the selected nonprofit framework when setting up funds.",
      });
    }
    return label;
  };

  const accounts = (await runner.execute<AccountRow>(sql`
    select id, number, name, type
      from accounts
     where org_id = ${scope.orgId}
     order by number, id
  `)).rows;
  const lineRows = await runner.execute<StatementLineRow>(sql`
    select jl.id::text as line_id, jl.account_id::text as account_id,
           a.number as account_number, a.name as account_name, a.type as account_type,
           jl.amount::text as amount, je.posting_date::text as posting_date,
           je.origin, jl.extra_dims->>'fund' as fund_id,
           sv.code as fund_code, sv.name as fund_name, f.restriction_class,
           sub.base_currency, jl.department_id::text as department_id,
           jl.project_id::text as project_id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
      join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = jl.org_id
      left join funds f on f.org_id = jl.org_id and f.id::text = jl.extra_dims->>'fund'
      left join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
     where jl.org_id = ${scope.orgId}
       and je.book_id = ${bookId}
       and je.status in ('posted', 'reversed')
       and je.posting_date <= ${scope.asOf}::date
       and (${scope.fundId ?? null}::uuid is null or jl.extra_dims->>'fund' = ${scope.fundId ?? null})
     order by je.posting_date, jl.entry_id, jl.line_number, jl.id
  `);
  const rows = lineRows.rows;

  const accountBalanceMap = new Map<string, Money>();
  const accountSnapshotMeta = new Map<string, StatementLineRow>();
  const byClassBalance = new Map<string, Money>();
  const assetsByCurrency = new Map<string, Money>();
  const liabilitiesByCurrency = new Map<string, Money>();
  for (const row of rows) {
    const accountFundKey = `${row.account_id}\u0000${row.fund_id ?? "∅"}\u0000${row.base_currency}`;
    add(accountBalanceMap, accountFundKey, row.amount);
    accountSnapshotMeta.set(accountFundKey, row);
    if (isAsset(row.account_type)) add(assetsByCurrency, row.base_currency, row.amount);
    if (isLiability(row.account_type)) add(liabilitiesByCurrency, row.base_currency, row.amount);
    if (isAsset(row.account_type) || isLiability(row.account_type)) {
      add(byClassBalance, `${row.restriction_class ?? "∅"}\u0000${row.base_currency}`, row.amount);
    }
  }
  const observedAccounts = new Set([...accountSnapshotMeta.values()].map((row) => row.account_id));
  for (const account of accounts) {
    if (!observedAccounts.has(account.id)) {
      const key = `${account.id}\u0000∅\u0000∅`;
      accountBalanceMap.set(key, ZERO_MONEY);
      accountSnapshotMeta.set(key, {
        line_id: "",
        account_id: account.id,
        account_number: account.number,
        account_name: account.name,
        account_type: account.type,
        amount: ZERO_MONEY,
        posting_date: scope.asOf,
        origin: "",
        fund_id: null,
        fund_code: null,
        fund_name: null,
        restriction_class: null,
        base_currency: "",
        department_id: null,
        project_id: null,
      });
    }
  }
  const accountSnapshots: AccountSnapshot[] = [...accountBalanceMap.entries()].map(([key, balance]) => {
    const row = accountSnapshotMeta.get(key)!;
    return {
      accountId: row.account_id,
      accountNumber: row.account_number,
      accountName: row.account_name,
      accountType: row.account_type,
      fundId: row.fund_id,
      fundCode: row.fund_code,
      restrictionClass: row.restriction_class,
      restrictionClassLabel: classLabel(row.restriction_class),
      baseCurrency: row.base_currency || null,
      balance,
    };
  });

  const totalCurrencies = new Set([...assetsByCurrency.keys(), ...liabilitiesByCurrency.keys()]);
  const totalAssets = [...assetsByCurrency.entries()].map(([baseCurrency, amount]) => ({ baseCurrency, amount }));
  const totalLiabilities = [...liabilitiesByCurrency.entries()].map(([baseCurrency, amount]) => ({ baseCurrency, amount: negMoney(amount) }));
  const netAssets = [...totalCurrencies].map((baseCurrency) => ({
    baseCurrency,
    amount: addMoney(assetsByCurrency.get(baseCurrency) ?? ZERO_MONEY, liabilitiesByCurrency.get(baseCurrency) ?? ZERO_MONEY),
  }));
  const netAssetsByClass = [...byClassBalance.entries()].map(([key, amount]) => {
    const [restrictionClass, baseCurrency] = key.split("\u0000");
    const classKey = restrictionClass === "∅" ? null : restrictionClass!;
    return { restrictionClass: classKey, restrictionClassLabel: classLabel(classKey), baseCurrency: baseCurrency!, amount };
  });

  return {
    bookId,
    classLabel,
    rows,
    financialPosition: {
      asOf: scope.asOf,
      accounts: accountSnapshots,
      netAssetsByClass,
      totalAssets,
      totalLiabilities,
      totalNetAssets: netAssets,
    },
  };
}

/** Read and reconcile all four statements from posted ledger lines. */
export async function loadNonprofitStatements(input: NonprofitStatementInput): Promise<NonprofitStatements> {
  validateInput(input);
  const runner = input.runner ?? db;
  const load = async () => {
    if (!(await orgFeatureEnabled(input.orgId, "nonprofit", runner))) throw featureOff("nonprofit", "Nonprofit Accounting");
    if (!(await orgFeatureEnabled(input.orgId, "fundAccounting", runner))) throw fundFeatureOff();
    if (!(await orgFeatureEnabled(input.orgId, "functionalExpenses", runner))) throw functionalFeatureOff();
    const scope = await loadPositionData(
      { orgId: input.orgId, asOf: input.asOf, bookId: input.bookId, fundId: input.fundId },
      runner,
    );
    const bookId = scope.bookId;
    const classLabel = scope.classLabel;
    const rows = scope.rows;

    const mappings = (await runner.execute<MappingRow>(sql`
      select id, org_id, department_id, project_id, function, program_key,
             effective_from::text, effective_to::text, created_at::text, created_by::text
        from functional_mappings
       where org_id = ${input.orgId}
       order by effective_from, id
    `)).rows.map(mapMapping);
    const periodRows = rows.filter((row) => row.posting_date >= input.periodFrom && row.posting_date <= input.periodTo);
    const releaseRows = (await runner.execute<ReleaseRow>(sql`
      select source_fund.restriction_class as from_class,
             target_fund.restriction_class as to_class,
             release.amount::text as amount, source_sub.base_currency
        from fund_releases release
        join funds source_fund on source_fund.org_id = release.org_id and source_fund.id = release.from_fund_id
        join funds target_fund on target_fund.org_id = release.org_id and target_fund.id = release.to_fund_id
        join journal_entries release_entry on release_entry.org_id = release.org_id and release_entry.id = release.posted_entry_id
        join subsidiaries source_sub on source_sub.org_id = release.org_id and source_sub.id = release_entry.subsidiary_id
       where release.org_id = ${input.orgId}
         and release_entry.book_id = ${bookId}
         and release.status = 'posted'
         and release.release_date between ${input.periodFrom}::date and ${input.periodTo}::date
         and (${input.fundId ?? null}::uuid is null or release.from_fund_id = ${input.fundId ?? null}
              or release.to_fund_id = ${input.fundId ?? null})
    `));

    const activityNet = new Map<string, Money>();
    const activitiesByClass = new Map<string, { revenue: Money; expenses: Money }>();
    for (const row of periodRows) {
      const key = `${row.restriction_class ?? "∅"}\u0000${row.base_currency}`;
      const current = activitiesByClass.get(key) ?? { revenue: ZERO_MONEY, expenses: ZERO_MONEY };
      if (row.origin !== "release" && isIncome(row.account_type)) {
        current.revenue = addMoney(current.revenue, negMoney(row.amount));
      }
      if (row.origin !== "release" && isExpense(row.account_type)) {
        current.expenses = addMoney(current.expenses, row.amount);
      }
      activitiesByClass.set(key, current);
      if (row.origin !== "release" && (isIncome(row.account_type) || isExpense(row.account_type))) {
        add(activityNet, row.base_currency, negMoney(row.amount));
      }
    }
    const releaseByClass = new Map<string, { from: Money; to: Money }>();
    for (const release of releaseRows.rows) {
      for (const [restrictionClass, side] of [[release.from_class, "from"], [release.to_class, "to"]] as const) {
        const key = `${restrictionClass ?? "∅"}\u0000${release.base_currency}`;
        const current = releaseByClass.get(key) ?? { from: ZERO_MONEY, to: ZERO_MONEY };
        current[side] = addMoney(current[side], release.amount);
        releaseByClass.set(key, current);
      }
    }
    const activityKeys = new Set([...activitiesByClass.keys(), ...releaseByClass.keys()]);
    const activities: ActivityStatementRow[] = [...activityKeys].map((key) => {
      const [restrictionClass, baseCurrency] = key.split("\u0000");
      const activity = activitiesByClass.get(key) ?? { revenue: ZERO_MONEY, expenses: ZERO_MONEY };
      const releases = releaseByClass.get(key) ?? { from: ZERO_MONEY, to: ZERO_MONEY };
      const classKey = restrictionClass === "∅" ? null : restrictionClass!;
      return {
        restrictionClass: classKey,
        restrictionClassLabel: classLabel(classKey),
        baseCurrency: baseCurrency!,
        ...activity,
        netActivity: subMoney(activity.revenue, activity.expenses),
        grossReleasedFromClass: releases.from,
        grossReleasedToClass: releases.to,
      };
    });

    const functionalMap = new Map<string, Money>();
    const functionTotals = new Map<string, Money>();
    const totalExpenseByCurrency = new Map<string, Money>();
    const functionalMeta = new Map<string, FunctionalStatementRow>();
    for (const row of periodRows) {
      if (!isExpense(row.account_type)) continue;
      const assignment = resolveFunctionalAssignment({
        accountName: `${row.account_number} ${row.account_name}`,
        departmentId: row.department_id,
        projectId: row.project_id,
        postingDate: row.posting_date,
      }, mappings);
      const key = [row.account_id, assignment.functionKey, assignment.programKey ?? "∅", row.base_currency].join("\u0000");
      add(functionalMap, key, row.amount);
      functionalMeta.set(key, {
        accountId: row.account_id,
        accountNumber: row.account_number,
        accountName: row.account_name,
        functionKey: assignment.functionKey,
        programKey: assignment.programKey,
        baseCurrency: row.base_currency,
        amount: ZERO_MONEY,
      });
      add(functionTotals, `${assignment.functionKey}\u0000${row.base_currency}`, row.amount);
      add(totalExpenseByCurrency, row.base_currency, row.amount);
    }
    const functionalRows: FunctionalStatementRow[] = [...functionalMap.entries()].map(([key, amount]) => ({
      ...functionalMeta.get(key)!,
      amount,
    }));
    for (const currency of totalExpenseByCurrency.keys()) {
      const functionSum = FUNCTIONAL_CATEGORIES.reduce(
        (total, category) => addMoney(total, functionTotals.get(`${category}\u0000${currency}`) ?? ZERO_MONEY),
        ZERO_MONEY,
      );
      if (functionSum !== totalExpenseByCurrency.get(currency)) {
        throw new NonprofitError({
          message: `Functional expense totals do not tie to posted expense in ${currency}.`,
          status: 409,
          code: "functional_statement_out_of_balance",
          remedy: "Correct the effective functional mappings and allocation-rule targets, then rerun the functional statement.",
        });
      }
    }
    const functionalTotals: FunctionalStatementTotal[] = [...functionTotals.entries()].map(([key, amount]) => {
      const [functionKey, baseCurrency] = key.split("\u0000");
      return { functionKey: functionKey as FunctionalCategory, baseCurrency: baseCurrency!, amount };
    });

    const currencies = new Set(rows.map((row) => row.base_currency));
    const reconciliation: CashFlowReconciliation[] = [...currencies].map((baseCurrency) => {
      const beginningRows = rows.filter((row) => row.posting_date < input.periodFrom && row.base_currency === baseCurrency);
      const endingRows = rows.filter((row) => row.posting_date <= input.periodTo && row.base_currency === baseCurrency);
      const openingCash = sumMoney(beginningRows.filter((row) => isCash(row.account_type)).map((row) => row.amount));
      const closingCash = sumMoney(endingRows.filter((row) => isCash(row.account_type)).map((row) => row.amount));
      const openingAssets = sumMoney(beginningRows.filter((row) => isAsset(row.account_type)).map((row) => row.amount));
      const openingLiabilities = sumMoney(beginningRows.filter((row) => isLiability(row.account_type)).map((row) => row.amount));
      const closingAssets = sumMoney(endingRows.filter((row) => isAsset(row.account_type)).map((row) => row.amount));
      const closingLiabilities = sumMoney(endingRows.filter((row) => isLiability(row.account_type)).map((row) => row.amount));
      const openingNetAssets = addMoney(openingAssets, openingLiabilities);
      const closingNetAssets = addMoney(closingAssets, closingLiabilities);
      const netActivity = activityNet.get(baseCurrency) ?? ZERO_MONEY;
      const otherNetAssetChanges = subMoney(subMoney(closingNetAssets, openingNetAssets), netActivity);
      return {
        baseCurrency,
        openingCash,
        openingAssets,
        openingLiabilities: negMoney(openingLiabilities),
        cashChange: subMoney(closingCash, openingCash),
        closingCash,
        openingNetAssets,
        netActivity,
        otherNetAssetChanges,
        closingNetAssets,
        reconciliationDifference: subMoney(
          addMoney(addMoney(openingNetAssets, netActivity), otherNetAssetChanges),
          closingNetAssets,
        ),
      };
    });

    return {
      financialPosition: scope.financialPosition,
      activities: {
        from: input.periodFrom,
        to: input.periodTo,
        rows: activities,
        netActivityByCurrency: [...activityNet.entries()].map(([baseCurrency, amount]) => ({ baseCurrency, amount })),
      },
      functionalExpenses: {
        from: input.periodFrom,
        to: input.periodTo,
        rows: functionalRows,
        totals: functionalTotals,
        totalExpenseByCurrency: [...totalExpenseByCurrency.entries()].map(([baseCurrency, amount]) => ({ baseCurrency, amount })),
      },
      cashFlows: { from: input.periodFrom, to: input.periodTo, reconciliation },
    };
  };
  return input.runner ? load() : withOrgContext(input.orgId, load);
}

export type FundCoverageRow = {
  fundId: string | null;
  fundCode: string | null;
  restrictionClass: string | null;
  restrictionClassLabel: string | null;
  baseCurrency: string;
  /** Restricted cash held: asset_bank balances for this fund, class, and currency. */
  cash: Money;
  /** Restricted net assets: asset and liability balances for this fund, class, and currency. */
  netAssets: Money;
  /** The single coverage difference: restricted cash held MINUS restricted net assets. */
  coverage: Money;
  /** Negative coverage means undercoverage and is flagged. */
  undercovered: boolean;
  cashAccountIds: string[];
  netAssetAccountIds: string[];
};

export type FundCoverageTieout = {
  asOf: string;
  bookId: string;
  rows: FundCoverageRow[];
  totals: Array<{ baseCurrency: string; cash: Money; netAssets: Money; coverage: Money }>;
  netAssetsTie: Array<{ baseCurrency: string; matrixSum: Money; statementTotal: Money; tied: boolean }>;
  interfund: Array<{ baseCurrency: string; amount: Money; zero: boolean }>;
};

/**
 * Derive the cockpit live fund tie-out from a financial-position snapshot.
 * Pure: partitioning, the cash-minus-net-assets difference, the
 * matrix-to-statement tie, and the interfund zero proof all read the same
 * posted/reversed lines, so no second accounting source exists. Nothing is stored.
 */
export function deriveFundCoverageTieout(
  financialPosition: FinancialPositionStatement,
  pairAccountIds: ReadonlySet<string>,
): Omit<FundCoverageTieout, "asOf" | "bookId"> {
  const meta = new Map<string, {
    fundId: string | null;
    fundCode: string | null;
    restrictionClass: string | null;
    restrictionClassLabel: string | null;
    baseCurrency: string;
  }>();
  const cash = new Map<string, Money>();
  const netAssets = new Map<string, Money>();
  const cashAccounts = new Map<string, Set<string>>();
  const netAssetAccounts = new Map<string, Set<string>>();
  const interfund = new Map<string, Money>();
  for (const snap of financialPosition.accounts) {
    if (!snap.baseCurrency) continue;
    const key = `${snap.fundId ?? ""}|${snap.restrictionClass ?? ""}|${snap.baseCurrency}`;
    if (!meta.has(key)) {
      meta.set(key, {
        fundId: snap.fundId,
        fundCode: snap.fundCode,
        restrictionClass: snap.restrictionClass,
        restrictionClassLabel: snap.restrictionClassLabel,
        baseCurrency: snap.baseCurrency,
      });
    }
    if (isCashAccountType(snap.accountType)) {
      add(cash, key, snap.balance);
      const ids = cashAccounts.get(key) ?? new Set<string>();
      ids.add(snap.accountId);
      cashAccounts.set(key, ids);
    }
    if (isAsset(snap.accountType) || isLiability(snap.accountType)) {
      add(netAssets, key, snap.balance);
      const ids = netAssetAccounts.get(key) ?? new Set<string>();
      ids.add(snap.accountId);
      netAssetAccounts.set(key, ids);
    }
    if (pairAccountIds.has(snap.accountId)) add(interfund, snap.baseCurrency, snap.balance);
  }
  const rows: FundCoverageRow[] = [...meta.entries()].map(([key, info]) => {
    const cashAmount = cash.get(key) ?? ZERO_MONEY;
    const netAmount = netAssets.get(key) ?? ZERO_MONEY;
    const coverage = subMoney(cashAmount, netAmount);
    return {
      ...info,
      cash: cashAmount,
      netAssets: netAmount,
      coverage,
      undercovered: cmpMoney(coverage, ZERO_MONEY) < 0,
      cashAccountIds: [...(cashAccounts.get(key) ?? [])].sort(),
      netAssetAccountIds: [...(netAssetAccounts.get(key) ?? [])].sort(),
    };
  }).sort((a, b) =>
    (a.fundCode ?? "").localeCompare(b.fundCode ?? "") ||
    (a.restrictionClass ?? "").localeCompare(b.restrictionClass ?? "") ||
    a.baseCurrency.localeCompare(b.baseCurrency),
  );
  const totals = new Map<string, { cash: Money; netAssets: Money }>();
  for (const row of rows) {
    const total = totals.get(row.baseCurrency) ?? { cash: ZERO_MONEY, netAssets: ZERO_MONEY };
    total.cash = addMoney(total.cash, row.cash);
    total.netAssets = addMoney(total.netAssets, row.netAssets);
    totals.set(row.baseCurrency, total);
  }
  const statementTotals = new Map<string, Money>(
    financialPosition.totalNetAssets.map((total) => [total.baseCurrency, total.amount]),
  );
  const currencies = [...new Set([...totals.keys(), ...statementTotals.keys(), ...interfund.keys()])].sort();
  return {
    rows,
    totals: currencies
      .filter((currency) => totals.has(currency))
      .map((currency) => {
        const total = totals.get(currency)!;
        return { baseCurrency: currency, cash: total.cash, netAssets: total.netAssets, coverage: subMoney(total.cash, total.netAssets) };
      }),
    netAssetsTie: currencies.map((currency) => {
      const matrixSum = totals.get(currency)?.netAssets ?? ZERO_MONEY;
      const statementTotal = statementTotals.get(currency) ?? ZERO_MONEY;
      return { baseCurrency: currency, matrixSum, statementTotal, tied: cmpMoney(matrixSum, statementTotal) === 0 };
    }),
    interfund: currencies.map((currency) => {
      const amount = interfund.get(currency) ?? ZERO_MONEY;
      return { baseCurrency: currency, amount, zero: cmpMoney(amount, ZERO_MONEY) === 0 };
    }),
  };
}

/**
 * Exact native ledger-drill scope for one tie-out cell, as data. The cockpit
 * encodes it with the shared report-drill codec unchanged: posting book,
 * as-of date, balance mode, exact fund segment, and the cell's accounts, so a
 * class total never drills broader than its fund components.
 */
export type FundLedgerDrillScope = {
  kind: "ledger";
  label: string;
  bookId: string;
  to: string;
  mode: "balance";
  accountIds?: string[];
  accountTypes?: string[];
  dims?: { segments?: Record<string, string> };
};

export function fundLedgerDrillScope(input: {
  bookId: string;
  asOf: string;
  fundId: string | null;
  label: string;
  accountIds?: readonly string[];
  accountTypes?: readonly string[];
}): FundLedgerDrillScope {
  return {
    kind: "ledger",
    label: input.label,
    bookId: input.bookId,
    to: input.asOf,
    mode: "balance",
    ...(input.accountIds ? { accountIds: [...input.accountIds] } : {}),
    ...(input.accountTypes ? { accountTypes: [...input.accountTypes] } : {}),
    ...(input.fundId ? { dims: { segments: { fund: input.fundId } } } : {}),
  };
}

async function listInterfundPairAccountIds(orgId: string, runner: SqlExecutor): Promise<Set<string>> {
  const rows = (await runner.execute<{ id: string }>(sql`
    select due_from_account_id as id from fund_pairs where org_id = ${orgId} and is_active
     union
    select due_to_account_id as id from fund_pairs where org_id = ${orgId} and is_active
  `)).rows;
  return new Set(rows.map((row) => row.id));
}

export type FundCoverageInput = {
  orgId: string;
  asOf: string;
  bookId?: string | null;
  /** Reuse an existing read snapshot when another report owns the consistency boundary. */
  runner?: SqlExecutor;
};

/**
 * Load the cockpit live fund tie-out: one coverage difference per fund,
 * restriction class, and currency, plus the statement tie and the interfund
 * zero proof. Gates nonprofit and fundAccounting only — functionalExpenses
 * never blocks the fund tie-out.
 */
export async function loadFundCoverageTieout(input: FundCoverageInput): Promise<FundCoverageTieout> {
  requireDate(input.asOf, "asOf");
  const runner = input.runner ?? db;
  const load = async () => {
    if (!(await orgFeatureEnabled(input.orgId, "nonprofit", runner))) throw featureOff("nonprofit", "Nonprofit Accounting");
    if (!(await orgFeatureEnabled(input.orgId, "fundAccounting", runner))) throw fundFeatureOff();
    const scope = await loadPositionData({ orgId: input.orgId, asOf: input.asOf, bookId: input.bookId }, runner);
    const pairAccountIds = await listInterfundPairAccountIds(input.orgId, runner);
    const derived = deriveFundCoverageTieout(scope.financialPosition, pairAccountIds);
    return { asOf: input.asOf, bookId: scope.bookId, ...derived };
  };
  return input.runner ? load() : withOrgContext(input.orgId, load);
}
