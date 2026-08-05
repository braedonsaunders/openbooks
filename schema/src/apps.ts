import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Apps — installable packages. An App is an org-installed
 * package that bundles a sandboxed frontend (HTML/JS/CSS) with a backend
 * (server-side endpoint scripts), built on this platform's existing primitives: the QuickJS
 * sandbox (backend isolation), custom records (data), and — critically — an
 * opaque-origin sandboxed iframe for the frontend, so uploaded HTML/JS/CSS
 * runs with no cookies, no parent DOM access, and no ambient network. Every
 * capability an App reaches goes through an audited postMessage bridge that is
 * permission-checked against what the installing admin granted.
 *
 * Lifecycle:
 *   apps (installed app: slug + status + granted permissions + active version)
 *     └─ app_versions (immutable bundle metadata: version + manifest)
 *          └─ app_files (the actual frontend/backend/asset files)
 *     └─ app_storage (the App's own governed KV store — its backend's writes)
 *
 * Distribution is per-org for v1: an org authors/uploads/installs Apps for
 * itself. A cross-org marketplace (signed, published bundles) is future work.
 */

export const APP_STATUSES = ["installed", "disabled"] as const;

export const apps = pgTable(
  "apps",
  {
    id: id(),
    orgId: orgRef(),
    /**
     * Stable slug, unique per org — keys the runtime URL (/apps/<key>), the
     * nav entry, and the App's storage namespace. Lowercase [a-z0-9-].
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Sidebar icon key (shared ICONS registry). */
    iconKey: text("icon_key").notNull().default("box"),
    status: text("status", { enum: APP_STATUSES }).notNull().default("installed"),
    /**
     * The active bundle. NULL only transiently between create and first
     * version publish. The runtime always serves this version.
     */
    activeVersionId: uuid("active_version_id"),
    /**
     * Permissions the admin granted this App at install. The App's backend
     * runs with (granted ∩ installer's effective permissions); its frontend
     * bridge calls are checked against this set. Subset of the manifest's
     * requested permissions — an admin may grant fewer.
     */
    grantedPermissions: jsonb("granted_permissions").$type<string[]>().notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Provenance of objects this App provisioned from its bundle's objects/
     * dir: { recordTypes: [keys], customFields: ["table:key"] }. Uninstall
     * deliberately PRESERVES provisioned objects (they hold living master
     * data); this map is how a reinstall knows it may upgrade them.
     */
    provisioned: jsonb("provisioned").$type<{ recordTypes?: string[]; customFields?: string[] }>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("apps_org_key").on(t.orgId, t.key),
    index("apps_org_status").on(t.orgId, t.status),
  ],
);

export const APP_VERSION_STATUSES = ["draft", "active", "superseded"] as const;

export const appVersions = pgTable(
  "app_versions",
  {
    id: id(),
    orgId: orgRef(),
    appId: uuid("app_id").notNull(),
    /** Semver-ish label from the manifest, e.g. "1.0.0". Unique per app. */
    version: text("version").notNull(),
    /**
     * The validated manifest.json for this bundle: declared entry point,
     * requested permissions, backend endpoints, nav config. See
     * web/lib/apps/manifest.ts for the schema. Immutable once created.
     */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: APP_VERSION_STATUSES }).notNull().default("draft"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("app_versions_app_version").on(t.appId, t.version),
    index("app_versions_org_app").on(t.orgId, t.appId),
  ],
);

export const APP_FILE_KINDS = ["frontend", "backend", "asset"] as const;

export const appFiles = pgTable(
  "app_files",
  {
    id: id(),
    orgId: orgRef(),
    appId: uuid("app_id").notNull(),
    versionId: uuid("version_id").notNull(),
    /**
     * Bundle-relative path, e.g. "frontend/index.html", "backend/api.js",
     * "frontend/styles.css". Unique within a version. The manifest's entry
     * point and endpoint files reference these paths.
     */
    path: text("path").notNull(),
    /** How the runtime treats it: frontend (served to the iframe), backend
     *  (loaded into the sandbox for endpoints), or asset (image/font/etc). */
    kind: text("kind", { enum: APP_FILE_KINDS }).notNull(),
    /** MIME type used when serving the file to the iframe. */
    contentType: text("content_type").notNull().default("text/plain"),
    /**
     * File body. Text files (html/js/css/json) store raw UTF-8. Binary assets
     * (images/fonts) store base64 with isBinary=true; the bundle route decodes
     * before serving. Kept inline (not file_blobs) — App bundles are small and
     * versioned, and inline storage keeps a version self-contained.
     */
    content: text("content").notNull().default(""),
    isBinary: boolean("is_binary").notNull().default(false),
    size: integer("size").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("app_files_version_path").on(t.versionId, t.path),
    index("app_files_version_kind").on(t.versionId, t.kind),
  ],
);

