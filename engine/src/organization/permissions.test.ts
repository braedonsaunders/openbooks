import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_ROLES,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  permissionLabelKey,
  permissionSetCovers,
  type CataloguePermission,
} from "./permissions.ts";

/**
 * Allocation kernel duty split (A10 platform slice): read sees rules, runs,
 * and lineage; manage authors rules and drivers; run previews, posts,
 * reverses, and re-runs (posting additionally requires gl.post, enforced by
 * the period-run service); approve acts on approval gates. By analogy with
 * budgets.* / close.*: the controller owns the module including approval,
 * the accountant runs day-to-day work without approval power, the approver
 * reviews (read + approve), and the viewer only reads.
 */
test("allocation permissions are catalogued, grouped, and granted by duty", () => {
  const keys: CataloguePermission[] = ["allocations.read", "allocations.manage", "allocations.run", "allocations.approve"];
  for (const perm of keys) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "allocations");
  assert.ok(group, "allocations needs its own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.allocations");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  // Controller owns the module; accountant runs without approving.
  for (const perm of keys) {
    assert.equal(holds("controller", perm), true, `controller must hold ${perm}`);
  }
  for (const perm of ["allocations.read", "allocations.manage", "allocations.run"]) {
    assert.equal(holds("accountant", perm), true, `accountant must hold ${perm}`);
  }
  assert.equal(holds("accountant", "allocations.approve"), false, "accountant must not approve runs");
  // Approver reviews: read plus approve, never manage or run.
  assert.equal(holds("approver", "allocations.read"), true);
  assert.equal(holds("approver", "allocations.approve"), true);
  assert.equal(holds("approver", "allocations.manage"), false, "approver must not author rules");
  assert.equal(holds("approver", "allocations.run"), false, "approver must not run allocations");
  // Viewer reads; sales roles stay out of the ledger module.
  assert.equal(holds("viewer", "allocations.read"), true);
  assert.equal(holds("viewer", "allocations.manage"), false);
  for (const role of ["sales_manager", "sales_rep"]) {
    assert.equal(holds(role, "allocations.read"), false, `${role} must not see allocations`);
    assert.equal(holds(role, "allocations.run"), false, `${role} must not run allocations`);
  }
  // Admin holds the catalogue spread, so new keys ride along automatically.
  assert.equal(holds("admin", "allocations.approve"), true);
});

/**
 * HRM employment foundation slice plus the headcount-plan slice: read sees
 * records, manage authors changes, approve decides them (self-approval
 * refused in engine/src/hrm/authorization.ts); position read sees the
 * establishment and vacancy, position manage writes it. Confidential like
 * payroll — no duty outside admin holds these.
 * HRM employment foundation slice: read sees records, manage authors
 * changes, approve decides them (self-approval refused in
 * engine/src/hrm/authorization.ts). Confidential like payroll — no duty
 * outside admin holds these. The 0193 process keys ride the same rule:
 * process read/manage are granted to exactly the roles holding the
 * employment read/manage keys (admin only, via the catalogue spread).
 */
test("hrm employment permissions are catalogued, grouped, and held by admin only", () => {
  const keys: CataloguePermission[] = [
    "hrm.employment.read",
    "hrm.employment.manage",
    "hrm.employment.approve",
    "hrm.position.read",
    "hrm.position.manage",
    "hrm.process.read",
    "hrm.process.manage",
  ];
  for (const perm of keys) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "hrm");
  assert.ok(group, "hrm needs its own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.hrm");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("admin", perm), true, `admin must hold ${perm}`);
  }
  for (const role of ["controller", "accountant", "approver", "viewer", "sales_manager", "sales_rep"]) {
    for (const perm of keys) {
      assert.equal(holds(role, perm), false, `${role} must not hold ${perm}`);
    }
  }
});
