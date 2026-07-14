/**
 * openbooks permission catalogue + built-in roles + wildcard matching.
 *
 * Ported from the beaconhs IAM foundation (packages/db/src/schema/iam.ts and
 * packages/tenant). Keys are hierarchical `module.action[.qualifier]` strings;
 * a stored grant of `ap.*` covers any `ap.x` at check time, and a stored `*`
 * covers everything.
 *
 * This module is intentionally pure (no server/db imports) so it can be
 * shared by server authorization (web/lib/authz.ts), client permission-picker
 * UI, and the engine seed script (engine/src/seed-roles.ts).
 */

export type PermissionKey = string;

export const PERMISSION_CATALOGUE = [
  // General ledger
  "gl.read",
  "gl.post",
  "gl.close",
  // Accounts payable
  "ap.read",
  "ap.create",
  "ap.approve",
  "ap.post",
  "ap.pay",
  // Accounts receivable
  "ar.read",
  "ar.create",
  "ar.approve",
  "ar.post",
  "ar.pay",
  // Reports
  "reports.read",
  "reports.create",
  "reports.schedule",
  // Insights — native BI (cards, dashboards, library)
  "insights.read",
  "insights.create",
  "insights.publish",
  // SQL workbench — read-only ad hoc queries
  "sql.execute",
  // External-source sync/migration runs
  "sync.run",
  // User scripts (sandboxed automation)
  "scripts.manage",
  // Admin
  "admin.users.manage",
  "admin.roles.manage",
  "admin.nav.manage",
  "admin.audit.read",
] as const;

export type CataloguePermission = (typeof PERMISSION_CATALOGUE)[number];

/**
 * Catalogue grouped by module with human labels — drives the grouped-checkbox
 * permission picker in /admin/roles. Every catalogue key appears in exactly
 * one group (asserted by the picker rendering all groups).
 */
