import { actorHasPermission } from "../actor-permissions.ts";
import { pageSpecSchema } from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { isCataloguePermission } from "../permissions.ts";
import { MODULE_PLATFORM_PERMISSIONS_MIRROR, isModulePermission } from "./module-catalogue.ts";
import { supplementalContributionSchema, type SupplementalContribution } from "./contribution-schemas.ts";
import { CONTRIBUTION_PERMISSIONS, projectSupplementalContributions, withdrawSupplementalContributions } from "./projections.ts";
import { assertModuleApproval } from "./approval-proof.ts";
import { ModuleCapabilityError, assertModulePermitted, resolveModuleGrants } from "./capabilities.ts";

/**
 * Atomic module installation: immutable version append, page/navigation/settings/
 * permission projection, signed approval proof, and complete audit evidence.
 * Engine-owned schemas and the shared navigation registry are the persistence
 * boundary; unknown contribution kinds fail before any write. All lifecycle
 * operations serialize by organization to protect projection ownership.
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
  contributions: (ValidPageContribution | SupplementalContribution)[];
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

/** The exact document a version row carries; what approvals grant and audit keeps verbatim.
 * Optional descriptions normalize to absence, yielding deterministic approval,
 * version, diff and rollback bytes across read/write cycles. */
function canonicalManifest(m: ValidManifest): Omit<ValidManifest, "description"> & { description?: string } {
  return {
    key: m.key,
    name: m.name,
    version: m.version,
    ...(m.description != null ? { description: m.description } : {}),
    permissions: m.permissions,
    contributions: m.contributions.map((c) => c.kind === "page" ? { ...c, scope: "org" } : c),
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
  // OUTER backstop (engine-closed): the platform catalogue. No caller input
  // influences this check. Concrete names only: wildcards live in effective
  // sets, never in manifests.
  for (const p of permissions as string[]) {
    if (!isCataloguePermission(p)) {
      throw new ModuleInstallError(`invalid manifest: unknown permission: ${p}`);
    }
  }
  // INNER vocabulary check (engine-closed): the module vocabulary mirror.
  // Requested names pass the platform catalogue above yet mean nothing to
  // the module surface unless they are vocabulary members. There is no
  // catalogue parameter to lie about — the boundary reads its own mirror.
  for (const p of permissions as string[]) {
    if (!isModulePermission(p)) {
      throw new ModuleInstallError(`invalid manifest: permission "${p}" is outside the module vocabulary`);
    }
  }
  const contributions = m.contributions ?? [];
  if (!Array.isArray(contributions) || contributions.length > MAX_CONTRIBUTIONS) {
    throw new ModuleInstallError("invalid manifest: contributions must be a list of at most 200 entries");
  }

  const seenRoutes = new Set<string>();
  const seenSupplemental = new Set<string>();
  const valid: ValidManifest["contributions"] = contributions.map((rawContribution, i) => {
    if (typeof rawContribution !== "object" || rawContribution === null || Array.isArray(rawContribution)) {
      throw new ModuleInstallError(`invalid manifest: contributions[${i}] must be an object`);
    }
    const c = rawContribution as Record<string, unknown>;
    if (c.kind !== "page") {
      const parsed = supplementalContributionSchema.safeParse(c);
      if (!parsed.success) throw new ModuleInstallError(`contribution kind "${String(c.kind)}" is not projectable yet or invalid: ${parsed.error.message}`);
      const contribution = parsed.data;
      const identity = `${contribution.kind}:${contribution.kind === "nav" ? contribution.href : contribution.key}`;
      if (seenSupplemental.has(identity)) throw new ModuleInstallError(`duplicate contribution ${identity}`);
      seenSupplemental.add(identity);
      const required = CONTRIBUTION_PERMISSIONS[contribution.kind];
      if (!permissions.includes(required)) throw new ModuleInstallError(`${contribution.kind} contribution requires requested permission ${required}`);
      return contribution;
    }
    if (typeof c.route !== "string" || !ROUTE.test(c.route) || c.route.length > 120) {
      throw new ModuleInstallError(
        `invalid manifest: page contribution ${i} route must be an absolute route pattern of at most 120 chars`,
      );
    }
    // Canonical strictness at the boundary: the same pageSpecSchema object
    // the manifest validator uses. The stored spec is the schema's output,
    // so installer-persisted bytes equal validator-accepted bytes.
    const parsedSpec = pageSpecSchema.safeParse(c.spec);
    if (!parsedSpec.success) {
      const detail = parsedSpec.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ModuleInstallError(
        `invalid manifest: page contribution for route ${c.route} has an invalid spec: ${detail}`,
      );
    }
    // A module version is org-wide by definition: reviewed and approved once
    // for everyone. `user` is a personal preference, never something an
    // installer writes on someone's behalf.
    if (c.scope !== undefined && c.scope !== "org") {
      throw new ModuleInstallError(
        `invalid manifest: page contribution scope must be "org" — a module customizes the org, never one person`,
      );
    }
    if (typeof parsedSpec.data.route === "string" && parsedSpec.data.route !== c.route) {
      throw new ModuleInstallError(
        `invalid manifest: page contribution for route ${c.route} carries a spec declaring route ${parsedSpec.data.route}`,
      );
    }
    if (seenRoutes.has(c.route)) {
      throw new ModuleInstallError(`invalid manifest: duplicate page contribution route ${c.route}`);
    }
    seenRoutes.add(c.route);
    return { kind: "page" as const, route: c.route, spec: parsedSpec.data as unknown as Record<string, unknown> };
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

export function validateModuleInstallManifest(raw: unknown): Omit<ValidManifest, "description"> & { description?: string } {
  return canonicalManifest(validateManifest(raw));
}

/**
 * Persistence-boundary text: a SQL parameter must never be `undefined` —
 * drizzle renders an undefined parameter as empty text, so an optional that
 * slips through as undefined turns `values (..., ..., ...)` into
 * `values (..., , ...)` and the install dies as a raw DrizzleQueryError
 * (`syntax error at or near ","`) instead of a named ModuleInstallError.
 * Validation normalizes every optional to null today; this coerces at the
 * boundary anyway so no future ValidManifest construction path can
 * reintroduce the crash class.
 */
function nullableText(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Grant resolution through the capability lattice: approvals beyond the
 * request fail closed, and the recorded grant is approved ∩ requested ∩ the
 * installer's effective set, checked against the engine vocabulary mirror.
 * Requested names outside the mirror never reach the lattice (the manifest
 * boundary refuses them first). Lattice errors surface as ModuleInstallError —
 * raw lattice codes never reach callers.
 */
function resolveGranted(
  manifest: ValidManifest,
  opts: {
    grantedPermissions?: unknown;
    installerEffectivePermissions: readonly string[];
  },
): { granted: string[]; withheld: string[] } {
  const approved = opts.grantedPermissions ?? manifest.permissions;
  if (!Array.isArray(approved) || approved.some((p) => typeof p !== "string")) {
    throw new ModuleInstallError("invalid install: grantedPermissions must be a list of permission strings");
  }
  // Authority is mandatory: no default effective set, no undefined path.
  // A caller that cannot state its authority must not install.
  if (
    !opts.installerEffectivePermissions ||
    !Array.isArray(opts.installerEffectivePermissions) ||
    opts.installerEffectivePermissions.some((p) => typeof p !== "string")
  ) {
    throw new ModuleInstallError(
      "invalid install: installerEffectivePermissions (the installing actor's resolved permission set) is required",
    );
  }
  try {
    return resolveModuleGrants({
      requested: manifest.permissions,
      approved: approved as string[],
      installerEffective: opts.installerEffectivePermissions,
      knownPermissions: MODULE_PLATFORM_PERMISSIONS_MIRROR,
    });
  } catch (error) {
    if (error instanceof ModuleCapabilityError) {
      throw new ModuleInstallError(`invalid install: ${error.message}`, 400);
    }
    throw error;
  }
}

type ModuleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  kind: "module" | "app";
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
 * route, then insert the new row pointing at the installing version.
 * Org-native tenant rows (module_version_id NULL) live under their own
 * partial index (0111) and are never touched — they shadow this projection
 * by read-time precedence (user > org-native > module > built-in) instead
 * of blocking it, and a tenant clear falls back to this row naturally.
 * Other modules' rows still refuse: one module owns a route.
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
  // Module rows only: org-native layouts coexist (see above) so they are
  // not occupants here. The FOR UPDATE lock serializes same-route installs
  // of module rows against each other for the check below.
  const occupants = (
    await tx.execute<{ id: string; module_version_id: string | null; module_id: string | null; module_key: string | null }>(sql`
      select s.id, s.module_version_id, v.module_id, m.key as module_key
        from page_specs s
        left join module_versions v on v.org_id = s.org_id and v.id = s.module_version_id
        left join modules m on m.org_id = v.org_id and m.id = v.module_id
       where s.org_id = ${orgId} and s.route = ${contribution.route} and s.is_active and s.user_id is null
         and s.module_version_id is not null
       for update of s`)
  ).rows;

  for (const row of occupants) {
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

  // A concurrent identical install may have projected this route between
  // our occupant check and this insert; converge on its row instead of
  // leaking a raw unique violation. The arbiter is the 0111 module partial
  // index — one live row per module VERSION per route — so a conflict here
  // can only be this same version's row, never the org-native row (its own
  // partial index) and never a superseded version (a different version id).
  const inserted = (
    await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, user_id, route, spec, note, module_version_id, created_by, updated_by)
      values (${orgId}, null, ${contribution.route}, ${JSON.stringify(contribution.spec)}::jsonb,
              ${`Projected by module "${opts.moduleKey}" version ${opts.version}`},
              ${opts.versionId}, ${opts.actorId}, ${opts.actorId})
      on conflict (org_id, route, module_version_id) where (is_active and module_version_id is not null) do nothing
      returning id`)
  ).rows[0] ?? null;
  if (!inserted) {
    const live = (
      await tx.execute<{ id: string; module_version_id: string; spec: unknown }>(sql`
        select id, module_version_id, spec from page_specs
         where org_id = ${orgId} and route = ${contribution.route} and is_active and user_id is null
           and module_version_id = ${opts.versionId}
         limit 1`)
    ).rows[0];
    if (
      live &&
      live.module_version_id === opts.versionId &&
      stableStringify(live.spec) === stableStringify(contribution.spec)
    ) {
      // Identical bytes already projected (the concurrent install won the
      // race); its audit row covers this projection, so converge silently.
      return live.id;
    }
    // Unreachable through the version gate above (same label with different
    // bytes is refused before any projection): a live row for this version
    // carrying other bytes is a hard conflict, never a silent share.
    throw new ModuleInstallError(
      `route ${contribution.route} already has a different live projection for this version; ` +
        `module "${opts.moduleKey}" not installed`,
      409,
    );
  }
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
    grants: { granted: string[]; withheld: string[] };
    op: "install" | "upgrade";
    reason: string;
  },
): Promise<InstallResult> {
  const { orgId, actorId, manifest, op } = opts;
  let moduleRow = opts.module;
  if (moduleRow && moduleRow.kind !== "module") throw new ModuleInstallError("This key belongs to an app; manage its lifecycle through Apps", 409);

  // Insert-first: a first-install SELECT ... FOR UPDATE locks nothing, so
  // two concurrent identical installs would both INSERT and the loser would
  // eat a raw 23505. ON CONFLICT DO NOTHING serializes them on the unique
  // key instead; the loser re-selects the winner's row below and converges
  // to already-installed instead of throwing.
  const createdModule = (
    await tx.execute<{ id: string }>(sql`
      insert into modules (org_id, key, name, description, status, granted_permissions, created_by, updated_by)
      values (${orgId}, ${manifest.key}, ${manifest.name}, ${nullableText(manifest.description)},
              'installed', ${JSON.stringify(opts.grants.granted)}::jsonb, ${actorId}, ${actorId})
      on conflict (org_id, key) do nothing
      returning id`)
  ).rows[0] ?? null;
  if (!moduleRow) {
    moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, kind, active_version_id, granted_permissions
          from modules where org_id = ${orgId} and key = ${manifest.key}
          for update`)
    ).rows[0]!;
  }
  if (moduleRow.kind !== "module") throw new ModuleInstallError("This key belongs to an app; manage its lifecycle through Apps", 409);
  if (createdModule) {
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
        withheld_permissions: opts.grants.withheld,
      },
      actorId,
    });
  }

  const canonical = canonicalManifest(manifest);
  const canonicalJson = JSON.stringify(canonical);
  type VersionRow = { id: string; status: string; manifest: unknown };
  // Same insert-first convergence as the module row: concurrent identical
  // installs serialize on (module_id, version); the loser re-selects.
  const createdVersion = (
    await tx.execute<{ id: string }>(sql`
      insert into module_versions (org_id, module_id, version, manifest, status, created_by, updated_by)
      values (${orgId}, ${moduleRow.id}, ${manifest.version}, ${canonicalJson}::jsonb, 'active', ${actorId}, ${actorId})
      on conflict (module_id, version) do nothing
      returning id`)
  ).rows[0] ?? null;
  const existingVersion: VersionRow | undefined = createdVersion
    ? { id: createdVersion.id, status: "active", manifest: canonical }
    : (
        await tx.execute<VersionRow>(sql`
          select id, status, manifest from module_versions
           where org_id = ${orgId} and module_id = ${moduleRow.id} and version = ${manifest.version}
           for update`)
      ).rows[0];

  let versionId: string;
  let preexistingVersion = false;
  if (createdVersion) {
    versionId = createdVersion.id;
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
  } else if (existingVersion) {
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
    if (existingVersion.status !== "active" || moduleRow.active_version_id !== existingVersion.id) {
      throw new ModuleInstallError("A historical module version cannot be reactivated; append a restoring version through rollback", 409);
    }
    versionId = existingVersion.id;
    preexistingVersion = true;
  } else {
    // Unreachable: the insert either wrote or another transaction holds the
    // key. A named error rather than a downstream TypeError, fail-closed.
    throw new ModuleInstallError(
      `version ${manifest.version} of module "${manifest.key}" could not be recorded`,
      500,
    );
  }

  // True idempotence: already installed, active, same bytes, same grants —
  // converge without writing. Anything else re-projects append-style below.
  const grantsEqual =
    JSON.stringify([...moduleRow.granted_permissions].sort()) === JSON.stringify([...opts.grants.granted].sort());
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
       set name = ${manifest.name}, description = ${nullableText(manifest.description)},
           granted_permissions = ${JSON.stringify(opts.grants.granted)}::jsonb,
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
      granted_permissions: opts.grants.granted,
      withheld_permissions: opts.grants.withheld,
    },
    actorId,
  });

  if (preexistingVersion && existingVersion!.status !== "active") {
    // Convergent reinstall of a superseded version: the flip back to active
    // is a lifecycle transition and is audited exactly like the others —
    // actor, timestamp, before/after, reason. (2b owns transition policy and
    // may restrict reinstall; visibility via audit is this slice's bar.)
    await tx.execute(sql`
      update module_versions set status = 'active', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${versionId}`);
    await writeAudit(tx, {
      orgId,
      table: "module_versions",
      rowId: versionId,
      action: "update",
      event: "module_version_reactivated",
      reason: opts.reason,
      before: { version: manifest.version, status: existingVersion!.status },
      after: { version: manifest.version, status: "active" },
      actorId,
    });
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

  // Routes the new manifest drops: withdraw this module's live rows for
  // them. Scoped strictly by this module's version ids — org-native rows
  // (module_version_id NULL) and other modules' rows can never match — and
  // every withdrawal writes its audit row like any other projection.
  const newRoutes = manifest.contributions.filter((c) => c.kind === "page").map((c) => c.route);
  const withdrawnStale = (
    await tx.execute<{ id: string; route: string; module_version_id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and is_active and user_id is null
         and module_version_id in (select id from module_versions where org_id = ${orgId} and module_id = ${moduleRow.id})
         and (${newRoutes.length === 0 ? sql`true` : sql`route not in (${sql.join(newRoutes.map((r) => sql`${r}`), sql`, `)})`})
      returning id, route, module_version_id`)
  ).rows;
  for (const row of withdrawnStale) {
    await writeAudit(tx, {
      orgId,
      table: "page_specs",
      rowId: row.id,
      action: "update",
      event: "module_projection_withdrawn",
      reason: opts.reason,
      before: { route: row.route, is_active: true, module_version_id: row.module_version_id },
      after: {
        route: row.route,
        is_active: false,
        module_version_id: row.module_version_id,
        withdrawn_in_version: manifest.version,
      },
      actorId,
    });
  }

  try {
    await projectSupplementalContributions(tx, { orgId, actorId, moduleId: moduleRow.id, moduleKey: manifest.key, versionId, previousVersionId: moduleRow.active_version_id, contributions: manifest.contributions.filter((c) => c.kind !== "page"), reason: opts.reason });
  } catch (error) { throw new ModuleInstallError(error instanceof Error ? error.message : "Module projection refused", 409); }

  for (const contribution of manifest.contributions) {
    if (contribution.kind !== "page") continue;
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
  /** Raw manifest: caller pre-validation with parseModuleManifest is a fast path; the installer enforces canonical strictness itself. */
  manifest: unknown;
  /** Admin-chosen grants, defaulting to everything requested. Must be a subset of requested. */
  grantedPermissions?: string[];
  /**
   * The installing actor's resolved permission set. Required, no default:
   * the recorded grant is approved ∩ requested ∩ effective, and a caller
   * that cannot state its authority must not install.
   */
  installerEffectivePermissions: readonly string[];
  approvalRunId?: string;
  rehearsalProductionOrgId?: string;
  /** Why: recorded on every audit row this install writes. */
  reason?: string;
}): Promise<InstallResult> {
  const manifest = validateManifest(opts.manifest);
  const grants = resolveGranted(manifest, opts);
  try {
  for (const contribution of manifest.contributions) if (contribution.kind !== "page") assertModulePermitted({ grantedPermissions: grants.granted, installerEffectivePermissions: opts.installerEffectivePermissions, requiredPermission: CONTRIBUTION_PERMISSIONS[contribution.kind] });
  } catch (error) { throw new ModuleInstallError(error instanceof Error ? error.message : "Projection capability denied", 403); }
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "install";
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`module-projections:${opts.orgId}`}, 0))`);
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, kind, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${manifest.key}
          for update`)
    ).rows[0] ?? null;
    try {
      await assertModuleApproval(tx, { orgId: opts.orgId, actorId: opts.actorId, manifest: canonicalManifest(manifest), approvalRunId: opts.approvalRunId, rehearsalProductionOrgId: opts.rehearsalProductionOrgId, grants: grants.granted });
    } catch (error) { throw new ModuleInstallError(error instanceof Error ? error.message : "Module approval required", 403); }
    return await applyVersion(tx, {
      orgId: opts.orgId,
      actorId: opts.actorId,
      module: moduleRow,
      manifest,
      grants,
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
  /**
   * The installing actor's resolved permission set. Required, no default:
   * the recorded grant is approved ∩ requested ∩ effective, and a caller
   * that cannot state its authority must not install.
   */
  installerEffectivePermissions: readonly string[];
  approvalRunId?: string;
  rehearsalProductionOrgId?: string;
  reason?: string;
}): Promise<InstallResult> {
  const manifest = validateManifest(opts.manifest);
  if (manifest.key !== opts.key) {
    throw new ModuleInstallError(
      `upgrade target is module "${opts.key}" but the manifest declares "${manifest.key}"`,
    );
  }
  const grants = resolveGranted(manifest, opts);
  try {
  for (const contribution of manifest.contributions) if (contribution.kind !== "page") assertModulePermitted({ grantedPermissions: grants.granted, installerEffectivePermissions: opts.installerEffectivePermissions, requiredPermission: CONTRIBUTION_PERMISSIONS[contribution.kind] });
  } catch (error) { throw new ModuleInstallError(error instanceof Error ? error.message : "Projection capability denied", 403); }
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "upgrade";
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`module-projections:${opts.orgId}`}, 0))`);
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, kind, active_version_id, granted_permissions
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
    try {
      await assertModuleApproval(tx, { orgId: opts.orgId, actorId: opts.actorId, manifest: canonicalManifest(manifest), approvalRunId: opts.approvalRunId, rehearsalProductionOrgId: opts.rehearsalProductionOrgId, grants: grants.granted });
    } catch (error) { throw new ModuleInstallError(error instanceof Error ? error.message : "Module approval required", 403); }
    return await applyVersion(tx, {
      orgId: opts.orgId,
      actorId: opts.actorId,
      module: moduleRow,
      manifest,
      grants,
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`module-projections:${opts.orgId}`}, 0))`);
    if (!(await actorHasPermission(tx, opts.orgId, opts.actorId, "admin.customization.manage"))) throw new ModuleInstallError("admin.customization.manage required", 403);
    const moduleRow = (
      await tx.execute<ModuleRow>(sql`
        select id, key, name, description, status, kind, active_version_id, granted_permissions
          from modules where org_id = ${opts.orgId} and key = ${opts.key}
          for update`)
    ).rows[0] ?? null;
    if (!moduleRow) return { moduleId: null, deactivatedProjections: 0 };
    if (moduleRow.kind !== "module") throw new ModuleInstallError("This key belongs to an app; manage its lifecycle through Apps", 409);

    const supplementalWithdrawn = await withdrawSupplementalContributions(tx, { orgId: opts.orgId, actorId: opts.actorId, moduleId: moduleRow.id, moduleKey: moduleRow.key, reason });
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
    return { moduleId: moduleRow.id, deactivatedProjections: withdrawn.length + supplementalWithdrawn };
  });
}
