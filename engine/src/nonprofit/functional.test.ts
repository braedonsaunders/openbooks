import assert from "node:assert/strict";
import test from "node:test";
import { resolveFunctionalAssignment, splitSharedCost, type FunctionalMapping } from "./functional.ts";

const disclosure = {
  allocationRuleKey: "shared_occupancy",
  allocationRuleName: "Shared occupancy by square footage",
  driverKey: "occupied_area",
  driverName: "Occupied area",
  driverUnit: "square feet",
  asOf: "2026-09-27",
};

test("shared costs split exactly under disclosed functional drivers", () => {
  const cases = [
    { total: "101.00", weights: ["50", "30", "20"], expected: ["50.5000", "30.3000", "20.2000"] },
    { total: "0.01", weights: ["1", "1", "1"], expected: ["0.0034", "0.0033", "0.0033"] },
    { total: "-12.00", weights: ["1", "3"], expected: ["-3.0000", "-9.0000"] },
  ];
  for (const row of cases) {
    const categories = ["program", "management_general", "fundraising"] as const;
    const result = splitSharedCost({
      ...disclosure,
      total: row.total,
      targets: row.weights.map((weight, index) => ({
        key: `target-${index}`,
        functionKey: categories[index] ?? "program",
        weight,
      })),
    });
    assert.deepEqual(result.targets.map((target) => target.amount), row.expected);
    const units = (amount: string) => {
      const [whole = "0", fraction = ""] = amount.split(".");
      return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
    };
    assert.equal(result.targets.reduce((sum, target) => sum + units(target.amount), 0n), units(row.total));
    assert.equal(result.disclosure.driverUnit, "square feet");
  }
});

test("functional assignment is effective-dated and refuses unmapped expense lines by name", () => {
  const mapping: FunctionalMapping = {
    id: "mapping-1",
    orgId: "org-1",
    departmentId: "dept-1",
    projectId: null,
    functionKey: "program",
    programKey: "food_access",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-06-30",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "user-1",
  };
  assert.deepEqual(resolveFunctionalAssignment({
    accountName: "6100 Program supplies", departmentId: "dept-1", projectId: null, postingDate: "2026-06-30",
  }, [mapping]), { functionKey: "program", programKey: "food_access" });
  assert.throws(() => resolveFunctionalAssignment({
    accountName: "6200 Rent", departmentId: "dept-missing", projectId: null, postingDate: "2026-06-30",
  }, [mapping]), (error: unknown) => error instanceof Error && error.message.includes("6200 Rent"));
});
