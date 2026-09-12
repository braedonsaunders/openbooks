import { sql } from "drizzle-orm";
import { db, withOrg, type SqlExecutor } from "../db.ts";
import { upgradeModule } from "./installer.ts";
import {
  markVersionRolledBack,
  requestModuleUpgradeApproval,
  type ModuleApprovalAssignee,
  type ModuleApprovalRequest,
} from "./lifecycle.ts";

/**
 * Signed apply + append-only rollback for modules.
 *
 * Rollback mirrors page-layout restore (web/lib/page-specs.ts:
 * restorePageSpec): history is never rewritten. A rollback APPENDS a new
 * module_versions row carrying the exact bytes the target version ran,
 * re-projects through the installer (the sole projection writer — validation,
 * grant re-assertion, supersession, and projection audit all come from it),
 * marks the replaced version rolled back, and audits the rollback itself
 * with actor/before/after/reason. The target row is never edited in place
 * (the 0107 immutability trigger would refuse it anyway); it stays
 * addressable as the evidence for what ran before.
 *
 * Signed apply reuses the flows gates' signatureRequired seam end to end:
 * requestRollbackApproval stages the restoring version behind a real
 * flow_gates row (subject_kind 'module_version'), and the existing
 * decideModuleApproval → decideGate path enforces the typed attestation —
 * no local signature check exists to drift from it. Capability-bearing
 * restoring versions default to signature-required; page-only restores do
 * not demand a signature they have no authority behind.
 *
 * Org isolation is by explicit org_id predicates on every statement; RLS
 * enforces it again at storage. Callers run under the org's request context
 * (or another trusted boundary such as the test bypass).
 */

export class ModuleRollbackError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModuleRollbackError";
    this.status = status;
  }
}

/** Storage-shape semver (0107 CHECK): 1, 1.0, or 1.0.0 with optional -tag. */
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/;

/**
 * Whether applying this version demands the approver's typed signature.
 * Capability-bearing versions (any requested permission) do; page-only
 * versions carry no authority worth attesting and self-apply with audit.
 */
export function moduleApplyRequiresSignature(manifest: {
  permissions?: unknown;
}): boolean {
  return (
    Array.isArray(manifest?.permissions) && manifest.permissions.length > 0
  );
}

type ModuleRow = {
  id: string;
  kind: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  active_version_id: string | null;
  granted_permissions: string[];
};

type VersionRow = {
  id: string;
  version: string;
  status: string;
  manifest: unknown;
};

export interface RollbackResult {
  moduleId: string;
  /** The appended restoring version (new row, target's bytes, new label). */
  versionId: string;
  restoringVersion: string;
  /** The superseded version whose bytes were restored. */
  restoredFromVersionId: string;
  restoredFromVersion: string;
  /** The previously-live version, now marked rolled back. */
  replacedVersionId: string;
}

export interface RollbackApprovalRequest extends ModuleApprovalRequest {
  restoredFrom: { versionId: string; version: string };
  replacedVersionId: string;
  signatureRequired: boolean;
}

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

function checkRestoringLabel(restoringVersion: unknown): string {
  if (
    typeof restoringVersion !== "string" ||
    restoringVersion.length > 32 ||
    !VERSION.test(restoringVersion)
  ) {
    throw new ModuleRollbackError(
      "invalid rollback: restoringVersion must look like 1.0.1",
    );
  }
  return restoringVersion;
}

async function lockModule(
  tx: SqlExecutor,
  orgId: string,
  key: string,
): Promise<ModuleRow | null> {
  return (
    (
      await tx.execute<ModuleRow>(sql`
      select id, kind, key, name, description, status, active_version_id, granted_permissions
        from modules where org_id = ${orgId} and key = ${key}
        for update`)
    ).rows[0] ?? null
  );
}

async function listVersions(
  tx: SqlExecutor,
  orgId: string,
  moduleId: string,
): Promise<VersionRow[]> {
  return (
    await tx.execute<VersionRow>(sql`
      select id, version, status, manifest from module_versions
       where org_id = ${orgId} and module_id = ${moduleId}
       order by created_at desc`)
  ).rows;
}

/**
 * Resolve the version to restore, enforcing every refusal. The target must
 * be a SUPERSEDED version of this module: the live version cannot be
 * "rolled back to" (it is already rendering), a rolled-back or pending
 * version was never live under these bytes, and a foreign id is not a
 * version of this module at all. Refusals throw before anything writes.
 */