export const PERMISSION_GROUPS: {
  key: string;
  label: string;
  permissions: { key: CataloguePermission; label: string }[];
}[] = [
  {
    key: "gl",
    label: "General ledger",
    permissions: [
      { key: "gl.read", label: "View journals and balances" },
      { key: "gl.post", label: "Post journal entries" },
      { key: "gl.close", label: "Close accounting periods" },
    ],
  },
  {
    key: "ap",
    label: "Accounts payable",
    permissions: [
      { key: "ap.read", label: "View bills" },
      { key: "ap.create", label: "Create and submit bills" },
      { key: "ap.approve", label: "Approve or reject bills" },
      { key: "ap.post", label: "Post bills to the ledger" },
      { key: "ap.pay", label: "Pay bills" },
    ],
  },
  {
    key: "ar",
    label: "Accounts receivable",
    permissions: [
      { key: "ar.read", label: "View invoices" },
      { key: "ar.create", label: "Create and submit invoices" },
      { key: "ar.approve", label: "Approve or reject invoices" },
      { key: "ar.post", label: "Post invoices to the ledger" },
      { key: "ar.pay", label: "Record customer payments" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    permissions: [
      { key: "reports.read", label: "View reports" },
      { key: "reports.create", label: "Create and save reports" },
      { key: "reports.schedule", label: "Schedule report delivery" },
    ],
  },
  {
    key: "insights",
    label: "Insights",
    permissions: [
      { key: "insights.read", label: "View insights and the library" },
      { key: "insights.create", label: "Build cards and dashboards" },
      { key: "insights.publish", label: "Publish to the shared library" },
    ],
  },
  {
    key: "sql",
    label: "SQL workbench",
    permissions: [{ key: "sql.execute", label: "Run read-only SQL queries" }],
  },
  {
    key: "sync",
    label: "Sync",
    permissions: [{ key: "sync.run", label: "Run external-source syncs" }],
  },
  {
    key: "scripts",
    label: "Scripting",
    permissions: [{ key: "scripts.manage", label: "Manage user scripts" }],
  },
  {
    key: "admin",
    label: "Administration",
    permissions: [
      { key: "admin.users.manage", label: "Manage users and role assignments" },
      { key: "admin.roles.manage", label: "Manage roles and permissions" },
      { key: "admin.nav.manage", label: "Customize navigation" },
      { key: "admin.audit.read", label: "View the audit log" },
    ],
  },
];

/**
 * Built-in role definitions, seeded per org by engine/src/seed-roles.ts.
 * Keys intentionally equal the legacy users.role enum values so existing
 * users map 1:1 onto assignments — and so authz can fall back to users.role
 * through this table when a user has no assignments yet.
 */
export const BUILT_IN_ROLES: Record<
  string,
  { name: string; description: string; permissions: CataloguePermission[] }
> = {
  admin: {
    name: "Administrator",
    description: "Full access, including user, role, and navigation administration.",
    permissions: [...PERMISSION_CATALOGUE],
  },
  controller: {
    name: "Controller",
    description:
      "Owns the books. Full GL/AP/AR including approvals, posting, payment, and period close, plus reporting, insights, SQL, sync, and the audit log.",
    permissions: [
      "gl.read",
      "gl.post",
      "gl.close",
      "ap.read",
      "ap.create",
      "ap.approve",
      "ap.post",
      "ap.pay",
      "ar.read",
      "ar.create",
      "ar.approve",
      "ar.post",
      "ar.pay",
      "reports.read",
      "reports.create",
      "reports.schedule",
      "insights.read",
      "insights.create",
      "insights.publish",
      "sql.execute",
      "sync.run",
      "admin.audit.read",
    ],
  },
  accountant: {
    name: "Accountant",
    description:
      "Day-to-day bookkeeping: enters and posts journals, bills, and invoices, pays and receives, and builds reports. Cannot approve or close periods.",
    permissions: [
      "gl.read",
      "gl.post",
      "ap.read",
      "ap.create",
      "ap.post",
      "ap.pay",
      "ar.read",
      "ar.create",
      "ar.post",
      "ar.pay",
      "reports.read",
      "reports.create",
      "insights.read",
    ],
  },
  approver: {
    name: "Approver",
    description:
      "Reviews and decides approval requests for bills and invoices; read access to the ledger and reports.",
    permissions: [
      "gl.read",
      "ap.read",
      "ap.approve",
      "ar.read",
      "ar.approve",
      "reports.read",
      "insights.read",
    ],
  },
  viewer: {
    name: "Viewer",
    description: "Read-only access to the ledger, subledgers, reports, and insights.",
    permissions: ["gl.read", "ap.read", "ar.read", "reports.read", "insights.read"],
  },
};

export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLES);

/**
 * Wildcard-matching permission check, ported faithfully from beaconhs's
 * can() (packages/tenant): exact key, full wildcard `*`, or a `module.*`
 * grant whose prefix covers the requested key.
 */
export function permissionSetCovers(permissions: ReadonlySet<string>, perm: string): boolean {
  if (permissions.has("*")) return true;
  if (permissions.has(perm)) return true;
  // wildcard convention: 'ap.*' grants any 'ap.x'
  for (const p of permissions) {
    if (p.endsWith(".*") && perm.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Apply deny overrides to a granted-permission set — deny wins. Ported from
 * beaconhs's applyPermissionDenies: a specific deny under a wildcard grant
 * first expands that wildcard into its catalogue keys (so the sibling keys
 * survive), then every denied key — and everything under a wildcard deny —
 * is removed.
 */
export function applyPermissionDenies(permissions: Set<string>, denies: string[]): void {
  const specificDenies = denies.filter((deny) => !deny.endsWith(".*"));
  for (const grant of [...permissions]) {
    if (!grant.endsWith(".*")) continue;
    const prefix = grant.slice(0, -1);
    if (!specificDenies.some((deny) => deny.startsWith(prefix))) continue;
    permissions.delete(grant);
    for (const key of PERMISSION_CATALOGUE) if (key.startsWith(prefix)) permissions.add(key);
  }
  for (const denied of denies) {
    permissions.delete(denied);
    if (!denied.endsWith(".*")) continue;
    const prefix = denied.slice(0, -1);
    for (const grant of [...permissions]) if (grant.startsWith(prefix)) permissions.delete(grant);
  }
}

/**
 * Union assigned roles' permissions (falling back to the legacy users.role
 * mapped through BUILT_IN_ROLES when no assignments exist), add grant
 * overrides, then apply deny overrides — denies win.
 */
export function resolveEffectivePermissions(args: {
  rolePermissionSets: readonly (readonly string[])[];
  legacyRole: string | null;
  overrides: readonly { permission: string; effect: "grant" | "deny" }[];
}): Set<string> {
  const permissions = new Set<string>();
  if (args.rolePermissionSets.length > 0) {
    for (const set of args.rolePermissionSets) for (const p of set) permissions.add(p);
  } else if (args.legacyRole) {
    const builtIn = BUILT_IN_ROLES[args.legacyRole];
    if (builtIn) for (const p of builtIn.permissions) permissions.add(p);
  }
  for (const o of args.overrides) if (o.effect === "grant") permissions.add(o.permission);
  applyPermissionDenies(
    permissions,
    args.overrides.filter((o) => o.effect === "deny").map((o) => o.permission),
  );
  return permissions;
}

const CATALOGUE_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE);

/** True when `key` is a known catalogue permission (used to validate role edits). */
export function isCataloguePermission(key: string): key is CataloguePermission {
  return CATALOGUE_SET.has(key);
}
