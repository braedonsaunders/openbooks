import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";

/**
 * Module installer — the ONLY writer of module lifecycle and projection rows.
 *
 * A module VERSION is immutable: its manifest declares CONTRIBUTIONS, and each
 * contribution projects into a table the app already ships. In v1 the only
 * projected kind is `page` (→ page_specs with module_version_id); every other
 * kind is structurally valid per the canonical manifest validator but has no
 * projection yet, so an install carrying one is REFUSED rather than half
 * performed. A silent partial install would be a fake success path, and the
 * approval UI already reports those kinds as NOT_IMPLEMENTED_YET.
 *
 * Layering: the canonical manifest validator is parseModuleManifest in
 * web/lib/modules/manifest.ts (zod, shared client-side for pre-upload
 * checks). This engine module cannot import it — engine never imports from
 * web — so callers validate there first and the installer re-checks at the
 * persistence boundary everything its SQL depends on (identity shape, page
 * payload shape, org scope, duplicate routes). Catalogue membership of
 * requested permissions and capability intersection belong to the manifest
 * module and the Phase 2a lattice, not to this projection boundary.
 *
 * Transactional shape (mirrors installApp in web/lib/apps/store.ts): the
 * module upsert, the version append, every projection, and every audit row
 * commit in ONE transaction. A conflict anywhere — an org-native layout on a
 * claimed route, a duplicate version label with different bytes — aborts the
 * whole install and leaves zero rows behind.
 *
 * Org isolation is by explicit org_id predicates on every statement; RLS
 * enforces it again at storage. Callers run under the org's request context
 * (or another trusted boundary such as the test bypass).
 */

export class ModuleInstallError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModuleInstallError";
    this.status = status;
  }
}

/** Slug: lowercase, starts with a letter, [a-z0-9-] — mirrors the manifest and modules CHECK. */
const SLUG = /^[a-z][a-z0-9-]*$/;
/**
 * Storage-shape semver: 1, 1.0, or 1.0.0 with optional -tag. Deliberately
 * the case-SENSITIVE 0107 CHECK shape, not the manifest's case-insensitive
 * one: an uppercase prerelease tag the database would reject must fail here
 * with a named error, not as a raw constraint violation.
 */
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/;
/** Route PATTERN a page contribution may claim — mirrors the manifest ROUTE. */
const ROUTE = /^\/[A-Za-z0-9\-_/[\]().]+$/;

const MAX_CONTRIBUTIONS = 200;
const MAX_PERMISSIONS = 50;

export type InstallOutcome = "installed" | "already-installed" | "reactivated";

export interface InstallResult {
  moduleId: string;
  versionId: string;
  outcome: InstallOutcome;
}

export interface UninstallResult {
  /** Null when no such module was ever installed: uninstall is idempotent. */
  moduleId: string | null;
  deactivatedProjections: number;
}

interface ValidPageContribution {
  kind: "page";
  route: string;
  spec: Record<string, unknown>;
}

interface ValidManifest {
  key: string;
  name: string;
  version: string;
  description: string | null;
  permissions: string[];
  contributions: ValidPageContribution[];
}

/** Deterministic JSON encoding so a stored manifest compares equal to the bytes that wrote it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** The exact document a version row carries; what approvals grant and audit keeps verbatim. */
function canonicalManifest(m: ValidManifest): Record<string, unknown> {
  return {
    key: m.key,
    name: m.name,
    version: m.version,
    description: m.description,
    permissions: m.permissions,
    contributions: m.contributions.map((c) => ({ kind: "page", route: c.route, spec: c.spec, scope: "org" })),
  };
}

/**
 * Persistence-boundary validation. Throws ModuleInstallError naming the
 * defect — never a TypeError on caller garbage, never a raw PG error on a
 * CHECK the caller could have been told about first.
 */
