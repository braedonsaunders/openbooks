import assert from "node:assert/strict";
import test from "node:test";
import { planUnbilledAccrual, type UnbilledSourceGroup } from "./unbilled-accrual.ts";

const ROOT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const ITEM_INCOME = "00000000-0000-4000-8000-0000000000b1";
const PROJECT_REVENUE = "00000000-0000-4000-8000-0000000000b2";

const group = (overrides: Partial<UnbilledSourceGroup>): UnbilledSourceGroup => ({
  projectId: P1,
  projectCode: "J-1",
  projectName: "Job one",
  projectSubsidiaryId: null,
  sourceCurrency: "CAD",
  itemName: "Labor",
  incomeAccountId: ITEM_INCOME,
  usesProjectRevenue: false,
  amount: "0",
  sourceCount: 1,
  ...overrides,
});

const plan = (groups: UnbilledSourceGroup[], accrued: Parameters<typeof planUnbilledAccrual>[0]["accrued"] = [], projectRevenue: string | null = PROJECT_REVENUE) =>
  planUnbilledAccrual({
    groups,
    accrued,
    rootSubsidiaryId: ROOT,
    functionalCurrencyOf: (id) => (id === ROOT ? "CAD" : id === OTHER ? "JPY" : null),
    minorUnitsOf: (currency) => ({ CAD: 2, JPY: 0 } as Record<string, number>)[currency] ?? null,
    projectRevenueAccountId: projectRevenue,
  });

test("groups unbilled work per project, entity, revenue account and currency, rounded to the currency and net of prior accruals", () => {
  const result = plan(
    [
      // Two items crediting the same income account merge into one key.
      group({ amount: "100.1250" }),
      group({ amount: "50.0000", itemName: "Travel" }),
      // No item income account: the project revenue control account.
      group({ amount: "10.0000", incomeAccountId: null }),
      // A fixed-account profile credits project revenue even when the item has income.
      group({ projectId: P2, projectName: "Job two", projectSubsidiaryId: OTHER, sourceCurrency: "JPY", amount: "1234.5000", usesProjectRevenue: true, incomeAccountId: null }),
    ],
    [
      { projectId: P1, subsidiaryId: ROOT, revenueAccountId: ITEM_INCOME, currency: "CAD", amount: "120.0000" },
      // Accrued earlier to an account that no longer carries unbilled work: cleared.
      { projectId: P1, subsidiaryId: ROOT, revenueAccountId: "00000000-0000-4000-8000-0000000000b9", currency: "CAD", amount: "40.0000" },
    ],
  );
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.lines.map((line) => [line.projectId, line.subsidiaryId, line.revenueAccountId, line.currency, line.unbilled, line.accrued, line.delta]),
    [
      [P1, ROOT, ITEM_INCOME, "CAD", "150.1300", "120.0000", "30.1300"],
      [P1, ROOT, PROJECT_REVENUE, "CAD", "10.0000", "0.0000", "10.0000"],
      [P1, ROOT, "00000000-0000-4000-8000-0000000000b9", "CAD", "0.0000", "40.0000", "-40.0000"],
      [P2, OTHER, PROJECT_REVENUE, "JPY", "1235.0000", "0.0000", "1235.0000"],
    ],
  );
});

test("refuses foreign-currency work and unmapped revenue with remedies instead of converting or defaulting", () => {
  const result = plan(
    [
      group({ amount: "80.0000", sourceCurrency: "USD" }),
      group({ projectId: P2, projectName: "Job two", amount: "20.0000", incomeAccountId: null, itemName: "Consulting" }),
    ],
    [],
    null,
  );
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.problems.map((problem) => [problem.code, problem.projectId]), [
    ["foreign_currency", P1],
    ["revenue_account_unmapped", P2],
  ]);
  assert.match(result.problems[0]!.message, /priced in USD, but its functional currency is CAD/);
  assert.match(result.problems[1]!.message, /Item Consulting on project Job two has no income account/);
});
