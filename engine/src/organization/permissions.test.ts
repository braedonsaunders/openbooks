import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_KEYS,
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  permissionLabelKey,
  permissionSetCovers,
  purchaseOrderConversionPermission,
  resolveKeyScopeAuthority,
  type CataloguePermission,
} from "./permissions.ts";

test("stored value permissions are catalogued, grouped, and split by duty", () => {
  const keys: CataloguePermission[] = ["stored_value.read", "stored_value.manage", "stored_value.adjust"];
  for (const perm of keys) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "stored_value");
  assert.ok(group, "stored value needs its own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.stored_value");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("controller", perm), true, `controller must hold ${perm}`);
    assert.equal(holds("admin", perm), true, `admin must hold ${perm}`);
  }
  assert.equal(holds("accountant", "stored_value.read"), true);
  assert.equal(holds("accountant", "stored_value.manage"), true);
  assert.equal(holds("accountant", "stored_value.adjust"), false, "adjusting balances outside documents is not an accounting duty");
  assert.equal(holds("sales_manager", "stored_value.manage"), true, "sales managers sell and redeem gift cards");
  assert.equal(holds("sales_manager", "stored_value.adjust"), false);
  assert.equal(holds("sales_rep", "stored_value.read"), true);
  assert.equal(holds("sales_rep", "stored_value.manage"), false);
});

test("usage permissions are catalogued and granted wherever invoice creation is allowed", () => {
  const keys: CataloguePermission[] = ["usage.read", "usage.manage", "usage.bill"];
  for (const permission of keys) {
    assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes(permission));
    assert.equal(permissionLabelKey(permission), `permissions.${permission.replace(/\./g, "_")}`);
  }
  assert.deepEqual(
    PERMISSION_GROUPS.find((entry) => entry.key === "usage")?.permissions.map((entry) => entry.key),
    keys,
  );
  const holds = (role: string, permission: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), permission);
  for (const role of BUILT_IN_ROLE_KEYS) {
    if (holds(role, "ar.create")) {
      assert.equal(holds(role, "usage.manage"), true, `${role} must manage usage with invoice creation`);
      assert.equal(holds(role, "usage.bill"), true, `${role} must bill usage with invoice creation`);
    } else {
      assert.equal(holds(role, "usage.manage"), false, `${role} must not manage usage`);
      assert.equal(holds(role, "usage.bill"), false, `${role} must not bill usage`);
    }
  }
});

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
 * Automatic collection duty split: reading a stored method shows only brand,
 * last four and expiry, so every built-in role may see it; charging, retries
 * and suspension move money and stay with finance (controller, accountant).
 */
test("autopay permissions are catalogued, grouped, and granted by duty", () => {
  const keys: CataloguePermission[] = ["payment_methods.read", "payment_methods.manage", "autopay.manage"];
  for (const perm of keys) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "autopay");
  assert.ok(group, "autopay needs its own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.autopay");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("controller", perm), true, `controller must hold ${perm}`);
    assert.equal(holds("accountant", perm), true, `accountant must hold ${perm}`);
    assert.equal(holds("admin", perm), true, `admin must hold ${perm}`);
  }
  assert.equal(holds("approver", "payment_methods.read"), true);
  assert.equal(holds("approver", "payment_methods.manage"), false, "approver must not move stored methods");
  assert.equal(holds("approver", "autopay.manage"), false, "approver must not run collection");
  assert.equal(holds("viewer", "payment_methods.read"), true);
  assert.equal(holds("viewer", "autopay.manage"), false);
  for (const role of ["sales_manager", "sales_rep"]) {
    assert.equal(holds(role, "payment_methods.read"), true, `${role} must see the method on file for support`);
    assert.equal(holds(role, "payment_methods.manage"), false, `${role} must not move stored methods`);
    assert.equal(holds(role, "autopay.manage"), false, `${role} must not run collection`);
  }
  assert.equal(holds("production", "payment_methods.read"), false, "production stays out of collections");
});