function validateManifest(raw: unknown): ValidManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModuleInstallError("invalid manifest: expected an object");
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.key !== "string" || !SLUG.test(m.key) || m.key.length < 1 || m.key.length > 64) {
    throw new ModuleInstallError("invalid manifest: key must be a 1–64 char slug (a-z, 0-9, -)");
  }
  if (typeof m.name !== "string" || m.name.length < 1 || m.name.length > 120) {
    throw new ModuleInstallError("invalid manifest: name must be 1–120 chars");
  }
  if (typeof m.version !== "string" || m.version.length > 32 || !VERSION.test(m.version)) {
    throw new ModuleInstallError("invalid manifest: version must look like 1.0.0");
  }
  const description = m.description ?? null;
  if (description !== null && (typeof description !== "string" || description.length > 2000)) {
    throw new ModuleInstallError("invalid manifest: description must be at most 2000 chars");
  }
  const permissions = m.permissions ?? [];
  if (
    !Array.isArray(permissions) ||
    permissions.length > MAX_PERMISSIONS ||
    permissions.some((p) => typeof p !== "string" || (p as string).length > 80)
  ) {
    throw new ModuleInstallError("invalid manifest: permissions must be a list of at most 50 permission strings");
  }
  const contributions = m.contributions ?? [];
  if (!Array.isArray(contributions) || contributions.length > MAX_CONTRIBUTIONS) {
    throw new ModuleInstallError("invalid manifest: contributions must be a list of at most 200 entries");
  }

  const seenRoutes = new Set<string>();
  const valid: ValidPageContribution[] = contributions.map((rawContribution, i) => {
    if (typeof rawContribution !== "object" || rawContribution === null || Array.isArray(rawContribution)) {
      throw new ModuleInstallError(`invalid manifest: contributions[${i}] must be an object`);
    }
    const c = rawContribution as Record<string, unknown>;
    if (c.kind !== "page") {
      throw new ModuleInstallError(
        `contribution kind "${String(c.kind)}" is not projectable yet (v1 projects only "page"); ` +
          `refusing the install rather than pretending it happened`,
      );
    }
    if (typeof c.route !== "string" || !ROUTE.test(c.route) || c.route.length > 120) {
      throw new ModuleInstallError(
        `invalid manifest: page contribution ${i} route must be an absolute route pattern of at most 120 chars`,
      );
    }
    if (typeof c.spec !== "object" || c.spec === null || Array.isArray(c.spec)) {
      throw new ModuleInstallError(`invalid manifest: page contribution for route ${c.route} needs a spec object`);
    }
    // A module version is org-wide by definition: reviewed and approved once
    // for everyone. `user` is a personal preference, never something an
    // installer writes on someone's behalf.
    if (c.scope !== undefined && c.scope !== "org") {
      throw new ModuleInstallError(
        `invalid manifest: page contribution scope must be "org" — a module customizes the org, never one person`,
      );
    }
    const spec = c.spec as Record<string, unknown>;
    if (typeof spec.route === "string" && spec.route !== c.route) {
      throw new ModuleInstallError(
        `invalid manifest: page contribution for route ${c.route} carries a spec declaring route ${spec.route}`,
      );
    }
    if (seenRoutes.has(c.route)) {
      throw new ModuleInstallError(`invalid manifest: duplicate page contribution route ${c.route}`);
    }
    seenRoutes.add(c.route);
    return { kind: "page" as const, route: c.route, spec };
  });

  return {
    key: m.key,
    name: m.name,
    version: m.version,
    description,
    permissions: permissions as string[],
    contributions: valid,
  };
}

/**
 * Grants are a SUBSET of what the manifest requested: an admin may grant
 * fewer, never more. Anything outside the requested set is a caller bug and
 * fails closed here instead of persisting a grant nobody approved.
 */
function resolveGranted(manifest: ValidManifest, grantedPermissions: unknown): string[] {
  const granted = grantedPermissions ?? manifest.permissions;
  if (!Array.isArray(granted) || granted.some((p) => typeof p !== "string")) {
    throw new ModuleInstallError("invalid install: grantedPermissions must be a list of permission strings");
  }
  const requested = new Set(manifest.permissions);
  for (const p of granted as string[]) {
    if (!requested.has(p)) {
      throw new ModuleInstallError(`invalid install: granted permission "${p}" was never requested by the manifest`);
    }
  }
  return [...(granted as string[])];
}

type ModuleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  active_version_id: string | null;
  granted_permissions: string[];
};