/**
 * Per-App governed key-value store — the backend's write surface for v1.
 * Namespaced by App + org, so one App can never read or clobber another's
 * data, and no App can touch the ledger. Values are JSON. This is the safe
 * "governed writes" primitive; script-driven ledger posting is future work
 * gated behind a separate, carefully-designed capability.
 */
export const appStorage = pgTable(
  "app_storage",
  {
    id: id(),
    orgId: orgRef(),
    appId: uuid("app_id").notNull(),
    /** Optional sub-namespace within the App (defaults to "default"). */
    namespace: text("namespace").notNull().default("default"),
    key: text("key").notNull(),
    /** JSON value. NULL column = unset; a stored JSON `null` is distinct. */
    value: jsonb("value").$type<unknown>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("app_storage_scope_key").on(t.appId, t.namespace, t.key),
    index("app_storage_org_app").on(t.orgId, t.appId),
  ],
);

/**
 * Per-invocation log of App backend endpoint runs — the App equivalent of
 * script_runs. One row per endpoint call, with status, console output, the
 * governance units consumed, and duration. Powers the App's run history / debug
 * panel and lets an admin see what an App has been doing.
 */
export const appRuns = pgTable(
  "app_runs",
  {
    id: id(),
    orgId: orgRef(),
    appId: uuid("app_id").notNull(),
    versionId: uuid("version_id"),
    /** Endpoint name from the manifest, or "*" for a bundle-level failure. */
    endpoint: text("endpoint").notNull(),
    status: text("status", { enum: ["ok", "error", "timeout", "forbidden"] }).notNull(),
    /** Governance units consumed (each read/write/log costs units). */
    units: integer("units").notNull().default(0),
    logs: jsonb("logs").$type<string[]>().notNull().default([]),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    /** The user who triggered the call (frontend bridge caller). */
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("app_runs_app_at").on(t.appId, t.at)],
);

/**
 * Marketplace listings — the cross-org distribution surface. Deliberately NOT
 * org-scoped (no orgRef): a listing is visible to every org on the deployment.
 * Publishing snapshots an installed App's active bundle (manifest + files)
 * into the listing, so installs from the marketplace never reach into the
 * publisher's live tables. Installing copies the snapshot through the normal
 * installApp() path — same validation, same permission grants.
 */
export const appListings = pgTable(
  "app_listings",
  {
    id: id(),
    /** The org that published (owns) this listing. */
    publisherOrgId: uuid("publisher_org_id").notNull(),
    /** Global slug — one listing per app key across the deployment. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    iconKey: text("icon_key").notNull().default("box"),
    version: text("version").notNull(),
    /** Snapshot of the published bundle's manifest. */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    /** Snapshot of the bundle files: [{ path, content, isBinary }]. */
    files: jsonb("files").$type<Array<Record<string, unknown>>>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("app_listings_key").on(t.key),
    index("app_listings_publisher").on(t.publisherOrgId),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass — referential-integrity.sql):
  apps.org_id                         → orgs.id
  apps.active_version_id              → app_versions.id ON DELETE SET NULL
  apps.created_by/updated_by          → users.id
  app_versions.org_id                 → orgs.id
  app_versions.app_id                 → apps.id ON DELETE CASCADE
  app_versions.created_by/updated_by  → users.id
  app_files.org_id                    → orgs.id
  app_files.app_id                    → apps.id ON DELETE CASCADE
  app_files.version_id                → app_versions.id ON DELETE CASCADE
  app_storage.org_id                  → orgs.id
  app_storage.app_id                  → apps.id ON DELETE CASCADE
  app_runs.org_id                     → orgs.id
  app_runs.app_id                     → apps.id ON DELETE CASCADE
  app_listings.publisher_org_id       → orgs.id ON DELETE CASCADE
  app_listings.created_by/updated_by  → users.id
*/
