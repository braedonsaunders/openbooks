import {
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Modules — the org-scoped unit of composed change.
 *
 * A module is an installable package whose manifest declares CONTRIBUTIONS —
 * pages, panels, record types, fields, reports, cards, jobs, endpoints, hooks,
 * flows, agents, permissions, settings — each of which projects into a table
 * this app already ships. `page_specs` is the first contribution kind and
 * already proves the projection pattern end to end: a module version declares
 * a page, the installer writes the projection row, the renderer reads it.
 * apps (the sandboxed iframe packages, `./apps`) stay exactly as they are; a
 * module is how surfaces register, not a second runtime.
 *
 * Lifecycle:
 *   modules (installed module: key + status + granted permissions + active version)
 *     └─ module_versions (immutable: semver label + manifest + status)
 *          └─ page_specs.module_version_id (the first projection seam)
 *
 * The split between `modules` and `module_versions` is the whole design. The
 * module row is the org's RELATIONSHIP with a module — mutable, small, one
 * row per install. Every install and upgrade APPENDS an immutable version row
 * carrying what that version said; a superseded version keeps its manifest so
 * a rollback can re-apply the exact bytes that ran before, and so audit
 * evidence written against version N points at version N for the life of the
 * row. Immutability is enforced at the storage boundary (BEFORE UPDATE
 * trigger, migration 0107), not only in the installer, because "the manifest
 * an approval was granted for" and "the manifest in the table" must be the
 * same document forever.
 *
 * Distribution is per-org for v1, mirroring apps: an org authors and installs
 * modules for itself. A cross-org marketplace is future work.
 */

export const MODULE_STATUSES = ["installed", "disabled"] as const;

/**
 * Which runtime owns a modules row. Native installer-created rows are
 * 'module'; rows absorbed from apps by migration 0109 are 'app' (their
 * bundle keeps serving from the apps runtime, app_files stays the single
 * store). Mirrors the modules_kind_shape CHECK exactly; the installer
 * consumes this spelling, so the two lists must agree.
 */
export const MODULE_KINDS = ["module", "app"] as const;

/**
 * The contribution kinds a manifest may declare. Each names something a
 * version projects into a table this app already ships — page into
 * page_specs, and the rest into their own existing surfaces as those kinds
 * come online. The list is closed: an unknown kind is a validation error, not
 * a pass-through. Spelling matches CONTRIBUTION_KINDS in
 * web/lib/modules/manifest.ts exactly (hyphenated 'record-type'); the
 * installer consumes the manifest's spelling, so the two lists must agree.
 */
export const MODULE_CONTRIBUTION_KINDS = [
  "page",
  "panel",
  "record-type",
  "field",
  "report",
  "card",
  "job",
  "endpoint",
  "hook",
  "flow",
  "agent",
  "permission",
  "setting",
] as const;

export const modules = pgTable(
  "modules",
  {
    id: id(),
    orgId: orgRef(),
    /**
     * Stable slug, unique per org — the module's identity across installs and
     * upgrades. Lowercase [a-z0-9-], 1-64 chars.
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Admin icon key (shared ICONS registry). */
    iconKey: text("icon_key").notNull().default("box"),
    status: text("status", { enum: MODULE_STATUSES }).notNull().default("installed"),
    /**
     * Which runtime owns the package: 'module' (installer-created) or 'app'
     * (absorbed from apps; the apps runtime still serves it). Defaults so
     * pre-0109 rows read as native modules without a data rewrite.
     */
    kind: text("kind", { enum: MODULE_KINDS }).notNull().default("module"),
    /**
     * The version whose contributions are projected right now. NULL only
     * transiently between install and first version activation, or after a
     * full rollback. Pinned tenant-coherently to module_versions by the
     * composite FK (org_id, active_version_id) → module_versions (org_id, id).
     */
    activeVersionId: uuid("active_version_id"),
    /**
     * Permissions the admin granted this module at install. The module runs
     * with (granted ∩ installer's effective permissions); a subset of the
     * manifest's requested permissions — an admin may grant fewer.
     */
    grantedPermissions: jsonb("granted_permissions").$type<string[]>().notNull().default([]),
    /**
     * The absorbed app this module row is the lifecycle surface for, or NULL
     * for a native module. Pinned tenant-coherently by the composite FK
     * (org_id, app_id) → apps (org_id, id); bundle files stay in app_files
     * under this id — never duplicated. Deleted with the app.
     */
    appId: uuid("app_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("modules_org_key").on(t.orgId, t.key),
    index("modules_org_status").on(t.orgId, t.status),
  ],
);

export const MODULE_VERSION_STATUSES = [
  "pending",
  "active",
  "superseded",
  "rolled_back",
] as const;

export const moduleVersions = pgTable(
  "module_versions",
  {
    id: id(),
    orgId: orgRef(),
    moduleId: uuid("module_id").notNull(),
    /** Semver label from the manifest, e.g. "1.0.0", "2.1.0-rc.1". Unique per module. Immutable. */
    version: text("version").notNull(),
    /**
     * The validated manifest this version declared: identity, requested
     * permissions, and its contributions, each naming a contribution kind and
     * the target table it projects into. Immutable once written — enforced by
     * the module_versions_immutability trigger (migration 0107), because this
     * document is the audit evidence for every approval and rollback recorded
     * against the row.
     */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Lifecycle: pending (uploaded, not yet approved/applied), active (its
     * contributions are projected), superseded (a newer version is active),
     * rolled_back (its contributions were withdrawn by a rollback). The only
     * mutable business column on an otherwise immutable row.
     */
    status: text("status", { enum: MODULE_VERSION_STATUSES }).notNull().default("pending"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("module_versions_module_version").on(t.moduleId, t.version),
    index("module_versions_org_module").on(t.orgId, t.moduleId),
    index("module_versions_module_status").on(t.moduleId, t.status),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass — referential-integrity.sql):
  modules.org_id                          → orgs.id ON DELETE CASCADE
  modules.active_version_id               → module_versions (org_id, id) ON DELETE SET NULL (active_version_id)
  modules.(org_id, app_id)                → apps (org_id, id) ON DELETE CASCADE (0109; NULL for native modules)
  modules.created_by/updated_by           → users.id
  module_versions.org_id                  → orgs.id ON DELETE CASCADE
  module_versions.module_id               → modules (org_id, id) ON DELETE CASCADE
  module_versions.created_by/updated_by   → users.id
  page_specs.module_version_id            → module_versions (org_id, id) ON DELETE RESTRICT

  Like apps → app_versions, modules and module_versions reference each other
  (active_version_id up, module_id down), so the edges are declared here only
  as documentation; 0107 installs the tenant-coherent composite constraints on
  the database side.
*/