async function writeAudit(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    event: string;
    reason: string;
    before: unknown;
    after: unknown;
    actorId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${opts.orgId}, ${opts.table}, ${opts.rowId}, ${opts.action},
            ${JSON.stringify({ event: opts.event, reason: opts.reason, before: opts.before, after: opts.after })}::jsonb,
            ${opts.actorId})`);
}

/**
 * Project one page contribution: deactivate this module's live rows for the
 * route, then insert the new row pointing at the installing version. Org rows
 * (module_version_id NULL) and other modules' rows are never touched — a
 * claimed route aborts the whole install instead.
 */
async function projectPage(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    actorId: string;
    moduleId: string;
    moduleKey: string;
    version: string;
    versionId: string;
    contribution: ValidPageContribution;
    reason: string;
  },
): Promise<string> {
  const { orgId, contribution } = opts;
  const occupants = (
    await tx.execute<{ id: string; module_version_id: string | null; module_id: string | null; module_key: string | null }>(sql`
      select s.id, s.module_version_id, v.module_id, m.key as module_key
        from page_specs s
        left join module_versions v on v.org_id = s.org_id and v.id = s.module_version_id
        left join modules m on m.org_id = v.org_id and m.id = v.module_id
       where s.org_id = ${orgId} and s.route = ${contribution.route} and s.is_active and s.user_id is null
       for update of s`)
  ).rows;

  for (const row of occupants) {
    if (row.module_version_id === null) {
      // Tenant customization always beats an installed module: the row stays
      // exactly as it was and the install fails instead of shadowing it.
      throw new ModuleInstallError(
        `route ${contribution.route} is already customized for this org (org-native layout); ` +
          `module "${opts.moduleKey}" not installed — remove the customization first`,
        409,
      );
    }
    if (row.module_id !== opts.moduleId) {
      throw new ModuleInstallError(
        `route ${contribution.route} is already projected by module "${row.module_key ?? "unknown"}" (${row.module_version_id}); ` +
          `module "${opts.moduleKey}" not installed — one module owns a route`,
        409,
      );
    }
  }

  const superseded = (
    await tx.execute<{ id: string; module_version_id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${orgId} and route = ${contribution.route} and is_active and user_id is null
         and module_version_id in (select id from module_versions where org_id = ${orgId} and module_id = ${opts.moduleId})
      returning id, module_version_id`)
  ).rows;
  for (const row of superseded) {
    await writeAudit(tx, {
      orgId,
      table: "page_specs",
      rowId: row.id,
      action: "update",
      event: "module_projection_superseded",
      reason: opts.reason,
      before: { route: contribution.route, is_active: true, module_version_id: row.module_version_id },
      after: { route: contribution.route, is_active: false, module_version_id: row.module_version_id },
      actorId: opts.actorId,
    });
  }

  const inserted = (
    await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, user_id, route, spec, note, module_version_id, created_by, updated_by)
      values (${orgId}, null, ${contribution.route}, ${JSON.stringify(contribution.spec)}::jsonb,
              ${`Projected by module "${opts.moduleKey}" version ${opts.version}`},
              ${opts.versionId}, ${opts.actorId}, ${opts.actorId})
      returning id`)
  ).rows[0]!;
  await writeAudit(tx, {
    orgId,
    table: "page_specs",
    rowId: inserted.id,
    action: "insert",
    event: "module_projection",
    reason: opts.reason,
    before: { superseded_projection_ids: superseded.map((r) => r.id) },
    after: {
      route: contribution.route,
      page_spec_id: inserted.id,
      module_version_id: opts.versionId,
      module_key: opts.moduleKey,
      version: opts.version,
    },
    actorId: opts.actorId,
  });
  return inserted.id;
}

async function applyVersion(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    actorId: string;
    module: ModuleRow | null;
    manifest: ValidManifest;
    granted: string[];
    op: "install" | "upgrade";
    reason: string;
  },
): Promise<InstallResult> {
  const { orgId, actorId, manifest, op } = opts;
  let moduleRow = opts.module;

  if (!moduleRow) {
    const inserted = (
      await tx.execute<ModuleRow>(sql`
        insert into modules (org_id, key, name, description, status, granted_permissions, created_by, updated_by)
        values (${orgId}, ${manifest.key}, ${manifest.name}, ${manifest.description},
                'installed', ${JSON.stringify(opts.granted)}::jsonb, ${actorId}, ${actorId})
        returning id, key, name, description, status, active_version_id, granted_permissions`)
    ).rows[0]!;
    moduleRow = inserted;
    await writeAudit(tx, {
      orgId,
      table: "modules",
      rowId: moduleRow.id,
      action: "insert",
      event: op === "upgrade" ? "module_upgrade" : "module_install",
      reason: opts.reason,
      before: null,
      after: {
        key: moduleRow.key,
        name: moduleRow.name,
        status: moduleRow.status,
        granted_permissions: moduleRow.granted_permissions,
      },
      actorId,
    });
  }

  const canonical = canonicalManifest(manifest);
  const canonicalJson = JSON.stringify(canonical);
  const existingVersion = (
    await tx.execute<{ id: string; status: string; manifest: unknown }>(sql`
      select id, status, manifest from module_versions
       where org_id = ${orgId} and module_id = ${moduleRow.id} and version = ${manifest.version}
       for update`)
  ).rows[0];

  let versionId: string;
  let preexistingVersion = false;
  if (existingVersion) {
    // Append-only history: a label that ran before keeps its bytes. The same
    // bytes re-converge (reinstall, reactivation); different bytes are a new
    // version wearing an old label and are refused.
    if (stableStringify(existingVersion.manifest) !== stableStringify(canonical)) {
      throw new ModuleInstallError(
        `version ${manifest.version} of module "${manifest.key}" already exists with a different manifest; ` +
          `append a new version instead`,
        409,
      );
    }
    versionId = existingVersion.id;
    preexistingVersion = true;
  } else {
    versionId = (
      await tx.execute<{ id: string }>(sql`
        insert into module_versions (org_id, module_id, version, manifest, status, created_by, updated_by)
        values (${orgId}, ${moduleRow.id}, ${manifest.version}, ${canonicalJson}::jsonb, 'active', ${actorId}, ${actorId})
        returning id`)
    ).rows[0]!.id;
    await writeAudit(tx, {
      orgId,
      table: "module_versions",
      rowId: versionId,
      action: "insert",
      event: op === "upgrade" ? "module_version_upgrade" : "module_version_install",
      reason: opts.reason,
      before: null,
      after: { module_key: manifest.key, version: manifest.version, status: "active" },
      actorId,
    });
  }

  // True idempotence: already installed, active, same bytes, same grants —
  // converge without writing. Anything else re-projects append-style below.
  const grantsEqual =
    JSON.stringify([...moduleRow.granted_permissions].sort()) === JSON.stringify([...opts.granted].sort());
  if (
    preexistingVersion &&
    moduleRow.status === "installed" &&
    moduleRow.active_version_id === versionId &&
    existingVersion!.status === "active" &&
    grantsEqual
  ) {
    return { moduleId: moduleRow.id, versionId, outcome: "already-installed" };
  }

  await tx.execute(sql`
    update modules
       set name = ${manifest.name}, description = ${manifest.description},
           granted_permissions = ${JSON.stringify(opts.granted)}::jsonb,
           status = 'installed', active_version_id = ${versionId},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${moduleRow.id}`);
  await writeAudit(tx, {
    orgId,
    table: "modules",
    rowId: moduleRow.id,
    action: "update",
    event: op === "upgrade" ? "module_upgrade" : "module_install",
    reason: opts.reason,
    before: {
      name: moduleRow.name,
      status: moduleRow.status,
      active_version_id: moduleRow.active_version_id,
      granted_permissions: moduleRow.granted_permissions,
    },
    after: {
      name: manifest.name,
      status: "installed",
      active_version_id: versionId,
      granted_permissions: opts.granted,
    },
    actorId,
  });

  if (!preexistingVersion || existingVersion!.status !== "active") {
    await tx.execute(sql`
      update module_versions set status = 'active', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${versionId}`);
  }
  const supersededVersions = (
    await tx.execute<{ id: string; version: string }>(sql`
      update module_versions set status = 'superseded', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and module_id = ${moduleRow.id} and id <> ${versionId} and status = 'active'
      returning id, version`)
  ).rows;
  for (const row of supersededVersions) {
    await writeAudit(tx, {
      orgId,
      table: "module_versions",
      rowId: row.id,
      action: "update",
      event: "module_version_superseded",
      reason: opts.reason,
      before: { version: row.version, status: "active" },
      after: { version: row.version, status: "superseded", superseded_by: versionId },
      actorId,
    });
  }

  for (const contribution of manifest.contributions) {
    await projectPage(tx, {
      orgId,
      actorId,
      moduleId: moduleRow.id,
      moduleKey: manifest.key,
      version: manifest.version,
      versionId,
      contribution,
      reason: opts.reason,
    });
  }

  return { moduleId: moduleRow.id, versionId, outcome: preexistingVersion ? "reactivated" : "installed" };
}

/**
 * Install a module version: validate, upsert the module row on
 * (org_id, key), append (or re-converge) the immutable version row, project
 * every page contribution, and audit each write — all in ONE transaction.
 *
 * Idempotent: reinstalling the identical manifest (same bytes, same grants,
 * already active) writes nothing and reports `already-installed`. Reinstalling
 * after an uninstall re-projects append-style and reports `reactivated`.
 */
export async function installModule(opts: {
  orgId: string;
  actorId: string;
  /** Raw manifest: validate canonically with parseModuleManifest first; the installer enforces the boundary again. */
  manifest: unknown;
  /** Admin-chosen grants, defaulting to everything requested. Must be a subset of requested. */
  grantedPermissions?: string[];
  /** Why: recorded on every audit row this install writes. */
  reason?: string;
}): Promise<InstallResult> {
  const manifest = validateManifest(opts.manifest);
  const granted = resolveGranted(manifest, opts.grantedPermissions);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "install";
  return await db.transaction(async (tx) => {
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${manifest.key}
          for update`)
    ).rows[0] ?? null;
    return await applyVersion(tx, {
      orgId: opts.orgId,
      actorId: opts.actorId,
      module: moduleRow,
      manifest,
      granted,
      op: "install",
      reason,
    });
  });
}

