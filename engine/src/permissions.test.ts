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
