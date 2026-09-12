import { PERMISSION_CATALOGUE } from "../../permissions";
import { contributionSchema, type ModuleContribution } from "../manifest";

/**
 * Permission contributions — the grantable keys a module introduces.
 *
 * Projection target: the role model (`app_roles.permissions`, per-org
 * bundles of permission keys), written through the module installer with
 * the same audit envelope (actor, before/after, reason) the page
 * projection carries. The installer consumes `planPermissionProjection` /
 * `planPermissionWithdrawal` below plus `resolveGrantablePermissions`: the
 * plan is pure (catalogue + sibling declarations in, grantable set + audit
 * out), the installer executes the audit write inside its transaction.
 * Until the installer wires the `permission` kind, an install carrying one
 * is refused exactly like any other not-yet-projected kind — never half
 * performed.
 *
 * The contribution shape is the canonical one from
 * web/lib/modules/manifest.ts — imported, never mirrored: a new
 * hierarchical permission key plus the label/description the roles UI
 * shows. The built-in catalogue is the real one from
 * engine/src/permissions.ts (via web/lib/permissions), never a copy: a
 * drifted mirror would let a module shadow a platform key the UI no
 * longer recognizes.
 *
 * Page-grade guarantees, mirrored from the page projection:
 * - A module INTRODUCES keys, never shadows them: a contribution whose
 *   key is already in the built-in catalogue is refused at the projection
 *   boundary (redefining `gl.post` would silently reinterpret platform
 *   meaning everywhere the key is checked).
 * - Concrete names only: wildcard segments (`recast.*`) are refused.
 *   Wildcards live in effective sets, never in declarations — the same
 *   rule the installer enforces on requested permissions.
 * - Install never widens anyone's access: projection makes the key
 *   *grantable* (visible in the roles UI, assignable by an admin holding
 *   the ceiling); no role row gains the key implicitly. An admin grants
 *   explicitly through the existing roles surface.
 * - Deactivate, never delete: withdrawal removes the key from the
 *   computed grantable set while every stored role grant keeps its bytes
 *   (`grantsAfter` is identically the input). Stripping grants on
 *   uninstall would silently narrow access — including, in the worst
 *   case, the grants that let an admin back in.
 * - Fail closed: two active modules claiming the same key with different
 *   labels conflict (the plan names both modules); identical key+label
 *   shares one grantable entry.
 *
 * Read path: the roles UI and the roles API normalize today against
 * `PERMISSION_CATALOGUE` alone (unknown keys are rejected). They consume
 * `resolveGrantablePermissions` — catalogue order for built-ins, sorted
 * module keys after — so a projected key becomes assignable with no
 * parallel table and no shadow system.
 */

/** A permission contribution, narrowed from the canonical manifest union. */
export type PermissionContribution = Extract<
  ModuleContribution,
  { kind: "permission" }
>;

/** Where permission contributions project, once the installer wires the kind. */
export const PERMISSION_PROJECTION_TARGET = "app_roles" as const;

/** One sibling declaration of the same key by another active module version. */
export interface SiblingPermissionDeclaration {
  key: string;
  label: string;
  moduleKey: string;
}

export interface ProjectionContext {
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  /** Why: the approval/gate reference the installer passes to audit. */
  reason: string;
}

export interface ProjectionAudit {
  table: typeof PERMISSION_PROJECTION_TARGET;
  event: "module_projection" | "module_projection_withdrawn";
  reason: string;
  before: unknown;
  after: unknown;
  actorId: string;
}