/**
 * Capitalized contract costs (ASC 340-40): read sees policies, assets and
 * amortization; manage capitalizes, links and runs amortization; approve
 * recognizes impairment and changes policy. The controller owns the module
 * including approval, the accountant does day-to-day work without approval
 * power, the approver reviews (read + approve), and the viewer only reads.
 */
test("contract cost permissions are catalogued, grouped, and granted by duty", () => {
  const keys: CataloguePermission[] = ["contract_costs.read", "contract_costs.manage", "contract_costs.approve"];
  for (const perm of keys) {
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(perm),
      `${perm} must be seeded so someone can hold it`,
    );
    assert.equal(permissionLabelKey(perm), `permissions.${perm.replace(/\./g, "_")}`);
  }
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "contract-costs");
  assert.ok(group, "contract costs need their own catalogue group for the role picker");
  assert.equal(group.labelKey, "permissions.groups.contract-costs");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("controller", perm), true, `controller must hold ${perm}`);
  }
  for (const perm of ["contract_costs.read", "contract_costs.manage"]) {
    assert.equal(holds("accountant", perm), true, `accountant must hold ${perm}`);
  }
  assert.equal(holds("accountant", "contract_costs.approve"), false, "accountant must not approve impairment");
  assert.equal(holds("approver", "contract_costs.read"), true);
  assert.equal(holds("approver", "contract_costs.approve"), true);
  assert.equal(holds("approver", "contract_costs.manage"), false, "approver must not capitalize costs");
  assert.equal(holds("viewer", "contract_costs.read"), true);
  assert.equal(holds("viewer", "contract_costs.manage"), false);
  for (const role of ["sales_manager", "sales_rep"]) {
    assert.equal(holds(role, "contract_costs.read"), false, `${role} must not see capitalized costs`);
    assert.equal(holds(role, "contract_costs.manage"), false, `${role} must not capitalize costs`);
  }
  assert.equal(holds("admin", "contract_costs.approve"), true);
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
  // Employer-scoped HR records and operational evidence stay admin-only by default.
  const keys: CataloguePermission[] = [
    "hrm.org_chart.read",
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
    "hrm.compensation.read",
    "hrm.compensation.manage",
    "hrm.compensation.approve",
    "hrm.team.read",
    "hrm.team.manage",
    "hrm.construction.read",
    "hrm.construction.manage",
    "hrm.certifications.read",
    "hrm.certifications.manage",
    "hrm.shifts.read",
    "hrm.shifts.manage",
    "hrm.shifts.approve",
    "hrm.attendance.read",
    "hrm.attendance.manage",
    "hrm.documents.read",
    "hrm.documents.manage",
    "hrm.surveys.manage",
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
    ...keys.slice(0, 19),
    ...selfKeys,
    ...keys.slice(19),
  ]);

  const holds = (role: string, perm: string) =>
    permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const perm of keys) {
    assert.equal(holds("admin", perm), true, `admin must hold ${perm}`);
  }
  // Filing leave is scoped by the service to the employment behind the
  // login, so it is self-service like the hrm.self keys: every role files
  // its own leave; nobody else's.
  const everyRoleKeys: CataloguePermission[] = [...selfKeys, "hrm.leave.request"];
  for (const perm of everyRoleKeys) {
    for (const role of BUILT_IN_ROLE_KEYS) {
      assert.equal(holds(role, perm), true, `${role} must hold ${perm}: every login is a person`);
    }
  }
  const adminOnly = keys.filter((perm) => !everyRoleKeys.includes(perm));
  for (const role of BUILT_IN_ROLE_KEYS.filter((key) => key !== "admin")) {
    for (const perm of adminOnly) {
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

test("purchasing has its own grants, kept apart from the payables book", () => {
  const keys: CataloguePermission[] = ["purchase_orders.read", "purchase_orders.create", "goods_receipts.create"];
  const group = PERMISSION_GROUPS.find((entry) => entry.key === "purchasing");
  assert.ok(group, "purchasing needs its own group in the role picker");
  assert.deepEqual(group.permissions.map((entry) => entry.key), keys);
  assert.equal(purchaseOrderConversionPermission("purchase_receipt"), "goods_receipts.create");
  assert.equal(purchaseOrderConversionPermission("vendor_bill"), "ap.create", "billing an order creates a payables document");
  const holds = (role: string, perm: string) => permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  // Roles that could read or author purchase orders through ap.* keep that access.
  for (const role of BUILT_IN_ROLE_KEYS) {
    if (holds(role, "ap.read")) assert.equal(holds(role, "purchase_orders.read"), true, `${role} keeps reading purchase orders`);
    if (holds(role, "ap.create")) {
      assert.equal(holds(role, "purchase_orders.create"), true, `${role} keeps authoring purchase orders`);
      assert.equal(holds(role, "goods_receipts.create"), true, `${role} keeps receiving goods`);
    }
  }
  assert.equal(holds("buyer", "purchase_orders.create"), true);
  assert.equal(holds("buyer", "goods_receipts.create"), true);
  for (const denied of ["ap.create", "ap.post", "ap.pay", "banking.read", "gl.read", "items.post"]) {
    assert.equal(holds("buyer", denied), false, `a buyer holds no ${denied}`);
  }
});

test("people, banking and expense grants are filed under their own groups, not Administration", () => {
  const groupOf = (key: string) => PERMISSION_GROUPS.find((group) => group.permissions.some((entry) => entry.key === key))?.key;
  assert.equal(groupOf("parties.read"), "parties");
  assert.equal(groupOf("banking.read"), "banking");
  assert.equal(groupOf("expenses.read"), "expenses");
  const listed = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((entry) => entry.key));
  assert.deepEqual([...listed].sort(), [...PERMISSION_CATALOGUE].sort(), "every catalogue key appears in exactly one group");
});

test("every built-in role says what it can and cannot do", () => {
  for (const [key, role] of Object.entries(BUILT_IN_ROLES)) {
    if (key === "admin") continue;
    assert.match(role.description, /Cannot /, `${key} names what it cannot do`);
  }
});

test("the cashier and project coordinator roles carry no bank, ledger or payment authority", () => {
  const holds = (role: string, perm: string) => permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  for (const role of ["cashier", "project_coordinator"]) {
    for (const denied of ["banking.read", "gl.read", "ap.pay", "ar.pay", "ar.post"]) {
      assert.equal(holds(role, denied), false, `${role} holds no ${denied}`);
    }
  }
  assert.equal(holds("cashier", "cash_sales.create"), true);
  assert.equal(holds("project_coordinator", "time.self"), true, "logs their own time");
  assert.equal(holds("project_coordinator", "time.manage"), false, "never enters a coworker's time");
  assert.equal(holds("project_coordinator", "time.read"), false, "never reads a coworker's time");
  assert.equal(holds("project_coordinator", "projects.read"), true);
  assert.equal(holds("project_coordinator", "ar.create"), true, "drafts customer invoices");
});

test("hourly roles enter their own time through time.self, never the supervisory time grants", () => {
  const holds = (role: string, perm: string) => permissionSetCovers(new Set(BUILT_IN_ROLES[role]!.permissions), perm);
  assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes("time.self"));
  for (const role of ["production", "sales_manager", "sales_rep", "buyer", "cashier", "project_coordinator"]) {
    assert.equal(holds(role, "time.self"), true, `${role} enters its own time`);
    assert.equal(holds(role, "time.manage"), false, `${role} does not enter coworkers' time`);
  }
  for (const role of ["controller", "accountant"]) {
    assert.equal(holds(role, "time.manage"), true, `${role} keeps supervisory time entry`);
  }
});

