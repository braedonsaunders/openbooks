import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface HealthTestState {
  current: Record<string, unknown>;
  prior: Record<string, unknown>;
}

const stateKey = Symbol.for("openbooks.financial-health-test");
const state: HealthTestState = {
  current: {},
  prior: {},
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
    "mock:db",
    `
      export const db = {
        async execute() {
          return { rows: [{ s: 0, c: 0 }] }
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