function resolveTarget(
  versions: VersionRow[],
  moduleKey: string,
  activeVersionId: string,
  targetVersionId: string | null | undefined,
): VersionRow {
  if (targetVersionId !== undefined && targetVersionId !== null) {
    const target = versions.find((v) => v.id === targetVersionId);
    if (!target) {
      throw new ModuleRollbackError(
        `version ${targetVersionId} is not a version of module "${moduleKey}"`,
        404,
      );
    }
    if (target.id === activeVersionId) {
      throw new ModuleRollbackError(
        `version ${target.version} is already the live version of module "${moduleKey}"; ` +
          `a rollback restores an earlier version, never the live one`,
        409,
      );
    }
    if (target.status === "rolled_back") {
      throw new ModuleRollbackError(
        `version ${target.version} was already rolled back; restore a superseded version instead`,
        409,
      );
    }
    if (target.status !== "superseded") {
      throw new ModuleRollbackError(
        `version ${target.version} is ${target.status}; only a superseded version can be rolled back to`,
        409,
      );
    }
    return target;
  }
  const target = versions.find(
    (v) => v.id !== activeVersionId && v.status === "superseded",
  );
  if (!target) {
    throw new ModuleRollbackError(
      `module "${moduleKey}" has no earlier version to roll back to`,
      409,
    );
  }
  return target;
}

function assertModuleRollable(
  moduleRow: ModuleRow | null,
  key: string,
): ModuleRow {
  if (!moduleRow) {
    throw new ModuleRollbackError(`module "${key}" is not installed`, 404);
  }
  if (moduleRow.kind !== "module") throw new ModuleRollbackError("app-backed modules use the Apps lifecycle", 409);
  if (moduleRow.status === "disabled") {
    throw new ModuleRollbackError(
      `module "${key}" is disabled; reactivate it before rolling back`,
      409,
    );
  }
  if (moduleRow.status !== "installed") {
    throw new ModuleRollbackError(
      `module "${key}" is ${moduleRow.status}, not installed`,
      409,
    );
  }
  if (!moduleRow.active_version_id) {
    throw new ModuleRollbackError(
      `module "${key}" has no live version to roll back from`,
      409,
    );
  }
  return moduleRow;
}

/**
 * The restoring document: the target's RECORDED bytes verbatim, relabeled.
 * The installer re-validates it at apply time (fail-closed: a target row
 * whose bytes no longer validate fails LOUDLY, never half-applies), and
 * because the label is new the apply always appends — convergence on the
 * target's own row is impossible, so history only grows.
 */
function restoringManifest(
  target: VersionRow,
  restoringVersion: string,
): Record<string, unknown> {
  if (
    typeof target.manifest !== "object" ||
    target.manifest === null ||
    Array.isArray(target.manifest)
  ) {
    throw new ModuleRollbackError(
      `version ${target.version} carries a corrupt manifest; refusing to restore it`,
      500,
    );
  }
  return {
    ...(target.manifest as Record<string, unknown>),
    version: restoringVersion,
  };
}

/**
 * Roll back a module to an earlier version, append-style. The caller must
 * already hold the authority to change this module's lifecycle (the admin
 * drawer one-click path confirms via promptDialog before calling): this is
 * the engine write, not the permission check.
 *
 * The recorded grant is re-asserted EXACTLY (mirroring lifecycle
 * reactivateModule): narrowing a grant is a new approval, not a rollback.
 */
export async function rollbackModuleVersion(opts: {
  orgId: string;
  actorId: string;
  key: string;
  /** Restore this version; defaults to the most recent superseded version. */
  targetVersionId?: string | null;
  /** Label for the appended restoring version. Must be new (history is append-only). */
  restoringVersion: string;
  /** Why: recorded on every audit row this rollback writes. */
  reason?: string;
}): Promise<RollbackResult> {
  const restoringVersion = checkRestoringLabel(opts.restoringVersion);
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "rollback";
  return await withOrg(opts.orgId, async () => {
    const tx = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    // The module row lock serializes concurrent rollbacks of the same
    // module; the installer (savepoint below) serializes the projection
    // writes against concurrent installs.
    const moduleRow = assertModuleRollable(
      await lockModule(tx, opts.orgId, opts.key),
      opts.key,
    );
    const activeVersionId = moduleRow.active_version_id!;
    const versions = await listVersions(tx, opts.orgId, moduleRow.id);
    const target = resolveTarget(
      versions,
      opts.key,
      activeVersionId,
      opts.targetVersionId,
    );
    const restoring = restoringManifest(target, restoringVersion);
    const recorded = moduleRow.granted_permissions.filter(
      (permission) =>
        Array.isArray(restoring.permissions) &&
        restoring.permissions.includes(permission),
    );

    const installed = await upgradeModule({
      orgId: opts.orgId,
      actorId: opts.actorId,
      key: opts.key,
      manifest: restoring,
      grantedPermissions: recorded,
      installerEffectivePermissions: recorded,
      reason,
    });

    // The version this rollback replaces stops being merely superseded so
    // the history reads as what happened. The restoring version is already
    // active, which is exactly what markVersionRolledBack requires.
    let replacedVersionId = activeVersionId;
    if (replacedVersionId !== installed.versionId) {
      const marked = await markVersionRolledBack({
        orgId: opts.orgId,
        actorId: opts.actorId,
        versionId: replacedVersionId,
        reason,
      });
      replacedVersionId = marked.versionId;
    }

    await writeAudit(tx, {
      orgId: opts.orgId,
      table: "modules",
      rowId: moduleRow.id,
      action: "update",
      event: "module_rollback",
      reason,
      before: { key: moduleRow.key, active_version_id: activeVersionId },
      after: {
        key: moduleRow.key,
        active_version_id: installed.versionId,
        restoring_version: restoringVersion,
        restored_from_version_id: target.id,
        restored_from_version: target.version,
        replaced_version_id: replacedVersionId,
      },
      actorId: opts.actorId,
    });

    return {
      moduleId: moduleRow.id,
      versionId: installed.versionId,
      restoringVersion,
      restoredFromVersionId: target.id,
      restoredFromVersion: target.version,
      replacedVersionId,
    };
  });
}

