import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface HealthTestState {
  current: Record<string, unknown>;
  prior: Record<string, unknown>;
  primaryBookId: string;
  daAccountIds: string[];
  daRows: Array<{
    accountId: string;
    accountType: string;
    accountName: string;
    amount: number;
    status: string;
    bookId: string;
    origin: string;
    postingDate: string;
  }>;
  daQuery: unknown;
}

const stateKey = Symbol.for("openbooks.financial-health-test");
const state: HealthTestState = {
  current: {},
  prior: {},
  primaryBookId: "book-primary",
  daAccountIds: [],
  daRows: [],
  daQuery: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  ["mock:server-only", "export {}"],
  [
    "mock:money-server",
    `
      export async function getMoneyFormatter() {
        return { moneyCompact: (value) => String(value) }
      }
    `,
  ],
  [
    "mock:drizzle",
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    "mock:gl-summary",
    `
      export function statementBookExpr(orgId) {
        return {
          strings: ['(select b.id from accounting_books b where b.org_id = ', ' and b.is_primary order by b.created_at limit 1)'],
          values: [orgId],
        }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.financial-health-test')]
      export const db = {
        async execute(query) {
          const text = query?.strings?.join('') ?? String(query)
          if (!text.includes('from journal_lines l'))
            return { rows: [{ s: 0, c: 0 }] }

          state.daQuery = query
          const eligible = state.daRows.filter((row) =>
            ['expense', 'expense_other', 'expense_deferred'].includes(row.accountType) &&
            ['posted', 'reversed'].includes(row.status) &&
            row.bookId === state.primaryBookId &&
            (row.origin === 'depreciation' || state.daAccountIds.includes(row.accountId)) &&
            row.postingDate >= '2026-01-01' && row.postingDate <= '2026-01-31'
          )
          return { rows: [{ s: eligible.reduce((sum, row) => sum + row.amount, 0), c: 0 }] }
        },
      }
    `,
  ],
  [
    "mock:reports",
    `
      const state = globalThis[Symbol.for('openbooks.financial-health-test')]
      export async function profitAndLoss(from) {
        return from.startsWith('2025') ? state.prior : state.current
      }
      export async function balanceSheet() {
        return {
          liabilities: [],
          totalAssets: 1000,
          totalEquity: 1000,
        }
      }
    `,
  ],
  [
    "mock:org-scope",
    `
      export async function resolveOrgId(orgId) {
        return orgId || 'org-1'
      }
    `,
  ],
  [
    "mock:statement-format",
    `
      export function decimalSum(values) {
        return values.reduce((sum, value) => sum + Number(value), 0)
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { url: "mock:server-only", shortCircuit: true };
    const mockUrl = new Map([
      ["../money-server", "mock:money-server"],
      ["drizzle-orm", "mock:drizzle"],
      ["@openbooks/engine/src/db.ts", "mock:db"],
      ["../reports", "mock:reports"],
      ["../gl-summary", "mock:gl-summary"],
      ["../org-scope", "mock:org-scope"],
      ["../statement-format", "mock:statement-format"],
    ]).get(specifier);
    if (mockUrl) return { url: mockUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const financialHealthUrl = new URL(
  "./financial-health.ts?non-operating-income-regression",
  import.meta.url,
).href;
const { financialHealth } = (await import(financialHealthUrl)) as typeof import(
  "./financial-health.ts"
);
hooks.deregister();

const row = (type: string, balance: number) => ({
  id: type,
  number: null,
  name: type,
  type,
  balance,
  depth: 0,
  isSummary: false,
});

function pnl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [
      row("income", 100),
      row("income_other", 900),
      row("cogs", 40),
      row("expense", 20),
    ],
    revenue: 1000,
    cogs: 40,
    grossProfit: 960,
    netIncome: 940,
    ...overrides,
  };
}

function renderSql(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value);
  const query = value as { strings?: unknown[]; values?: unknown[] };
  if (!Array.isArray(query.strings)) return String(value);
  const values = Array.isArray(query.values) ? query.values : [];
  return query.strings.reduce(
    (text, part, index) => text + String(part) + (index < values.length ? renderSql(values[index]) : ""),
    "",
  );
}

function daRow(
  overrides: Partial<HealthTestState["daRows"][number]> = {},
): HealthTestState["daRows"][number] {
  return {
    accountId: "unmapped",
    accountType: "expense",
    accountName: "Compte de charges",
    amount: 0,
    status: "posted",
    bookId: state.primaryBookId,
    origin: "manual",
    postingDate: "2026-01-15",
    ...overrides,
  };
}

test("operating metrics exclude income_other from operating income and its derivatives", async () => {
  state.current = pnl();
  state.prior = pnl({
    items: [row("income", 100), row("cogs", 40), row("expense", 20)],
    revenue: 100,
    netIncome: 40,
  });

  const result = await financialHealth(
    { from: "2026-01-01", to: "2026-01-31", label: "January 2026" },
    undefined,
    "org-1",
  );
  const operatingMargin = result.ratios.profitability.find(
    (ratio) => ratio.id === "operating_margin",
  );
  const operatingLeverage = result.ratios.operating.find(
    (ratio) => ratio.id === "operating_leverage",
  );
  const ruleOf40 = result.ratios.operating.find(
    (ratio) => ratio.id === "rule_of_40",
  );
  const roic = result.ratios.profitability.find((ratio) => ratio.id === "roic");
  const roce = result.ratios.profitability.find((ratio) => ratio.id === "roce");

  assert.equal(result.figures.operatingIncome, 40);
  assert.equal(result.figures.ebitda, 40);
  assert.equal(operatingMargin?.value, 0.04);
  assert.equal(result.figures.rule40, 904);
  assert.equal(ruleOf40?.value, 904);
  assert.equal(roic?.value, 0.03);
  assert.equal(roce?.value, 0.04);
  assert.equal(operatingLeverage?.value, 0);
});

test("interest coverage is missing without positive interest expense and does not inflate health scores", async () => {
  const noInterestPnl = pnl({
    items: [
      row("income", 100),
      row("cogs", 60),
      row("expense", 20),
      row("expense_other", 0),
    ],
    revenue: 100,
    cogs: 60,
    grossProfit: 40,
    netIncome: 20,
  });
  state.current = noInterestPnl;
  state.prior = noInterestPnl;

  const result = await financialHealth(
    { from: "2026-01-01", to: "2026-01-31", label: "January 2026" },
    undefined,
    "org-1",
  );
  const interestCoverage = result.ratios.operating.find(
    (ratio) => ratio.id === "interest_coverage",
  );
  const operatingScore = result.categoryScores.find(
    (category) => category.key === "operating",
  );

  assert.deepEqual(
    {
      value: interestCoverage?.value,
      score: interestCoverage?.score,
      noData: interestCoverage?.noData,
      noDataMsg: interestCoverage?.noDataMsg,
      calc: interestCoverage?.calc,
    },
    {
      value: null,
      score: null,
      noData: true,
      noDataMsg: "No interest expense",
      calc: "No interest expense",
    },
  );
  assert.ok(Math.abs((operatingScore?.score ?? Number.NaN) - 79.16666666666667) < 1e-9);
  assert.ok(Math.abs(result.overallScore - 47.06349206349206) < 1e-9);
});

test("D&A uses configured mappings or depreciation origin in the primary posted book regardless of account language", async () => {
  const operatingPnl = pnl({
    items: [row("income", 200), row("cogs", 60), row("expense", 40)],
    revenue: 200,
    cogs: 60,
    grossProfit: 140,
    netIncome: 100,
  });
  state.current = operatingPnl;
  state.prior = operatingPnl;
  state.daAccountIds = ["fixed-asset-da", "lease-amortization"];
  state.daRows = [
    daRow({
      accountId: "fixed-asset-da",
      accountName: "Abschreibung Fahrzeuge",
      amount: 30,
    }),
    daRow({
      accountId: "lease-amortization",
      accountName: "Amortissement du contrat",
      amount: 20,
      status: "reversed",
    }),
    daRow({
      accountId: "origin-da",
      accountName: "折旧费用",
      amount: 10,
      origin: "depreciation",
    }),
    daRow({
      accountId: "name-only",
      accountName: "Depreciation expense",
      amount: 200,
    }),
    daRow({
      accountId: "fixed-asset-da",
      accountName: "Abschreibung Fahrzeuge",
      amount: 400,
      status: "draft",
    }),
    daRow({
      accountId: "lease-amortization",
      accountName: "Amortissement du contrat",
      amount: 500,
      bookId: "book-tax",
    }),
  ];
  state.daQuery = null;

  const result = await financialHealth(
    { from: "2026-01-01", to: "2026-01-31", label: "January 2026" },
    undefined,
    "org-1",
  );

  assert.equal(result.figures.depreciationAmortization, 60);
  assert.equal(result.figures.ebitda, 160);
  assert.equal(result.hasDA, true);
  assert.equal(
    state.daRows.find((candidate) => candidate.accountId === "origin-da")?.accountName,
    "折旧费用",
  );

  const query = renderSql(state.daQuery);
  assert.match(query, /with da_accounts as/);
  assert.match(query, /c\.depreciation_expense_account_id/);
  assert.match(query, /from fixed_assets a/);
  assert.match(query, /a\.depreciation_expense_account_id/);
  assert.match(query, /from lease_agreements l/);
  assert.match(query, /l\.amortization_expense_account_id/);
  assert.match(query, /e\.origin = 'depreciation'/);
  assert.match(query, /e\.status in \('posted', 'reversed'\)/);
  assert.match(query, /e\.book_id\s*=/);
  assert.doesNotMatch(query, /a\.name|like\s+'%deprec%|like\s+'%amort%/);
});
