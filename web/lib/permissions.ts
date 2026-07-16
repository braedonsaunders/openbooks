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
  "gl.manage",
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
  // Items & services catalog
  "items.read",
  "items.manage",
  // Projects & job costing
  "projects.read",
  "projects.manage",
  // Fixed assets & depreciation
  "assets.read",
  "assets.manage",
  // Time tracking & timesheets
  "time.read",
  "time.manage",
  "time.approve",
  // Custom records — user-defined record types + their generated modules
  "records.read",
  "records.create",
  "records.manage_types",
  // AI assistant — use is table stakes; write lets it DRAFT records (which the
  // tool-level gates further restrict, e.g. gl.post for journal drafts)
  "assistant.use",
  "assistant.write",
  // SQL workbench — read-only ad hoc queries
  "sql.execute",
  // External-source sync/migration runs
  "sync.run",
  // Bulk import / export (data-io) — generic across resources; each resource's
  // own permission is still enforced per-row (e.g. importing accounts also
  // needs admin.setup.manage).
  "data.export",
  "data.import",
  // User scripts (sandboxed automation): manage = author/edit; execute = call
  // endpoint scripts (the RESTlet-style HTTP-invokable kind)
  "scripts.manage",
  "scripts.execute",
  // Flows — visual approval/automation graphs (docs/flows-design.md).
  // manage = author/enable flows; approve = act on flow approval gates
  // (assignees can always act on their OWN gates regardless of this key).
  "flows.manage",
  "flows.approve",
  // Apps — installable packages (sandboxed frontend + governed backend).
  // `apps.use` runs an installed App; `apps.manage` installs/upgrades/removes.
  "apps.use",
  "apps.manage",
  // File Cabinet — document management (browse, upload, move, rename, version)
  "documents.read",
  "documents.manage",
  // Admin
  "parties.read",
  "parties.manage",
  "banking.read",
  "banking.reconcile",
  "expenses.create",
  "expenses.read",
  "admin.custom_fields.manage",
  "admin.users.manage",
  "admin.roles.manage",
  "admin.nav.manage",
  "admin.customization.manage",
  "admin.setup.manage",
  "admin.audit.read",
  "admin.ai.manage",
  "admin.sandboxes.manage",
  "api.keys.manage",
] as const;

export type CataloguePermission = (typeof PERMISSION_CATALOGUE)[number];

/**
 * Catalogue grouped by module — drives the grouped-checkbox permission picker
 * in /admin/roles. Every catalogue key appears in exactly one group (asserted
 * by the picker rendering all groups).
 *
 * Labels are next-intl message keys (relative to the `admin` namespace,
 * catalogued in web/messages/<locale>/admin.json under `permissions`), since
 * this module is pure and cannot call translation hooks. The render site
 * translates: `t(perm.labelKey)`. A permission key `x.y.z` maps to the
 * message key `permissions.x_y_z`.
 */
export function permissionLabelKey(key: CataloguePermission): string {
  return `permissions.${key.replace(/\./g, "_")}`;
}