export interface RequestRollbackApprovalOptions {
  orgId: string;
  requesterId: string;
  key: string;
  /** Restore this version; defaults to the most recent superseded version. */
  targetVersionId?: string | null;
  /** Label for the appended restoring version. Must be new (history is append-only). */
  restoringVersion: string;
  /**
   * The requesting actor's resolved permission set. Required, no default:
   * the staged grant is approved ∩ requested ∩ effective, and a caller that
   * cannot state its authority must not propose.
   */
  installerEffectivePermissions: readonly string[];
  /** Who may approve. Must resolve to at least one in-org user or the request fails closed. */
  assignees: ModuleApprovalAssignee[];
  quorum?: "any" | "all";
  /**
   * Pass through to the gate. Defaults to true when the restoring version
   * is capability-bearing (any requested permission) — the signed-apply
   * seam — so a rollback that re-arms authority cannot slip through
   * unsigned; page-only restores default to unsigned.
   */
  signatureRequired?: boolean;
  /** Single-admin escape hatch; recorded in audit when used. */
  allowSelfApproval?: boolean;
  /**
   * Admin-chosen grants, defaulting to the recorded grant. Must be a subset
   * of the restored request — narrowing a grant is a new approval, and the
   * lattice refuses anything wider.
   */
  grantedPermissions?: string[];
  /** Why: recorded on every audit row this request writes. */
  reason?: string;
}

/**
 * Propose a rollback through a human approval. Resolves the target and
 * builds the restoring document now (so the approver sees exactly which
 * version returns), then stages it as an upgrade proposal behind a real
 * module_version gate — approval activates through upgradeModule, denial
 * leaves the live version untouched. The live version keeps serving until
 * approval lands.
 */
export async function requestRollbackApproval(
  opts: RequestRollbackApprovalOptions,
): Promise<RollbackApprovalRequest> {
  const restoringVersion = checkRestoringLabel(opts.restoringVersion);
  const reason =
    opts.reason && opts.reason.length > 0 ? opts.reason : "rollback";
  return await withOrg(opts.orgId, async () => {
    const tx = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"module-projections:" + opts.orgId}, 0))`,
    );
    const moduleRow = assertModuleRollable(
      await lockModule(tx, opts.orgId, opts.key),
      opts.key,
    );
    const activeVersionId = moduleRow.active_version_id!;
    const versions = await listVersions(tx, opts.orgId, moduleRow.id);
    const target = resolveTarget(
      versions,
      opts.key,
      activeVersionId,
      opts.targetVersionId,
    );
    const restoring = restoringManifest(target, restoringVersion);
    const signatureRequired =
      moduleApplyRequiresSignature(restoring) ||
      opts.signatureRequired === true;

    // The upgrade request runs in a savepoint below: same refusal checks
    // (no pending proposal, assignees resolve, label new) the installer
    // path enforces, with this rollback's reason and signature seam.
    const request = await requestModuleUpgradeApproval({
      orgId: opts.orgId,
      requesterId: opts.requesterId,
      key: opts.key,
      manifest: restoring,
      ...(opts.grantedPermissions !== undefined
        ? { grantedPermissions: opts.grantedPermissions }
        : {}),
      installerEffectivePermissions: opts.installerEffectivePermissions,
      assignees: opts.assignees,
      ...(opts.quorum !== undefined ? { quorum: opts.quorum } : {}),
      signatureRequired,
      rollback: {
        restoredFromVersionId: target.id,
        replacedVersionId: activeVersionId,
      },
      ...(opts.allowSelfApproval !== undefined
        ? { allowSelfApproval: opts.allowSelfApproval }
        : {}),
      reason,
    });

    return {
      ...request,
      restoredFrom: { versionId: target.id, version: target.version },
      replacedVersionId: activeVersionId,
      signatureRequired,
    };
  });
}
