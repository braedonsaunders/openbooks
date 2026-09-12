/**
 * Module capability lattice — the enforcement helper shared by the installer
 * and the projection executors.
 *
 * A module version's manifest REQUESTS platform permissions (from
 * MODULE_PLATFORM_PERMISSIONS in web/lib/modules/manifest.ts); an admin
 * APPROVES a subset at the approval gate; the module RUNS with
 * granted ∩ installer's-effective — the same lattice apps prove with
 * grantedPermissions (web/lib/apps/platform.ts: canUsePermission checks the
 * app grant AND the caller's own permission on every operation).
 *
 * Both halves of that conjunction live here so enforcement can never be
 * UI-only: the installer (engine/src/modules/installer.ts) calls
 * resolveModuleGrants when it records a version's grants, and every
 * projection executor calls assertModulePermitted before performing a
 * capability-gated write. Either side refusing is a hard error, never a
 * silent downgrade.
 *
 * Pure module: no database, no server-only imports. The platform permission
 * catalogue is caller-supplied (the installer passes
 * MODULE_PLATFORM_PERMISSIONS) so this file never forks that list into a
 * parallel source of truth, and so it stays dependency-free for the parallel
 * installer slice.
 */

export type ModuleCapabilityErrorCode =
  | "unknown_permission"
  | "grant_exceeds_request"
  | "invalid_permission"
  | "capability_denied"
  | "self_approval"
  | "invalid_actor";

export class ModuleCapabilityError extends Error {
  readonly name = "ModuleCapabilityError";
  constructor(
    message: string,
    readonly code: ModuleCapabilityErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function normalizePermission(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModuleCapabilityError(`${what} must be a non-blank permission string`, "invalid_permission", {
      value,
    });
  }
  return value;
}

/** Deterministic set output: deduplicated, sorted — stable across store/read cycles for audit evidence. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export interface GrantResolutionInput {
  /** Permissions the version's manifest requested (the validated manifest's `permissions`). */
  requested: readonly string[];
  /** Permissions the admin approved — must be a subset of `requested`. */
  approved: readonly string[];
  /** Permissions the installing actor effectively holds right now. */
  installerEffective: readonly string[];
  /**
   * The platform catalogue (MODULE_PLATFORM_PERMISSIONS). A requested string
   * outside it is a manifest error, not a grant the approval UI could
   * meaningfully show. Omit only when the caller already validated the
   * manifest through parseModuleManifest.
   */
  knownPermissions?: readonly string[];
}

export interface GrantResolution {
  /** approved ∩ requested ∩ installer-effective: what the module may exercise. Sorted. */
  granted: string[];
  /**
   * Requested but NOT granted — the admin declined them or the installer
   * never held them. Sorted. Reported (never dropped silently) so the
   * approval record and audit trail show exactly what an install asked for
   * and did not receive.
   */
  withheld: string[];
}

/**
 * Resolve what a module version is granted at install/upgrade time.
 *
 * Fail-closed throughout: unknown requested permissions throw (manifest
 * error), approvals exceeding the request throw (an admin cannot grant what
 * the module never asked for), and anything the installer does not
 * effectively hold is withheld — a low-privilege installer can never arm a
 * module with permissions they could not exercise themselves.
 */
export function resolveModuleGrants(input: GrantResolutionInput): GrantResolution {
  const requested = input.requested.map((p) => normalizePermission(p, "requested permission"));
  if (input.knownPermissions) {
    const known = new Set(input.knownPermissions);
    for (const permission of requested) {
      if (!known.has(permission)) {
        throw new ModuleCapabilityError(
          `unknown permission requested: ${permission}`,
          "unknown_permission",
          { permission },
        );
      }
    }
  }
  const requestedSet = new Set(requested);
  const approved = input.approved.map((p) => normalizePermission(p, "approved permission"));
  for (const permission of approved) {
    if (!requestedSet.has(permission)) {
      throw new ModuleCapabilityError(
        `approval grants a permission the manifest never requested: ${permission}`,
        "grant_exceeds_request",
        { permission },
      );
    }
  }
  const effective = new Set(input.installerEffective);
  const approvedSet = new Set(approved);
  const granted = sortedUnique([...approvedSet].filter((p) => effective.has(p)));
  const grantedSet = new Set(granted);
  const withheld = sortedUnique([...requestedSet].filter((p) => !grantedSet.has(p)));
  return { granted, withheld };
}

