import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_KEYS,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  permissionLabelKey,
  permissionSetCovers,
  resolveKeyScopeAuthority,
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
 * employment read/manage keys (admin only, via the catalogue spread). The
 * 0196 performance and retention keys ride it too: reviews assess named
 * people, so performance read/manage and retention read stay admin-only
 * like the employment keys.
 * The HR-5 leave keys ride it too.
 * HR-9 splits the grant: the employment/position/process/leave/team keys
 * stay admin-only, while hrm.self.read and hrm.self.request ride on EVERY
 * built-in role — the structural scope (party behind the login, or a
 * named NO_LINK refusal) already makes them safe, and per-person grants
 * would gate a person's own record behind admin busywork.
 */
test("hrm permissions are catalogued, grouped, and split between admin-only and every-role self keys", () => {
  const keys: CataloguePermission[] = [
    "hrm.employment.read",
    "hrm.employment.manage",
    "hrm.employment.approve",
    "hrm.position.read",
    "hrm.position.manage",
    "hrm.process.read",
    "hrm.process.manage",
    "hrm.leave.read",
    "hrm.leave.request",
    "hrm.leave.approve",
    "hrm.leave.manage",
    "hrm.recruiting.read",
    "hrm.recruiting.manage",
    "hrm.performance.read",
    "hrm.performance.manage",
    "hrm.retention.read",
    "hrm.benefits.read",
    "hrm.benefits.manage",
    // HR-12 begin
    "hrm.compensation.read",
    "hrm.compensation.manage",
    "hrm.compensation.approve",
    // HR-12 end
    "hrm.team.read",
    "hrm.team.manage",
    // HR-13 begin: construction read/manage stay admin-only like the
    // employment keys — appended after the team keys so the pinned group
    // order below holds.
    "hrm.construction.read",
    "hrm.construction.manage",
    // HR-13 end
    // HR-14 begin: certifications read/manage stay admin-only like the
    // employment keys — appended after construction so the pinned group
    // order below holds.
    "hrm.certifications.read",
    "hrm.certifications.manage",
    // HR-14 end
    // HR-19 begin: documents read/manage and surveys manage stay
    // admin-only like the employment keys — appended after the
    // construction keys so the pinned group order below holds.
    "hrm.documents.read",
    "hrm.documents.manage",
    "hrm.surveys.manage",
    // HR-19 end
  ];
  // HR-9 self keys: every login is a person, so every built-in role
  // carries them (admin via the catalogue spread, the rest explicitly).
  // Structural scope — never a role grant — is what makes them safe.
  const selfKeys: CataloguePermission[] = ["hrm.self.read", "hrm.self.request"];
  for (const perm of [...keys, ...selfKeys]) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "hrm");
  assert.ok(group, "hrm needs its own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.hrm");
  assert.deepEqual(group.permissions.map((entry) => entry.key), [
    ...keys.slice(0, 18),
    ...selfKeys,
    ...keys.slice(18),
  ]);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("admin", perm), true, `admin must hold ${perm}`);
  }
  for (const perm of selfKeys) {
    for (const role of BUILT_IN_ROLE_KEYS) {
      assert.equal(holds(role, perm), true, `${role} must hold ${perm}: every login is a person`);
    }
  }
  for (const role of ["controller", "accountant", "approver", "viewer", "sales_manager", "sales_rep"]) {
    for (const perm of keys) {
      assert.equal(holds(role, perm), false, `${role} must not hold ${perm}`);
    }
  }
});

/**
 * Canonical key-scope authority (F21): the owner's expanded catalogue
 * permissions intersected with the key's exact catalogue scopes — the same
 * intersection use-time auth and the api-keys grant ceilings share.
 */
test("resolveKeyScopeAuthority intersects owner permissions with exact key scopes", () => {
  // A wildcard-holding owner confers only the named scopes.
  assert.deepEqual(
    [...resolveKeyScopeAuthority(new Set(["ar.*", "payroll.read"]), ["ar.read", "payroll.read"])!],
    ["ar.read", "payroll.read"],
  );
  // Scopes the owner cannot use are inert, not inherited.
  assert.deepEqual(
    [...resolveKeyScopeAuthority(new Set(["ar.read"]), ["ar.read", "payroll.read"])!],
    ["ar.read"],
  );
  // An invalid scope DECLARATION (malformed, empty, fully non-catalogue)
  // resolves to null — no credential.
  for (const scopes of [undefined, null, "ar.read", [], ["*"], ["not.a.permission"], ["*", "nope"]]) {
    assert.equal(resolveKeyScopeAuthority(new Set(["*"]), scopes), null, `scopes ${JSON.stringify(scopes)} must resolve to null`);
  }
  // A VALID declaration the owner cannot use resolves to an empty set — a
  // credential conferring nothing — never null.
  const inert = resolveKeyScopeAuthority(new Set(["ar.read"]), ["payroll.read"]);
  assert.ok(inert instanceof Set, "valid-but-inert scopes must resolve to a set");
  assert.deepEqual([...inert], []);
  const nothingHeld = resolveKeyScopeAuthority(new Set(), ["ar.read"]);
  assert.ok(nothingHeld instanceof Set, "an owner holding nothing still yields a set for valid scopes");
  assert.deepEqual([...nothingHeld], []);
});