/**
 * Upgrade an installed module to a NEW version label: appends the immutable
 * version row and re-projects. The module must already exist (use install for
 * first contact) and the label must be new (history is append-only; to
 * re-converge an existing label, install it).
 */
export async function upgradeModule(opts: {
  orgId: string;
  actorId: string;
  key: string;
  manifest: unknown;
  grantedPermissions?: string[];
  reason?: string;
}): Promise<InstallResult> {
  const manifest = validateManifest(opts.manifest);
  if (manifest.key !== opts.key) {
    throw new ModuleInstallError(
      `upgrade target is module "${opts.key}" but the manifest declares "${manifest.key}"`,
    );
  }
  const granted = resolveGranted(manifest, opts.grantedPermissions);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "upgrade";
  return await db.transaction(async (tx) => {
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${opts.key}
          for update`)
    ).rows[0] ?? null;
    if (!moduleRow) {
      throw new ModuleInstallError(`module "${opts.key}" is not installed; install it before upgrading`, 404);
    }
    const duplicate = (
      await tx.execute<{ id: string }>(sql`
        select id from module_versions
         where org_id = ${opts.orgId} and module_id = ${moduleRow.id} and version = ${manifest.version}
         limit 1`)
    ).rows[0];
    if (duplicate) {
      throw new ModuleInstallError(
        `version ${manifest.version} of module "${opts.key}" already exists; an upgrade appends a new version`,
        409,
      );
    }
    return await applyVersion(tx, {
      orgId: opts.orgId,
      actorId: opts.actorId,
      module: moduleRow,
      manifest,
      granted,
      op: "upgrade",
      reason,
    });
  });
}

/**
 * Uninstall a module: deactivate its projected rows, never delete them. The
 * module row flips to `disabled` (keeping active_version_id as the
 * last-active pointer so a reinstall re-converges), every projection row
 * stays readable for history and audit, and every transition is audited with
 * before/after and reason. Unknown keys are a no-op, mirroring deleteApp.
 */
export async function uninstallModule(opts: {
  orgId: string;
  actorId: string;
  key: string;
  reason?: string;
}): Promise<UninstallResult> {
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "uninstall";
  return await db.transaction(async (tx) => {
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${opts.key}
          for update`)
    ).rows[0] ?? null;
    if (!moduleRow) return { moduleId: null, deactivatedProjections: 0 };

    const withdrawn = (
      await tx.execute<{ id: string; route: string; module_version_id: string }>(sql`
        update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
         where org_id = ${opts.orgId} and is_active
           and module_version_id in (select id from module_versions where org_id = ${opts.orgId} and module_id = ${moduleRow.id})
        returning id, route, module_version_id`)
    ).rows;
    for (const row of withdrawn) {
      await writeAudit(tx, {
        orgId: opts.orgId,
        table: "page_specs",
        rowId: row.id,
        action: "update",
        event: "module_projection_withdrawn",
        reason,
        before: { route: row.route, is_active: true, module_version_id: row.module_version_id },
        after: { route: row.route, is_active: false, module_version_id: row.module_version_id },
        actorId: opts.actorId,
      });
    }

    if (moduleRow.status !== "disabled") {
      await tx.execute(sql`
        update modules set status = 'disabled', updated_at = now(), updated_by = ${opts.actorId}
         where org_id = ${opts.orgId} and id = ${moduleRow.id}`);
      await writeAudit(tx, {
        orgId: opts.orgId,
        table: "modules",
        rowId: moduleRow.id,
        action: "update",
        event: "module_uninstall",
        reason,
        before: { key: moduleRow.key, status: moduleRow.status, active_version_id: moduleRow.active_version_id },
        after: { key: moduleRow.key, status: "disabled", active_version_id: moduleRow.active_version_id },
        actorId: opts.actorId,
      });
    }
    return { moduleId: moduleRow.id, deactivatedProjections: withdrawn.length };
  });
}