/**
 * The permissions a module version may exercise right now: its recorded
 * grants intersected with the CURRENT installer's effective permissions.
 * Recomputed at use time (not just stored at install) so a later privilege
 * revocation narrows the module without a reinstall.
 */
export function moduleEffectivePermissions(
  grantedPermissions: readonly string[],
  installerEffectivePermissions: readonly string[],
): string[] {
  const effective = new Set(installerEffectivePermissions);
  return sortedUnique(grantedPermissions.filter((p) => effective.has(p)));
}

export interface PermittedUseInput {
  /** Grants recorded on the module row (modules.granted_permissions). */
  grantedPermissions: readonly string[];
  /** The acting installer's/executor's current effective permissions. */
  installerEffectivePermissions: readonly string[];
  /** The single permission the attempted operation needs. */
  requiredPermission: string;
}

/**
 * Executor-side enforcement: throw unless `requiredPermission` is in
 * granted ∩ installer-effective. Projection executors call this before every
 * capability-gated write, so a grant recorded at install time cannot outlive
 * the authority behind it and UI approval alone never authorizes execution.
 */
export function assertModulePermitted(input: PermittedUseInput): void {
  const required = normalizePermission(input.requiredPermission, "required permission");
  const usable = new Set(
    moduleEffectivePermissions(input.grantedPermissions, input.installerEffectivePermissions),
  );
  if (!usable.has(required)) {
    throw new ModuleCapabilityError(
      `module lacks required permission: ${required}`,
      "capability_denied",
      { requiredPermission: required },
    );
  }
}

/**
 * Capabilities a candidate upgrade version requests beyond the active
 * version's request. Sorted. Empty means the upgrade narrows or repeats the
 * request and needs no new grant.
 */
export function addedModuleCapabilities(
  previousRequested: readonly string[],
  nextRequested: readonly string[],
): string[] {
  const previous = new Set(previousRequested);
  return sortedUnique(nextRequested.filter((p) => !previous.has(p)));
}

/**
 * Whether an upgrade may proceed on its existing approval. Any added
 * capability requires re-approval through the gate; narrowing or repeating
 * the request does not (withholding is always fail-closed safe).
 */
export function moduleUpgradeRequiresReapproval(
  previousRequested: readonly string[],
  nextRequested: readonly string[],
): boolean {
  return addedModuleCapabilities(previousRequested, nextRequested).length > 0;
}

export interface SeparationOfDutiesOptions {
  /**
   * Explicit opt-out for deployments where roles cannot supply a distinct
   * approver (single-admin org). Defaults to false; callers that pass true
   * must record the bypass in their audit event. Mirrors the
   * preventSelfApproval:false gate-node opt-out in engine/src/flows/gates.ts.
   */
  allowSelfApproval?: boolean;
}

/**
 * Separation of duties for module approvals: the actor who requested the
 * install/upgrade may never be the actor who approves it. Enforced here — at
 * the decision boundary the installer and approval flow both share — not
 * just in the admin UI, closing the direct-API bypass the same way decideGate
 * refuses self-approval at decision time.
 */
export function assertModuleSeparationOfDuties(
  requesterUserId: string,
  approverUserId: string,
  options?: SeparationOfDutiesOptions,
): void {
  const requester = typeof requesterUserId === "string" ? requesterUserId.trim() : "";
  const approver = typeof approverUserId === "string" ? approverUserId.trim() : "";
  if (!requester || !approver) {
    throw new ModuleCapabilityError(
      "module approval requires identified requester and approver actors",
      "invalid_actor",
    );
  }
  if (requester === approver && options?.allowSelfApproval !== true) {
    throw new ModuleCapabilityError(
      "the requester cannot approve their own module install",
      "self_approval",
    );
  }
}
