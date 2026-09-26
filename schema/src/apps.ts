import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Extension packages: one organization-scoped ownership and version authority.
 * Apps launches their native or sandbox workspaces; Extensions manages drafts,
 * review, activation, contributions, and governed object provisioning.
 *
 * apps -> app_versions -> app_files holds immutable package source.
 * app_storage and app_runs hold governed state and execution evidence.
 * app_listings distributes immutable snapshots through the same review flow.
 * Backend handlers have no database, filesystem, or network access: all writes
 * pass through the platform adapters and the caller/package permission intersection.
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