export type PermissionPlanResult =
  | {
      ok: true;
      plan: {
        outcome: "projected" | "already-projected";
        target: typeof PERMISSION_PROJECTION_TARGET;
        /** The grantable set after this projection. */
        grantable: string[];
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

export type PermissionWithdrawalResult =
  | {
      ok: true;
      plan: {
        outcome: "withdrawn";
        target: typeof PERMISSION_PROJECTION_TARGET;
        /** Stored role grants, byte-identical: withdrawal never strips grants. */
        grantsAfter: readonly string[];
        /** The grantable set after this withdrawal. */
        grantable: string[];
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

function contextError(ctx: ProjectionContext): string | null {
  if (!ctx.orgId.trim())
    return "orgId is required — a permission projection never assumes an org";
  if (!ctx.actorId.trim())
    return "actorId is required — every projection is audited to someone";
  if (!ctx.moduleKey.trim())
    return "moduleKey is required — grantable keys are owned";
  if (!ctx.reason.trim())
    return "reason is required — audit rows carry the approval reference";
  return null;
}

/**
 * Parse a raw permission contribution against the canonical manifest
 * schema, plus the projection-boundary rules the manifest does not carry:
 * introduced keys are concrete names (no wildcard segments). Never throws.
 */
export function parsePermissionContribution(
  raw: unknown,
):
  | { ok: true; contribution: PermissionContribution }
  | { ok: false; errors: string[] } {
  const res = contributionSchema.safeParse(raw);
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  if (res.data.kind !== "permission") {
    return {
      ok: false,
      errors: [
        `(root): expected a permission contribution, got "${res.data.kind}"`,
      ],
    };
  }
  if (res.data.key.includes("*")) {
    return {
      ok: false,
      errors: [
        "key: introduced permission keys are concrete names — wildcards live in effective sets, never in declarations",
      ],
    };
  }
  return { ok: true, contribution: res.data };
}

/**
 * The grantable set: the built-in catalogue in catalogue order, then every
 * module-introduced key sorted. Deterministic: the same declarations always
 * produce the same set, so the roles UI, the roles API, and audit agree.
 */
export function resolveGrantablePermissions(args: {
  catalogue?: readonly string[];
  modulePermissions: readonly { key: string; moduleKey: string }[];
}): string[] {
  const catalogue = args.catalogue ?? PERMISSION_CATALOGUE;
  const extras = [...new Set(args.modulePermissions.map((m) => m.key))]
    .filter((k) => !catalogue.includes(k))
    .sort();
  return [...catalogue, ...extras];
}

/**
 * Plan the projection of one permission contribution. Pure: no database
 * access. The installer executes the plan — one audit_log row against the
 * modules row (the declaration lives in the version manifest; no role row
 * is touched) — inside its install transaction.
 */
export function planPermissionProjection(args: {
  contribution: PermissionContribution;
  catalogue?: readonly string[];
  /** Same-key declarations by OTHER active module versions. */
  activeModuleKeys?: readonly SiblingPermissionDeclaration[];
  /** Module keys whose declarations are already grantable (incl. this module on re-install). */
  grantableModuleKeys?: readonly { key: string; moduleKey: string }[];
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  reason: string;
}): PermissionPlanResult {
  const { contribution } = args;
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };
  if (contribution.key.includes("*")) {
    return {
      ok: false,
      errors: [
        "key: introduced permission keys are concrete names — wildcards live in effective sets, never in declarations",
      ],
    };
  }
  const catalogue = args.catalogue ?? PERMISSION_CATALOGUE;
  if (catalogue.includes(contribution.key)) {
    return {
      ok: false,
      errors: [
        `permission "${contribution.key}" is already a platform permission — ` +
          `a module introduces keys, never redefines them`,
      ],
    };
  }
  for (const sibling of args.activeModuleKeys ?? []) {
    if (
      sibling.key !== contribution.key ||
      sibling.moduleKey === args.moduleKey
    )
      continue;
    if (sibling.label !== contribution.label) {
      return {
        ok: false,
        errors: [
          `permission "${contribution.key}" is already introduced by module "${sibling.moduleKey}" with a different label; ` +
            `module "${args.moduleKey}" not projected — one key, one meaning`,
        ],
      };
    }
  }

  const grantableModuleKeys = [
    ...(args.grantableModuleKeys ?? []),
    { key: contribution.key, moduleKey: args.moduleKey },
  ];
  const grantable = resolveGrantablePermissions({
    catalogue,
    modulePermissions: grantableModuleKeys,
  });
  const already = (args.grantableModuleKeys ?? []).some(
    (m) => m.key === contribution.key,
  );
  // A sibling's identical declaration shares the entry (checked above for
  // label agreement); either way the grantable set converges.
  return {
    ok: true,
    plan: {
      outcome: already ? "already-projected" : "projected",
      target: PERMISSION_PROJECTION_TARGET,
      grantable,
      audit: {
        table: PERMISSION_PROJECTION_TARGET,
        event: "module_projection",
        reason: args.reason,
        before: {
          key: contribution.key,
          grantable: already
            ? grantable
            : resolveGrantablePermissions({
                catalogue,
                modulePermissions: args.grantableModuleKeys ?? [],
              }),
        },
        after: {
          key: contribution.key,
          label: contribution.label,
          moduleKey: args.moduleKey,
          version: args.version,
          grantable,
        },
        actorId: args.actorId,
      },
    },
  };
}

/**
 * Plan withdrawal (uninstall): the key leaves the computed grantable set;
 * stored role grants keep their bytes. Pure; the installer executes the
 * audit_log row in its uninstall transaction.
 */
export function planPermissionWithdrawal(args: {
  contribution: PermissionContribution;
  /** Every stored grant across the org's roles (read, never written). */
  roleGrants: readonly string[];
  /** Remaining grantable module declarations after this withdrawal. */
  remainingModuleKeys?: readonly { key: string; moduleKey: string }[];
  catalogue?: readonly string[];
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  reason: string;
}): PermissionWithdrawalResult {
  const { contribution } = args;
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };
  const catalogue = args.catalogue ?? PERMISSION_CATALOGUE;
  const remaining = (args.remainingModuleKeys ?? []).filter(
    (m) => m.key !== contribution.key,
  );
  const grantable = resolveGrantablePermissions({
    catalogue,
    modulePermissions: remaining,
  });
  const stillDeclared = remaining.some((m) => m.key === contribution.key);
  return {
    ok: true,
    plan: {
      outcome: "withdrawn",
      target: PERMISSION_PROJECTION_TARGET,
      grantsAfter: [...args.roleGrants],
      grantable,
      audit: {
        table: PERMISSION_PROJECTION_TARGET,
        event: "module_projection_withdrawn",
        reason: args.reason,
        before: { key: contribution.key, moduleKey: args.moduleKey },
        after: {
          key: contribution.key,
          stillGrantable: stillDeclared,
          storedGrantsPreserved: args.roleGrants.length,
        },
        actorId: args.actorId,
      },
    },
  };
}
