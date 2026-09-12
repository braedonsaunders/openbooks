import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * Absorb apps into the modules lifecycle surface.
 *
 * Every installed app gets one modules row (kind 'app', provenance edge
 * app_id → apps) plus one ACTIVE module version whose manifest is projected
 * from the app's active bundle manifest. The modules row is the
 * lifecycle/audit surface; the apps runtime is untouched — the bundle files
 * stay in app_files under their app_id and are never duplicated, and no
 * contribution projects into page_specs or any other module target (hence
 * the empty contributions list).
 *
 * Two entry points share one contract:
 *
 *   projectAppManifestToModuleManifest — pure, never throws. Builds the exact
 *   manifest document migration 0109 writes, so the migration's SQL and any
 *   runtime caller project byte-identical provenance. Returns errors instead
 *   of throwing, following web/lib/apps/manifest.ts.
 *
 *   absorbAppsForOrg — idempotent per-org backfill repeating 0109's three
 *   statements (insert module rows, insert active versions, link
 *   active_version_id) for apps installed AFTER the migration ran. Safe to
 *   re-run: every statement skips rows it already absorbed and reports what
 *   it did. Must run inside withBypass (the trusted backfill boundary, like
 *   the test fixtures) — it writes across the apps/modules seam that RLS
 *   otherwise keeps separate.
 *
 * The projected manifest is shaped so it PASSES the module contract
 * (parseModuleManifest), never merely resembles it:
 *
 *   description is omitted when the app has none (absent and empty differ;
 *   a null would fail the contract's optional string), and requested
 *   permissions are filtered to catalogue members — an app manifest accepts
 *   any string, the module contract only MODULE_PLATFORM_PERMISSIONS.
 *   Filtering is never silent: every dropped permission is named in
 *   provenance.unmappedPermissions, carried inside the immutable version
 *   manifest, which IS the audit note (version-pinned, never rewritten).
 *   The modules row's granted_permissions keeps the admin's actual grants
 *   verbatim — that column is the grant record, not the request record.
 *
 * Deliberately no installer semantics here and no audit_log writes. The
 * installer (engine/src/modules/installer.ts, owned by Phase 1c) decides
 * what installing MEANS — approvals, capability grants, projections; absorb
 * only registers what the app install already decided, and the app's own
 * install audit evidence already carries that grant's before/after. The
 * absorbed version is recorded 'active' because the app is live, not because
 * absorb approved anything.
 */

/** modules.kind value for rows absorbed from apps (native rows are 'module'). */
export const ABSORBED_APP_MODULE_KIND = "app" as const;

/**
 * Requested-permission members that survive projection, mirrored with
 * citation from MODULE_PLATFORM_PERMISSIONS in
 * web/lib/modules/manifest.ts (the module contract owner) — mirrored rather
 * than imported because engine must not import web/lib (see the
 * REPORT_KINDS/FIELD_TYPES mirrors inside manifest.ts itself for the house
 * precedent). The absorb integration test asserts parity, so catalogue drift
 * fails loudly instead of silently changing what absorbs.
 */
export const ABSORBED_APP_MAPPED_PERMISSIONS: readonly string[] = [
  "ap.create",
  "ap.pay",
  "ap.post",
  "ap.read",
  "ar.create",
  "ar.post",
  "ar.read",
  "assets.manage",
  "assets.read",
  "gl.post",
  "gl.read",
  "items.manage",
  "items.read",
  "parties.manage",
  "parties.read",
  "projects.manage",
  "projects.read",
  "records.create",
  "records.read",
];

const MAPPED_PERMISSIONS = new Set<string>(ABSORBED_APP_MAPPED_PERMISSIONS);

/**
 * The SQL array literal for the catalogue mirror above — rendered once so
 * the literal and the exported list cannot drift within this file (drift
 * against the contract owner is caught by the parity test instead).
 * Embedded via sql.raw: a bound JS array would interpolate as a row
 * constructor under ANY(), not a PostgreSQL array.
 */
const MAPPED_PERMISSIONS_LITERAL = `ARRAY[${ABSORBED_APP_MAPPED_PERMISSIONS.map((p) => `'${p}'`).join(",")}]`;

/** App slug shape — the same SLUG web/lib/apps/manifest.ts enforces. */
const APP_SLUG = /^[a-z][a-z0-9-]*$/;
/** Loose semver — the same VERSION both manifest parsers enforce. */
const APP_VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/i;

/** The apps-row fields absorb reads. Grants and status copy verbatim. */
export interface AbsorbAppSource {
  id: string;
  key: string;
  name: string;
  description: string | null;
  grantedPermissions: string[];
}

/** The active app-version fields absorb reads. */
export interface AbsorbAppVersionSource {
  id: string;
  version: string;
  /** Requested permissions from the bundle manifest (what the app asked for). */
  permissions: string[];
}

/**
 * Provenance carried inside every absorbed version manifest: which runtime
 * owns the package and which bundle it projects, plus the requested
 * permissions the module contract has no member for. The manifest row is
 * immutable, so this object is the permanent, version-pinned audit note for
 * both the absorption and the permission narrowing — nothing about it can
 * be edited after the fact, only superseded by a new version.
 */
export interface AbsorbedAppProvenance {
  kind: typeof ABSORBED_APP_MODULE_KIND;
  appId: string;
  appKey: string;
  appVersionId: string;
  /** Requested permissions dropped by the catalogue filter, in request order. */
  unmappedPermissions: string[];
}

/**
 * The manifest an absorbed version carries. Identity mirrors the app bundle
 * manifest; permissions are the requested ones the module contract accepts;
 * contributions stay empty because nothing about an app projects into a
 * module target table — app_files remains the single store of the bundle.
 * description is present only when the app has one (absent and empty
 * differ); provenance names the source bundle and the dropped permissions.
 */
export interface AbsorbedAppModuleManifest {
  key: string;
  name: string;
  version: string;
  description?: string;
  permissions: string[];
  contributions: unknown[];
  provenance: AbsorbedAppProvenance;
}

export interface ProjectAppManifestResult {
  ok: boolean;
  manifest?: AbsorbedAppModuleManifest;
  errors: string[];
}

/**
 * Project an app (+ its active version) onto the module manifest 0109
 * stores. Pure and total: invalid key/version shapes are errors, never
 * exceptions. Permissions split into contract members (kept, in request
 * order) and unmapped ones (named in provenance, never silently dropped);
 * a missing description stays missing.
 */
export function projectAppManifestToModuleManifest(
  app: AbsorbAppSource,
  version: AbsorbAppVersionSource,
): ProjectAppManifestResult {
  const errors: string[] = [];
  if (!APP_SLUG.test(app.key) || app.key.length < 1 || app.key.length > 64) {
    errors.push(`app key ${JSON.stringify(app.key)} is not a module key (a-z, 0-9, -, 1-64 chars)`);
  }
  if (!APP_VERSION.test(version.version)) {
    errors.push(`app version ${JSON.stringify(version.version)} must look like 1.0.0`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      key: app.key,
      name: app.name,
      version: version.version,
      ...(app.description !== null ? { description: app.description } : {}),
      permissions: version.permissions.filter((p) => MAPPED_PERMISSIONS.has(p)),
      contributions: [],
      provenance: {
        kind: ABSORBED_APP_MODULE_KIND,
        appId: app.id,
        appKey: app.key,
        appVersionId: version.id,
        unmappedPermissions: version.permissions.filter((p) => !MAPPED_PERMISSIONS.has(p)),
      },
    },
  };
}

/** What one absorb pass did. Zeros mean "already absorbed" — not failure. */
export interface AbsorbAppsResult {
  modulesInserted: number;
  versionsInserted: number;
  linked: number;
}

/**
 * Idempotently absorb every installed app of one org into modules. Repeats
 * migration 0109 part-for-part for rows the migration never saw (apps
 * installed later, or a retry): module rows for unabsorbed apps, active
 * versions projected from each absorbed app's active bundle version, then
 * the active_version_id link. Concurrent passes converge via the same
 * guards the migration uses (provenance NOT EXISTS plus unique-conflict
 * skips), so a double-run reports zeros rather than doubling rows.
 */
export async function absorbAppsForOrg(orgId: string): Promise<AbsorbAppsResult> {
  if (!orgId.trim()) throw new Error("absorbAppsForOrg requires an org id");
  return await db.transaction(async (tx) => {
    const modules = await tx.execute(sql`
      INSERT INTO modules
        (org_id, key, name, description, icon_key, status, granted_permissions, kind, app_id,
         created_at, created_by, updated_at, updated_by)
      SELECT a.org_id, a.key, a.name, a.description, a.icon_key, a.status, a.granted_permissions,
             'app', a.id, a.created_at, a.created_by, a.updated_at, a.updated_by
        FROM apps a
       WHERE a.org_id = ${orgId}
         AND NOT EXISTS (SELECT 1 FROM modules m WHERE m.app_id = a.id)
         AND length(a.key) BETWEEN 1 AND 64
         AND a.key ~ '^[a-z][a-z0-9-]*$'
      ON CONFLICT (org_id, key) DO NOTHING`);

    const versions = await tx.execute(sql`
      INSERT INTO module_versions
        (org_id, module_id, version, manifest, status, created_at, created_by, updated_at, updated_by)
      SELECT a.org_id, m.id, av.version,
             jsonb_build_object(
               'key', a.key,
               'name', a.name,
               'version', av.version,
               'permissions', perms.mapped,
               'contributions', '[]'::jsonb,
               'provenance', jsonb_build_object(
                 'kind', 'app',
                 'appId', a.id,
                 'appKey', a.key,
                 'appVersionId', av.id,
                 'unmappedPermissions', perms.unmapped
               )
             ) || CASE WHEN a.description IS NOT NULL
                       THEN jsonb_build_object('description', a.description)
                       ELSE '{}'::jsonb END,
             'active', av.created_at, av.created_by, av.updated_at, av.updated_by
        FROM apps a
        JOIN modules m ON m.app_id = a.id
        JOIN app_versions av ON av.id = a.active_version_id AND av.org_id = a.org_id
        CROSS JOIN LATERAL (
          SELECT coalesce(jsonb_agg(e #>> '{}' ORDER BY o) FILTER (WHERE (e #>> '{}') = ANY (${sql.raw(MAPPED_PERMISSIONS_LITERAL)})), '[]'::jsonb) AS mapped,
                 coalesce(jsonb_agg(e #>> '{}' ORDER BY o) FILTER (WHERE NOT ((e #>> '{}') = ANY (${sql.raw(MAPPED_PERMISSIONS_LITERAL)}))), '[]'::jsonb) AS unmapped
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(av.manifest -> 'permissions') = 'array'
                                           THEN av.manifest -> 'permissions'
                                           ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
           WHERE jsonb_typeof(t.e) = 'string'
        ) AS perms
       WHERE a.org_id = ${orgId}
         AND a.active_version_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM module_versions mv WHERE mv.module_id = m.id AND mv.version = av.version)
      ON CONFLICT (module_id, version) DO NOTHING`);

    const linked = await tx.execute(sql`
      UPDATE modules m
         SET active_version_id = mv.id
        FROM apps a
        JOIN app_versions av ON av.id = a.active_version_id AND av.org_id = a.org_id
        JOIN module_versions mv ON mv.version = av.version AND mv.org_id = a.org_id
       WHERE m.app_id = a.id
         AND mv.module_id = m.id
         AND a.org_id = ${orgId}
         AND (m.active_version_id IS NULL OR m.active_version_id <> mv.id)`);

    return {
      modulesInserted: modules.rowCount ?? 0,
      versionsInserted: versions.rowCount ?? 0,
      linked: linked.rowCount ?? 0,
    };
  });
}

