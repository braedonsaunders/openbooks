import assert from "node:assert/strict";
import { test } from "node:test";
import { salesCommandSchema, salesTerritorySchema } from "./sales-schema";
const id = "00000000-0000-4000-8000-000000000001";
const quota = {
  action: "quota",
  name: "Annual sales",
  subsidiaryId: id,
  employeeId: id,
  salesTeamId: null,
  parentQuotaId: null,
  supersedesId: null,
  reason: "",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  currency: "CAD",
  amount: "1234.5678",
  metric: "closed_won",
};
test("quotas preserve exact decimals and reject ambiguous financial input with a readable remedy", () => {
  assert.equal(salesCommandSchema.safeParse(quota).success, true);
  for (const amount of ["1,234", "1e3", "$123", "1.23456"]) {
    const parsed = salesCommandSchema.safeParse({ ...quota, amount });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.match(parsed.error.message, /Quota amount/);
  }
});
test("quota target and calendar invariants refuse invalid declarations", () => {
  assert.equal(
    salesCommandSchema.safeParse({ ...quota, salesTeamId: id }).success,
    false,
  );
  assert.equal(
    salesCommandSchema.safeParse({ ...quota, employeeId: null }).success,
    false,
  );
  assert.equal(
    salesCommandSchema.safeParse({ ...quota, periodStart: "2026-02-30" })
      .success,
    false,
  );
  assert.equal(
    salesCommandSchema.safeParse({ ...quota, periodEnd: "2025-12-31" }).success,
    false,
  );
});
test("sales commands refuse login identities and undeclared writes", () => {
  assert.equal(
    salesCommandSchema.safeParse({ ...quota, ownerUserId: id }).success,
    false,
  );
  assert.equal(
    salesCommandSchema.safeParse({
      action: "team",
      name: "Team",
      subsidiaryId: id,
      managerEmployeeId: null,
      isActive: true,
      members: [{ userId: id, role: "member", validFrom: "2026-01-01" }],
    }).success,
    false,
  );
});
test("territory coverage constrains geographic coordinates and bounded administrative levels", () => {
  const territory = {
    action: "territory",
    name: "East",
    subsidiaryId: id,
    managerEmployeeId: null,
    defaultEmployeeId: null,
    salesTeamId: null,
    description: "",
    priority: 100,
    rules: [],
    matchMode: "all",
    geography: { version: 1, includes: [], excludes: [], polygons: [] },
    effectiveFrom: "2026-01-01",
    lifecycle: "draft",
  };
  assert.equal(salesTerritorySchema.safeParse(territory).success, true);
  assert.equal(
    salesTerritorySchema.safeParse({
      ...territory,
      geography: {
        ...territory.geography,
        polygons: [
          {
            id: "area",
            name: "Area",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [200, 0],
                  [1, 0],
                  [1, 1],
                  [200, 0],
                ],
              ],
            },
          },
        ],
      },
    }).success,
    false,
  );
});