export const PERMISSION_GROUPS: {
  key: string;
  labelKey: string;
  permissions: { key: CataloguePermission; labelKey: string }[];
}[] = [
  {
    key: "gl",
    labelKey: "permissions.groups.gl",
    permissions: [
      { key: "gl.read", labelKey: permissionLabelKey("gl.read") },
      { key: "gl.manage", labelKey: permissionLabelKey("gl.manage") },
      { key: "gl.post", labelKey: permissionLabelKey("gl.post") },
      { key: "gl.close", labelKey: permissionLabelKey("gl.close") },
    ],
  },
  {
    key: "ap",
    labelKey: "permissions.groups.ap",
    permissions: [
      { key: "ap.read", labelKey: permissionLabelKey("ap.read") },
      { key: "ap.create", labelKey: permissionLabelKey("ap.create") },
      { key: "ap.approve", labelKey: permissionLabelKey("ap.approve") },
      { key: "ap.post", labelKey: permissionLabelKey("ap.post") },
      { key: "ap.pay", labelKey: permissionLabelKey("ap.pay") },
    ],
  },
  {
    key: "ar",
    labelKey: "permissions.groups.ar",
    permissions: [
      { key: "ar.read", labelKey: permissionLabelKey("ar.read") },
      { key: "ar.create", labelKey: permissionLabelKey("ar.create") },
      { key: "ar.approve", labelKey: permissionLabelKey("ar.approve") },
      { key: "ar.post", labelKey: permissionLabelKey("ar.post") },
      { key: "ar.pay", labelKey: permissionLabelKey("ar.pay") },
    ],
  },
  {
    key: "reports",
    labelKey: "permissions.groups.reports",
    permissions: [
      { key: "reports.read", labelKey: permissionLabelKey("reports.read") },
      { key: "reports.create", labelKey: permissionLabelKey("reports.create") },
      { key: "reports.schedule", labelKey: permissionLabelKey("reports.schedule") },
    ],
  },
  {
    key: "insights",
    labelKey: "permissions.groups.insights",
    permissions: [
      { key: "insights.read", labelKey: permissionLabelKey("insights.read") },
      { key: "insights.create", labelKey: permissionLabelKey("insights.create") },
      { key: "insights.publish", labelKey: permissionLabelKey("insights.publish") },
    ],
  },
  {
    key: "items",
    labelKey: "permissions.groups.items",
    permissions: [
      { key: "items.read", labelKey: permissionLabelKey("items.read") },
      { key: "items.manage", labelKey: permissionLabelKey("items.manage") },
    ],
  },
  {
    key: "projects",
    labelKey: "permissions.groups.projects",
    permissions: [
      { key: "projects.read", labelKey: permissionLabelKey("projects.read") },
      { key: "projects.manage", labelKey: permissionLabelKey("projects.manage") },
    ],
  },
  {
    key: "assets",
    labelKey: "permissions.groups.assets",
    permissions: [
      { key: "assets.read", labelKey: permissionLabelKey("assets.read") },
      { key: "assets.manage", labelKey: permissionLabelKey("assets.manage") },
    ],
  },
  {
    key: "time",
    labelKey: "permissions.groups.time",
    permissions: [
      { key: "time.read", labelKey: permissionLabelKey("time.read") },
      { key: "time.manage", labelKey: permissionLabelKey("time.manage") },
      { key: "time.approve", labelKey: permissionLabelKey("time.approve") },
    ],
  },
  {
    key: "records",
    labelKey: "permissions.groups.records",
    permissions: [
      { key: "records.read", labelKey: permissionLabelKey("records.read") },
      { key: "records.create", labelKey: permissionLabelKey("records.create") },
      { key: "records.manage_types", labelKey: permissionLabelKey("records.manage_types") },
    ],
  },
  {
    key: "assistant",
    labelKey: "permissions.groups.assistant",
    permissions: [
      { key: "assistant.use", labelKey: permissionLabelKey("assistant.use") },
      { key: "assistant.write", labelKey: permissionLabelKey("assistant.write") },
    ],
  },
  {
    key: "sql",
    labelKey: "permissions.groups.sql",
    permissions: [{ key: "sql.execute", labelKey: permissionLabelKey("sql.execute") }],
  },
  {
    key: "sync",
    labelKey: "permissions.groups.sync",
    permissions: [{ key: "sync.run", labelKey: permissionLabelKey("sync.run") }],
  },
  {
    key: "data",
    labelKey: "permissions.groups.data",
    permissions: [
      { key: "data.export", labelKey: permissionLabelKey("data.export") },
      { key: "data.import", labelKey: permissionLabelKey("data.import") },
    ],
  },
  {
    key: "scripts",
    labelKey: "permissions.groups.scripts",
    permissions: [
      { key: "scripts.manage", labelKey: permissionLabelKey("scripts.manage") },
      { key: "scripts.execute", labelKey: permissionLabelKey("scripts.execute") },
    ],
  },
  {
    key: "flows",
    labelKey: "permissions.groups.flows",
    permissions: [
      { key: "flows.manage", labelKey: permissionLabelKey("flows.manage") },
      { key: "flows.approve", labelKey: permissionLabelKey("flows.approve") },
    ],
  },
  {
    key: "apps",
    labelKey: "permissions.groups.apps",
    permissions: [
      { key: "apps.use", labelKey: permissionLabelKey("apps.use") },
      { key: "apps.manage", labelKey: permissionLabelKey("apps.manage") },
    ],
  },
  {
    key: "documents",
    labelKey: "permissions.groups.documents",
    permissions: [
      { key: "documents.read", labelKey: permissionLabelKey("documents.read") },
      { key: "documents.manage", labelKey: permissionLabelKey("documents.manage") },
    ],
  },
  {
    key: "admin",
    labelKey: "permissions.groups.admin",
    permissions: [
      { key: "parties.read", labelKey: permissionLabelKey("parties.read") },
      { key: "parties.manage", labelKey: permissionLabelKey("parties.manage") },
      { key: "banking.read", labelKey: permissionLabelKey("banking.read") },
      { key: "banking.reconcile", labelKey: permissionLabelKey("banking.reconcile") },
      { key: "expenses.read", labelKey: permissionLabelKey("expenses.read") },
      { key: "expenses.create", labelKey: permissionLabelKey("expenses.create") },
      { key: "admin.custom_fields.manage", labelKey: permissionLabelKey("admin.custom_fields.manage") },
      { key: "admin.users.manage", labelKey: permissionLabelKey("admin.users.manage") },
      { key: "admin.roles.manage", labelKey: permissionLabelKey("admin.roles.manage") },
      { key: "admin.nav.manage", labelKey: permissionLabelKey("admin.nav.manage") },
      { key: "admin.customization.manage", labelKey: permissionLabelKey("admin.customization.manage") },
      { key: "admin.setup.manage", labelKey: permissionLabelKey("admin.setup.manage") },
      { key: "admin.audit.read", labelKey: permissionLabelKey("admin.audit.read") },
      { key: "admin.ai.manage", labelKey: permissionLabelKey("admin.ai.manage") },
      { key: "admin.sandboxes.manage", labelKey: permissionLabelKey("admin.sandboxes.manage") },
      { key: "api.keys.manage", labelKey: permissionLabelKey("api.keys.manage") },
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
      "gl.manage",
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
      "records.read",
      "records.create",
      "records.manage_types",
      "items.read",
      "items.manage",
      "projects.read",
      "projects.manage",
      "assets.read",
      "assets.manage",
      "time.read",
      "time.manage",
      "time.approve",
      "assistant.use",
      "assistant.write",
      "sql.execute",
      "sync.run",
      "parties.read",
      "parties.manage",
      "banking.read",
      "banking.reconcile",
      "expenses.read",
      "expenses.create",
      "documents.read",
      "documents.manage",
      "data.export",
      "data.import",
      "admin.customization.manage",
      "admin.setup.manage",
      "admin.audit.read",
      "apps.use",
      "apps.manage",
      "scripts.execute",
      "flows.manage",
      "flows.approve",
    ],
  },
  accountant: {
    name: "Accountant",
    description:
      "Day-to-day bookkeeping: enters and posts journals, bills, and invoices, pays and receives, and builds reports. Cannot approve or close periods.",
    permissions: [
      "gl.read",
      "gl.manage",
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
      "records.read",
      "records.create",
      "items.read",
      "items.manage",
      "projects.read",
      "projects.manage",
      "assets.read",
      "assets.manage",
      "time.read",
      "time.manage",
      "assistant.use",
      "assistant.write",
      "documents.read",
      "documents.manage",
      "data.export",
      "data.import",
      "apps.use",
      "scripts.execute",
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
      "flows.approve",
      "reports.read",
      "insights.read",
      "records.read",
      "time.read",
      "time.approve",
      "assistant.use",
      "documents.read",
      "data.export",
      "apps.use",
    ],
  },
  viewer: {
    name: "Viewer",
    description: "Read-only access to the ledger, subledgers, reports, and insights.",
    permissions: ["gl.read", "ap.read", "ar.read", "reports.read", "insights.read", "records.read", "items.read", "assets.read", "time.read", "assistant.use", "documents.read", "data.export", "apps.use"],
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
