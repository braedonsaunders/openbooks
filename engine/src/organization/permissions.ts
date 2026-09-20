/**
 * openbooks permission catalogue + built-in roles + wildcard matching.
 *
 * Keys are hierarchical `module.action[.qualifier]` strings;
 * a stored grant of `ap.*` covers any `ap.x` at check time, and a stored `*`
 * covers everything.
 *
 * This module is intentionally pure (no server/db imports) so it can be
 * shared by server authorization (web/lib/authz.ts), client permission-picker
 * UI, and the engine seed script (engine/src/provisioning/seed-roles.ts).
 * Lives in the engine so seed/runtime do not import web/lib.
 */

export type PermissionKey = string;

export const PERMISSION_CATALOGUE = [
  // General ledger
  "gl.read",
  "gl.manage",
  "gl.post",
  // Period configuration and close operations are independent duties.
  "periods.manage",
  "close.read",
  "close.run",
  "close.approve",
  "close.reopen",
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
  // Customer relationship management
  "crm.accounts.read",
  "crm.accounts.create",
  "crm.accounts.manage",
  "crm.accounts.assign",
  "crm.activities.read",
  "crm.activities.manage",
  "crm.opportunities.read",
  "crm.opportunities.manage",
  "crm.opportunities.close",
  "crm.forecasts.read",
  "crm.forecasts.manage",
  "crm.forecasts.override",
  "crm.setup.manage",
  // Reports
  "reports.read",
  "reports.create",
  "reports.schedule",
  // Budget and forecast authoring is distinct from report construction.
  "budgets.read",
  "budgets.manage",
  "budgets.approve",
  // Allocation kernel: read sees rules, runs, and lineage; manage authors
  // rules and drivers; run previews, posts, reverses, and re-runs (posting
  // additionally requires gl.post); approve acts on approval gates.
  "allocations.read",
  "allocations.manage",
  "allocations.run",
  "allocations.approve",
  // Insights — native BI (cards, dashboards, library)
  "insights.read",
  "insights.create",
  "insights.publish",
  // Items & services catalog
  "items.read",
  "items.manage",
  // Inventory financial authority. Catalog maintenance (items.manage) decides
  // what an item IS; these decide who may move its VALUE — renaming a catalog
  // entry must never hand over ledger power, so posting and reversing are
  // their own grants, not riders on items.manage.
  "items.post",
  "items.reverse",
  // Projects & job costing
  "projects.read",
  "projects.manage",
  // Subcontractor compliance — certificates of insurance, lien waivers, and
  // year-end information returns. Deliberately four keys, because these are
  // four different duties: recording evidence is not verifying it, granting an
  // exception to a payment block is not either, and transmitting a statutory
  // filing is its own authority.
  "compliance.read",
  "compliance.manage",
  "compliance.verify",
  "compliance.waive",
  "compliance.file",
  // Fixed assets & depreciation
  "assets.read",
  "assets.manage",
  // Time tracking & timesheets
  "time.read",
  "time.manage",
  "time.approve",
  // Reopening approved time is deliberately NOT part of time.approve:
  // separation of duties. Front-line managers approve; whoever owns payroll
  // and billing decides when a locked week may be unlocked again.
  "time.reopen",
  // Payroll — a deliberately separate duty set: wages and deductions are
  // confidential, so none of these ride on time.* or admin.setup.manage.
  // read = see runs/stubs; manage = setup, profiles, components; run =
  // calculate/commit pay runs (posting additionally requires gl.post).
  "payroll.read",
  "payroll.manage",
  "payroll.run",
  // HRM employment — the same confidentiality rule as payroll: who works for
  // whom, reporting lines, and employment terms are never a rider on
  // time.*, payroll.*, or parties.*. read = see employment records; manage
  // = author employment changes; approve = hold approval authority. The
  // approve key alone does NOT establish separation of duties: full approval
  // authorization additionally requires the identity invariant in
  // engine/src/hrm/authorization.ts over the service-loaded request.
  "hrm.employment.read",
  "hrm.employment.manage",
  "hrm.employment.approve",
  // HRM headcount plan — the same confidentiality rule as employment: the
  // funded establishment is never a rider on time.*, payroll.*, or
  // parties.*. read = see positions, funding and vacancy; manage = create,
  // revise, fund and close positions. Assignment approval stays
  // hrm.employment.approve: there is deliberately no position approve key.
  "hrm.position.read",
  "hrm.position.manage",
  // HRM processes (0193) — onboarding/offboarding/transfer checklists. read
  // = see processes and steps; manage = open, complete, and cancel them. A
  // step owner who is the employee themself may complete only their own
  // steps without either key (the first self-service touch, fenced to the
  // step in engine/src/hrm/processes.ts). Skipping a required step needs
  // hrm.employment.manage, never this key alone.
  "hrm.process.read",
  "hrm.process.manage",
  // HR-5 leave and attendance — the same confidentiality rule as employment:
  // read sees leave records; request files for one's own employment only
  // (the service scopes the subject, never the caller); approve decides;
  // manage configures types/policies and acts with a reason where others
  // are refused. Admin-only like the employment keys below.
  "hrm.leave.read",
  "hrm.leave.request",
  "hrm.leave.approve",
  "hrm.leave.manage",
  // HR-6 recruiting — the same confidentiality rule as employment:
  // candidate PII plus the funnel are never a rider on time.*, payroll.*,
  // or parties.*. read = see requisitions, candidates, the pipeline,
  // interviews and offers; manage = author every recruiting write
  // (requisitions, candidates, applications, interviews, offers, hire).
  // A hiring manager reads and moves candidates on their OWN requisitions
  // without the org-wide grant (fenced in authorization.ts); candidate PII
  // (email, phone, resume) is returned only to hrm.recruiting.read holders.
  "hrm.recruiting.read",
  "hrm.recruiting.manage",
  // HR-7 performance and retention (0196) — the same confidentiality
  // rule as employment: reviews carry assessments of named people, so
  // read = see cycles and reviews through the privacy scope (HR grant,
  // subject-on-shared, manager-on-own-reports); manage = run cycles,
  // calibrate and share. Retention is HR-only: hrm.retention.read sees
  // exit records and turnover. Admin-only like the employment keys above.
  "hrm.performance.read",
  "hrm.performance.manage",
  "hrm.retention.read",
  // HR-8 benefits (0197) — the same confidentiality rule as employment:
  // read sees plans, elections and inputs; manage authors plans, windows,
  // elections and generates inputs. Admin-only like the employment keys.
  "hrm.benefits.read",
  "hrm.benefits.manage",
  // HR-13 begin: construction compliance — read sees rate tables,
  // classifications, comp classes, per-diem policies, certified runs and
  // findings; manage authors them and runs generation, approval, voids
  // and finding transitions. Admin-only like the employment keys above.
  "hrm.construction.read",
  "hrm.construction.manage",
  // HR-13 end
  // HR-9 self-service — the person's own view and the manager's team.
  // HR-12 compensation (0221/0222) — the same confidentiality rule as
  // employment: who is paid what, and whether pay is equitable, are
  // never riders on time.*, payroll.*, or parties.*. read = bands,
  // architecture and cycle reads; manage = cycles, push, plans,
  // snapshots; approve = the Flows gate on cycle decisions.
  // Admin-only like the employment keys above.
  "hrm.compensation.read",
  "hrm.compensation.manage",
  "hrm.compensation.approve",
  // self.read sees only the actor's own employment summary, requests and
  // steps (every read scopes by the party behind the login, never by a
  // caller-supplied id); self.request files profile-change proposals for
  // one's own party (leave already files under hrm.leave.request).
  // team.read/team.manage are STRUCTURAL, not role grants: the team read
  // service resolves them by holding direct reports as of today, and no
  // role grant of these keys ever substitutes for that resolution.
  "hrm.self.read",
  "hrm.self.request",
  "hrm.team.read",
  "hrm.team.manage",
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
  // Flows — visual approval/automation graphs (the flow execution contract).
  // manage = author/enable flows; approve = act on flow approval gates
  // (assignees can always act on their OWN gates regardless of this key).
  "flows.manage",
  "flows.approve",
  // HR-16 automations on Flows (0226) — the trigger side. read sees recipes
  // and the run log; manage authors/enables recipes and tunes approval
  // settings; run fires a recipe now. Built-in admin roles, not HR roles:
  // recipes can start processes, write fields and call webhooks.
  // HR-16 begin
  "automations.read",
  "automations.manage",
  "automations.run",
  // HR-16 end
  // Apps — installable packages (sandboxed frontend + governed backend).
  // `apps.use` runs an installed App; `apps.manage` installs/upgrades/removes.
  "apps.use",
  "apps.manage",
  // File Cabinet — document management (browse, upload, move, rename, version)
  "documents.read",
  "documents.manage",
  // In-app issue reporting. A separate key because filing a report sends
  // generalized text OUT of the installation to the operator's product
  // tracker; an organization that does not want its people doing that
  // withholds this without touching anything else. Granted to every built-in
  // role: whoever hits a defect is whoever should be able to report it.
  "feedback.use",
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
  "admin.backups.manage",
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
    ],
  },
  {
    key: "close",
    labelKey: "permissions.groups.close",
    permissions: [
      { key: "periods.manage", labelKey: permissionLabelKey("periods.manage") },
      { key: "close.read", labelKey: permissionLabelKey("close.read") },
      { key: "close.run", labelKey: permissionLabelKey("close.run") },
      { key: "close.approve", labelKey: permissionLabelKey("close.approve") },
      { key: "close.reopen", labelKey: permissionLabelKey("close.reopen") },
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
    key: "crm",
    labelKey: "permissions.groups.crm",
    permissions: [
      { key: "crm.accounts.read", labelKey: permissionLabelKey("crm.accounts.read") },
      { key: "crm.accounts.create", labelKey: permissionLabelKey("crm.accounts.create") },
      { key: "crm.accounts.manage", labelKey: permissionLabelKey("crm.accounts.manage") },
      { key: "crm.accounts.assign", labelKey: permissionLabelKey("crm.accounts.assign") },
      { key: "crm.activities.read", labelKey: permissionLabelKey("crm.activities.read") },
      { key: "crm.activities.manage", labelKey: permissionLabelKey("crm.activities.manage") },
      { key: "crm.opportunities.read", labelKey: permissionLabelKey("crm.opportunities.read") },
      { key: "crm.opportunities.manage", labelKey: permissionLabelKey("crm.opportunities.manage") },
      { key: "crm.opportunities.close", labelKey: permissionLabelKey("crm.opportunities.close") },
      { key: "crm.forecasts.read", labelKey: permissionLabelKey("crm.forecasts.read") },
      { key: "crm.forecasts.manage", labelKey: permissionLabelKey("crm.forecasts.manage") },
      { key: "crm.forecasts.override", labelKey: permissionLabelKey("crm.forecasts.override") },
      { key: "crm.setup.manage", labelKey: permissionLabelKey("crm.setup.manage") },
    ],
  },
  {
    key: "budgets",
    labelKey: "permissions.groups.budgets",
    permissions: [
      { key: "budgets.read", labelKey: permissionLabelKey("budgets.read") },
      { key: "budgets.manage", labelKey: permissionLabelKey("budgets.manage") },
      { key: "budgets.approve", labelKey: permissionLabelKey("budgets.approve") },
    ],
  },
  {
    key: "allocations",
    labelKey: "permissions.groups.allocations",
    permissions: [
      { key: "allocations.read", labelKey: permissionLabelKey("allocations.read") },
      { key: "allocations.manage", labelKey: permissionLabelKey("allocations.manage") },
      { key: "allocations.run", labelKey: permissionLabelKey("allocations.run") },
      { key: "allocations.approve", labelKey: permissionLabelKey("allocations.approve") },
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
      { key: "items.post", labelKey: permissionLabelKey("items.post") },
      { key: "items.reverse", labelKey: permissionLabelKey("items.reverse") },
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
    key: "compliance",
    labelKey: "permissions.groups.compliance",
    permissions: [
      { key: "compliance.read", labelKey: permissionLabelKey("compliance.read") },
      { key: "compliance.manage", labelKey: permissionLabelKey("compliance.manage") },
      { key: "compliance.verify", labelKey: permissionLabelKey("compliance.verify") },
      { key: "compliance.waive", labelKey: permissionLabelKey("compliance.waive") },
      { key: "compliance.file", labelKey: permissionLabelKey("compliance.file") },
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
      { key: "time.reopen", labelKey: permissionLabelKey("time.reopen") },
    ],
  },
  {
    key: "payroll",
    labelKey: "permissions.groups.payroll",
    permissions: [
      { key: "payroll.read", labelKey: permissionLabelKey("payroll.read") },
      { key: "payroll.manage", labelKey: permissionLabelKey("payroll.manage") },
      { key: "payroll.run", labelKey: permissionLabelKey("payroll.run") },
    ],
  },
  {
    key: "hrm",
    labelKey: "permissions.groups.hrm",
    permissions: [
      { key: "hrm.employment.read", labelKey: permissionLabelKey("hrm.employment.read") },
      { key: "hrm.employment.manage", labelKey: permissionLabelKey("hrm.employment.manage") },
      { key: "hrm.employment.approve", labelKey: permissionLabelKey("hrm.employment.approve") },
      { key: "hrm.position.read", labelKey: permissionLabelKey("hrm.position.read") },
      { key: "hrm.position.manage", labelKey: permissionLabelKey("hrm.position.manage") },
      { key: "hrm.process.read", labelKey: permissionLabelKey("hrm.process.read") },
      { key: "hrm.process.manage", labelKey: permissionLabelKey("hrm.process.manage") },
      { key: "hrm.leave.read", labelKey: permissionLabelKey("hrm.leave.read") },
      { key: "hrm.leave.request", labelKey: permissionLabelKey("hrm.leave.request") },
      { key: "hrm.leave.approve", labelKey: permissionLabelKey("hrm.leave.approve") },
      { key: "hrm.leave.manage", labelKey: permissionLabelKey("hrm.leave.manage") },
      { key: "hrm.recruiting.read", labelKey: permissionLabelKey("hrm.recruiting.read") },
      { key: "hrm.recruiting.manage", labelKey: permissionLabelKey("hrm.recruiting.manage") },
      { key: "hrm.performance.read", labelKey: permissionLabelKey("hrm.performance.read") },
      { key: "hrm.performance.manage", labelKey: permissionLabelKey("hrm.performance.manage") },
      { key: "hrm.retention.read", labelKey: permissionLabelKey("hrm.retention.read") },
      { key: "hrm.benefits.read", labelKey: permissionLabelKey("hrm.benefits.read") },
      { key: "hrm.benefits.manage", labelKey: permissionLabelKey("hrm.benefits.manage") },
      { key: "hrm.self.read", labelKey: permissionLabelKey("hrm.self.read") },
      { key: "hrm.self.request", labelKey: permissionLabelKey("hrm.self.request") },
      // HR-12 begin
      { key: "hrm.compensation.read", labelKey: permissionLabelKey("hrm.compensation.read") },
      { key: "hrm.compensation.manage", labelKey: permissionLabelKey("hrm.compensation.manage") },
      { key: "hrm.compensation.approve", labelKey: permissionLabelKey("hrm.compensation.approve") },
      // HR-12 end
      { key: "hrm.team.read", labelKey: permissionLabelKey("hrm.team.read") },
      { key: "hrm.team.manage", labelKey: permissionLabelKey("hrm.team.manage") },
      // HR-13 begin: appended after the team keys so the pinned group
      // order (admin keys, self keys, team keys, construction keys) holds.
      { key: "hrm.construction.read", labelKey: permissionLabelKey("hrm.construction.read") },
      { key: "hrm.construction.manage", labelKey: permissionLabelKey("hrm.construction.manage") },
      // HR-13 end
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
      // HR-16 begin
      { key: "automations.read", labelKey: permissionLabelKey("automations.read") },
      { key: "automations.manage", labelKey: permissionLabelKey("automations.manage") },
      { key: "automations.run", labelKey: permissionLabelKey("automations.run") },
      // HR-16 end
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
    key: "feedback",
    labelKey: "permissions.groups.feedback",
    permissions: [{ key: "feedback.use", labelKey: permissionLabelKey("feedback.use") }],
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
      { key: "admin.backups.manage", labelKey: permissionLabelKey("admin.backups.manage") },
      { key: "api.keys.manage", labelKey: permissionLabelKey("api.keys.manage") },
    ],
  },
];

/**
 * Which catalogue key authorizes each state-changing action of the inventory
 * movement API (`web/app/api/inventory/actions`):
 *
 *   - every value-carrying movement posts a journal, so it demands
 *     `items.post` — the scoped monetary authority;
 *   - unwinding a posted movement is its own approve-class grant
 *     (`items.reverse`, the close.reopen / time.reopen precedent): whoever may
 *     post must not automatically hold the power to erase postings.
 *
 * Lot and serial identifiers are catalog facts rather than journal facts, so
 * they are not listed here — their surface stays on `items.manage`.
 */
export const INVENTORY_ACTION_PERMISSIONS = {
  receive: "items.post",
  issue: "items.post",
  adjust: "items.post",
  transfer: "items.post",
  build: "items.post",
  landed: "items.post",
  reverse: "items.reverse",
} as const satisfies Record<string, CataloguePermission>;

/**
 * Same contract for the advanced inventory API
 * (`web/app/api/inventory/advanced`). `createTransfer` only drafts an order,
 * but drafting is the first half of a stock-moving, journal-carrying act whose
 * execution demands items.post, so the pair shares one authority.
 */
export const INVENTORY_ADVANCED_ACTION_PERMISSIONS = {
  createTransfer: "items.post",
  shipTransfer: "items.post",
  receiveTransfer: "items.post",
  postLandedVoucher: "items.post",
} as const satisfies Record<string, CataloguePermission>;

/**
 * Built-in role definitions, seeded per organization. Authorization is based
 * exclusively on explicit role_assignments rows.
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
      "periods.manage",
      "close.read",
      "close.run",
      "close.approve",
      "close.reopen",
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
      "crm.accounts.read",
      "crm.accounts.create",
      "crm.accounts.manage",
      "crm.accounts.assign",
      "crm.activities.read",
      "crm.activities.manage",
      "crm.opportunities.read",
      "crm.opportunities.manage",
      "crm.opportunities.close",
      "crm.forecasts.read",
      "crm.forecasts.manage",
      "crm.forecasts.override",
      "crm.setup.manage",
      "reports.read",
      "reports.create",
      "reports.schedule",
      "budgets.read",
      "budgets.manage",
      "budgets.approve",
      "allocations.read",
      "allocations.manage",
      "allocations.run",
      "allocations.approve",
      "insights.read",
      "insights.create",
      "insights.publish",
      "records.read",
      "records.create",
      "records.manage_types",
      "items.read",
      "items.manage",
      "items.post",
      "items.reverse",
      "projects.read",
      "projects.manage",
      "compliance.read",
      "compliance.manage",
      "compliance.verify",
      "compliance.waive",
      "compliance.file",
      "assets.read",
      "assets.manage",
      "time.read",
      "time.manage",
      "time.approve",
      "time.reopen",
      "payroll.read",
      "payroll.manage",
      "payroll.run",
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
      "feedback.use",
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
      // HR-9 self-service: every login is a person — seeing one's own
      // employment summary and filing one's own profile change ride the
      // structural scope (party behind the login), so every built-in role
      // carries both self keys. Team keys stay structural with no grant.
      "hrm.self.read",
      "hrm.self.request",
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
      "close.read",
      "close.run",
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
      "budgets.read",
      "budgets.manage",
      "allocations.read",
      "allocations.manage",
      "allocations.run",
      "insights.read",
      "records.read",
      "records.create",
      "items.read",
      "items.manage",
      // Day-to-day stock movements are bookkeeping; erasing them is not —
      // reversal stays with the controller (maker/checker on posted value).
      "items.post",
      "projects.read",
      "projects.manage",
      "compliance.read",
      "compliance.manage",
      "assets.read",
      "assets.manage",
      "time.read",
      "time.manage",
      "assistant.use",
      "assistant.write",
      "documents.read",
      "feedback.use",
      "documents.manage",
      "data.export",
      "data.import",
      "apps.use",
      "scripts.execute",
      // HR-9 self-service on every built-in role (see controller).
      "hrm.self.read",
      "hrm.self.request",
    ],
  },
  approver: {
    name: "Approver",
    description:
      "Reviews and decides approval requests for bills and invoices; read access to the ledger and reports.",
    permissions: [
      "gl.read",
      "close.read",
      "close.approve",
      "ap.read",
      "ap.approve",
      "ar.read",
      "ar.approve",
      "flows.approve",
      "reports.read",
      "budgets.read",
      "budgets.approve",
      "allocations.read",
      "allocations.approve",
      "insights.read",
      "records.read",
      "compliance.read",
      "compliance.verify",
      "compliance.waive",
      "time.read",
      "time.approve",
      "assistant.use",
      "documents.read",
      "feedback.use",
      "data.export",
      "apps.use",
      // HR-9 self-service on every built-in role (see controller).
      "hrm.self.read",
      "hrm.self.request",
    ],
  },
  viewer: {
    name: "Viewer",
    description: "Read-only access to the ledger, subledgers, reports, and insights.",
    permissions: ["gl.read", "close.read", "ap.read", "ar.read", "reports.read", "budgets.read", "allocations.read", "insights.read", "records.read", "items.read", "assets.read", "time.read", "compliance.read", "assistant.use", "documents.read", "feedback.use", "data.export", "apps.use", "hrm.self.read", "hrm.self.request"],
  },
  sales_manager: {
    name: "Sales Manager",
    description: "Manages relationship records, sales activities, opportunities, territories, quotas, and team forecasts.",
    permissions: [
      "crm.accounts.read", "crm.accounts.create", "crm.accounts.manage", "crm.accounts.assign",
      "crm.activities.read", "crm.activities.manage",
      "crm.opportunities.read", "crm.opportunities.manage", "crm.opportunities.close",
      "crm.forecasts.read", "crm.forecasts.manage", "crm.forecasts.override", "crm.setup.manage",
      "parties.read", "parties.manage", "ar.read", "ar.create", "items.read", "reports.read",
      "insights.read", "documents.read", "feedback.use", "data.export", "data.import", "assistant.use",
      // HR-9 self-service on every built-in role (see controller).
      "hrm.self.read", "hrm.self.request",
    ],
  },
  sales_rep: {
    name: "Sales Representative",
    description: "Works assigned accounts, activities, opportunities, estimates, and personal forecasts.",
    permissions: [
      "crm.accounts.read", "crm.accounts.create", "crm.accounts.manage",
      "crm.activities.read", "crm.activities.manage",
      "crm.opportunities.read", "crm.opportunities.manage", "crm.opportunities.close",
      "crm.forecasts.read", "crm.forecasts.manage",
      "parties.read", "parties.manage", "ar.read", "ar.create", "items.read", "reports.read",
      "documents.read", "feedback.use", "data.export", "assistant.use",
      // HR-9 self-service on every built-in role (see controller).
      "hrm.self.read", "hrm.self.request",
    ],
  },
};

export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLES);

/**
 * Wildcard-matching permission check.
 * can() (packages/tenant): exact key, full wildcard `*`, or a `module.*`
 * grant whose prefix covers the requested key.
 */
export function permissionSetCovers(permissions: ReadonlySet<string>, perm: string): boolean {
  // Runtime-only exact denies deactivate declared module permissions beneath any wildcard.
  if (permissions.has(`!${perm}`)) return false;
  if (permissions.has("*")) return true;
  if (permissions.has(perm)) return true;
  // wildcard convention: 'ap.*' grants any 'ap.x'
  for (const p of permissions) {
    if (p.endsWith(".*") && perm.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Apply deny overrides to a granted-permission set — deny wins. A specific
 * deny under a wildcard grant
 * first expands that wildcard into its catalogue keys (so the sibling keys
 * survive), then every denied key — and everything under a wildcard deny —
 * is removed.
 */
export function applyPermissionDenies(permissions: Set<string>, denies: string[], additionalKnownPermissions: readonly string[] = []): void {
  const catalogue: readonly string[] = [...PERMISSION_CATALOGUE, ...additionalKnownPermissions];
  const specificDenies = denies.filter((deny) => !deny.endsWith(".*"));
  // A full wildcard must be materialized before denies are applied. Leaving
  // `*` in the set would make permissionSetCovers return true immediately,
  // bypassing every specific (or module-scoped) deny.
  if (permissions.has("*") && denies.length > 0) {
    permissions.delete("*");
    for (const key of catalogue) permissions.add(key);
  }
  for (const grant of [...permissions]) {
    if (!grant.endsWith(".*")) continue;
    const prefix = grant.slice(0, -1);
    if (!specificDenies.some((deny) => deny.startsWith(prefix))) continue;
    permissions.delete(grant);
    for (const key of catalogue) if (key.startsWith(prefix)) permissions.add(key);
  }
  for (const denied of denies) {
    permissions.delete(denied);
    if (!denied.endsWith(".*")) continue;
    const prefix = denied.slice(0, -1);
    for (const grant of [...permissions]) if (grant.startsWith(prefix)) permissions.delete(grant);
  }
}

/**
 * Union assigned roles' permissions, add grant overrides, then apply deny
 * overrides. A user without an assigned role has no permissions.
 */
export function resolveEffectivePermissions(args: {
  additionalKnownPermissions?: readonly string[];
  rolePermissionSets: readonly (readonly string[])[];
  overrides: readonly { permission: string; effect: "grant" | "deny" }[];
}): Set<string> {
  const permissions = new Set<string>();
  for (const set of args.rolePermissionSets) for (const p of set) permissions.add(p);
  for (const o of args.overrides) if (o.effect === "grant") permissions.add(o.permission);
  applyPermissionDenies(
    permissions,
    args.overrides.filter((o) => o.effect === "deny").map((o) => o.permission),
    args.additionalKnownPermissions,
  );
  return permissions;
}

/**
 * Privilege ceiling for delegated administration. `admin.users.manage` and
 * `admin.roles.manage` are ordinary catalogue keys, so an administrator who
 * holds only one of them must not be able to mint or hand out permissions
 * they do not themselves hold. Returns every `requested` key that the
 * `ceiling` set does not cover (wildcard-aware, in request order, deduped);
 * empty means the request sits inside the ceiling. A `*` ceiling covers all.
 */
export function permissionsOutsideCeiling(
  ceiling: ReadonlySet<string>,
  requested: Iterable<string>,
): string[] {
  const missing: string[] = [];
  for (const key of new Set(requested)) {
    if (!permissionSetCovers(ceiling, key)) missing.push(key);
  }
  return missing;
}

const CATALOGUE_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE);

/** True when `key` is a known catalogue permission (used to validate role edits). */
export function isCataloguePermission(key: string): key is CataloguePermission {
  return CATALOGUE_SET.has(key);
}
