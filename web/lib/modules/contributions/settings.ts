import { contributionSchema, type ModuleContribution } from "../manifest";

/**
 * Setting contributions — a module's org-scoped configuration keys.
 *
 * Projection target: `orgs.settings` (jsonb, default
 * `{ defaultNavMode: 'topbar' }` per schema/src/core.ts), written through
 * the module installer in the same transaction as every other projection,
 * with the same audit envelope (actor, before/after, reason) the page
 * projection carries. The installer consumes `planSettingProjection` /
 * `planSettingWithdrawal` below: the plan is pure (current settings in,
 * next settings + audit out), the installer executes the `orgs` update.
 * Until the installer wires the `setting` kind, an install carrying one is
 * refused exactly like any other not-yet-projected kind — never half
 * performed.
 *
 * The contribution shape is the canonical one from
 * web/lib/modules/manifest.ts — imported, never mirrored: an org settings
 * key (a snake_case `orgs.settings` path segment), the value type the
 * admin surface renders, and the default the org starts with.
 *
 * Page-grade guarantees, mirrored from the page projection:
 * - Org isolation: plans operate on the caller's settings object for an
 *   explicit orgId; there is no default org and no global write.
 * - Tenant beats module: a key the org already sets to anything other
 *   than a default this module owns aborts the plan (the installer aborts
 *   the whole install) instead of overwriting the tenant's value.
 * - Idempotent: the key already holding this module's default plans
 *   `already-projected`; a keyless default-less declaration plans a
 *   `no-default-no-op` (the version manifest still records the
 *   declaration for audit).
 * - Deactivate, never delete: withdrawal removes the key only while its
 *   value still equals a default this module set. A tenant-changed value
 *   is kept (`tenant-customized-kept`) — uninstalling a module must never
 *   destroy configuration someone chose.
 * - Fail closed: type-mismatched defaults are refused at the projection
 *   boundary even though the manifest validator already checks them
 *   (defense in depth, the installer's canonical-strictness rule), as are
 *   non-JSON-serializable values and blank authority.
 *
 * Upgrades: a v2 default replaces a v1 default only when the current value
 * still equals a default this module set. The installer passes every prior
 * default it ever projected for the key as `priorDefaults`; anything else
 * on the key is tenant-owned and conflicts.
 *
 * Effective dating: deliberately none. `orgs.settings` is point-in-time
 * UI/behavior configuration — it never reinterprets posted history, so no
 * rule reads it as-of a past date. (Standing rule applied and documented,
 * not skipped.)
 */

/** A setting contribution, narrowed from the canonical manifest union. */
export type SettingContribution = Extract<
  ModuleContribution,
  { kind: "setting" }
>;

/** Where setting contributions project, once the installer wires the kind. */
export const SETTING_PROJECTION_TARGET = "orgs" as const;

/** The live `orgs.settings` content for one org. */
export type OrgSettings = Record<string, unknown>;

export interface ProjectionContext {
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  /** Why: the approval/gate reference the installer passes to audit. */
  reason: string;
}

export interface ProjectionAudit {
  table: typeof SETTING_PROJECTION_TARGET;
  event: "module_projection" | "module_projection_withdrawn";
  reason: string;
  before: unknown;
  after: unknown;
  actorId: string;
}

export type SettingPlanResult =
  | {
      ok: true;
      plan: {
        outcome: "projected" | "already-projected" | "no-default-no-op";
        target: typeof SETTING_PROJECTION_TARGET;
        before: OrgSettings;
        after: OrgSettings;
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

export type SettingWithdrawalResult =
  | {
      ok: true;
      plan: {
        outcome:
          | "withdrawn"
          | "already-withdrawn"
          | "tenant-customized-kept"
          | "unverifiable-kept";
        target: typeof SETTING_PROJECTION_TARGET;
        before: OrgSettings;
        after: OrgSettings;
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

/** Deterministic encoding so a stored value compares equal to the bytes that wrote it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function contextError(ctx: ProjectionContext): string | null {
  if (!ctx.orgId.trim())
    return "orgId is required — a setting projection never assumes an org";
  if (!ctx.actorId.trim())
    return "actorId is required — every projection is audited to someone";
  if (!ctx.moduleKey.trim())
    return "moduleKey is required — projected keys are owned";
  if (!ctx.reason.trim())
    return "reason is required — audit rows carry the approval reference";
  return null;
}

/** Boundary type check: the default, when given, matches the value type. */
function defaultTypeError(contribution: SettingContribution): string | null {
  const { valueType, defaultValue } = contribution;
  if (defaultValue === undefined) return null;
  const ok =
    valueType === "json" ||
    (valueType === "boolean" && typeof defaultValue === "boolean") ||
    (valueType === "number" && typeof defaultValue === "number") ||
    (valueType === "string" && typeof defaultValue === "string");
  return ok ? null : `defaultValue must be a ${valueType}`;
}

/** Parse a raw setting contribution against the canonical manifest schema. Never throws. */
export function parseSettingContribution(
  raw: unknown,
):
  | { ok: true; contribution: SettingContribution }
  | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = contributionSchema.safeParse(raw);
  } catch {
    return {
      ok: false,
      errors: ["(root): unable to validate setting contribution"],
    };
  }
  const res = parsed as ReturnType<typeof contributionSchema.safeParse>;
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  if (res.data.kind !== "setting") {
    return {
      ok: false,
      errors: [
        `(root): expected a setting contribution, got "${res.data.kind}"`,
      ],
    };
  }
  return { ok: true, contribution: res.data };
}

/**
 * Plan the projection of one setting contribution against the org's live
 * settings. Pure: no database access. The installer executes the plan —
 * `update orgs set settings = ... where id = orgId` plus one audit_log
 * row — inside its install transaction.
 */
export function planSettingProjection(args: {
  contribution: SettingContribution;
  settings: OrgSettings;
  priorDefaults?: readonly unknown[];
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  reason: string;
}): SettingPlanResult {
  const { contribution, settings } = args;
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };
  const typeError = defaultTypeError(contribution);
  if (typeError) return { ok: false, errors: [typeError] };

  const auditBase = {
    table: SETTING_PROJECTION_TARGET as typeof SETTING_PROJECTION_TARGET,
    reason: args.reason,
    actorId: args.actorId,
  };
  const current = settings[contribution.key];

  if (current === undefined) {
    if (contribution.defaultValue === undefined) {
      return {
        ok: true,
        plan: {
          outcome: "no-default-no-op",
          target: SETTING_PROJECTION_TARGET,
          before: settings,
          after: { ...settings },
          audit: {
            ...auditBase,
            event: "module_projection",
            before: settings,
            after: { ...settings },
          },
        },
      };
    }
    let after: OrgSettings;
    try {
      after = {
        ...settings,
        [contribution.key]: JSON.parse(
          JSON.stringify(contribution.defaultValue),
        ),
      };
    } catch {
      return {
        ok: false,
        errors: [
          `defaultValue for "${contribution.key}" is not JSON-serializable`,
        ],
      };
    }
    return {
      ok: true,
      plan: {
        outcome: "projected",
        target: SETTING_PROJECTION_TARGET,
        before: settings,
        after,
        audit: {
          ...auditBase,
          event: "module_projection",
          before: settings,
          after,
        },
      },
    };
  }

  // The key is held: ours (a default this module set, current or prior) or
  // the tenant's. Owned values converge or adopt the upgrade; tenant values
  // abort the plan so the install fails instead of overwriting them.
  const owned = [contribution.defaultValue, ...(args.priorDefaults ?? [])].some(
    (d) => d !== undefined && stableStringify(d) === stableStringify(current),
  );
  if (owned) {
    if (
      contribution.defaultValue === undefined ||
      stableStringify(current) === stableStringify(contribution.defaultValue)
    ) {
      return {
        ok: true,
        plan: {
          outcome: "already-projected",
          target: SETTING_PROJECTION_TARGET,
          before: settings,
          after: { ...settings },
          audit: {
            ...auditBase,
            event: "module_projection",
            before: settings,
            after: { ...settings },
          },
        },
      };
    }
    const after = {
      ...settings,
      [contribution.key]: JSON.parse(JSON.stringify(contribution.defaultValue)),
    };
    return {
      ok: true,
      plan: {
        outcome: "projected",
        target: SETTING_PROJECTION_TARGET,
        before: settings,
        after,
        audit: {
          ...auditBase,
          event: "module_projection",
          before: settings,
          after,
        },
      },
    };
  }
  return {
    ok: false,
    errors: [
      `setting "${contribution.key}" is already set for this org; ` +
        `module "${args.moduleKey}" not projected — remove the org value first`,
    ],
  };
}

/**
 * Plan withdrawal (uninstall): remove the key only while it still holds a
 * default this module set. Anything else is tenant-owned and kept. Pure;
 * the installer executes the `orgs` update plus one audit_log row in its
 * uninstall transaction.
 */
export function planSettingWithdrawal(args: {
  contribution: SettingContribution;
  settings: OrgSettings;
  /** Defaults this module set for the key across versions (current first). */
  knownDefaults?: readonly unknown[];
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  reason: string;
}): SettingWithdrawalResult {
  const { contribution, settings } = args;
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };

  const auditBase = {
    table: SETTING_PROJECTION_TARGET as typeof SETTING_PROJECTION_TARGET,
    reason: args.reason,
    actorId: args.actorId,
  };
  const current = settings[contribution.key];
  if (current === undefined) {
    return {
      ok: true,
      plan: {
        outcome: "already-withdrawn",
        target: SETTING_PROJECTION_TARGET,
        before: settings,
        after: { ...settings },
        audit: {
          ...auditBase,
          event: "module_projection_withdrawn",
          before: settings,
          after: { ...settings },
        },
      },
    };
  }

  const candidates = [
    ...(args.knownDefaults ?? []),
    contribution.defaultValue,
  ].filter((d) => d !== undefined);
  if (candidates.length === 0) {
    // A default-less declaration never wrote the key: a value present now
    // is someone else's by construction. Keep it and say so.
    return {
      ok: true,
      plan: {
        outcome: "unverifiable-kept",
        target: SETTING_PROJECTION_TARGET,
        before: settings,
        after: { ...settings },
        audit: {
          ...auditBase,
          event: "module_projection_withdrawn",
          before: settings,
          after: { ...settings },
        },
      },
    };
  }
  if (candidates.some((d) => stableStringify(d) === stableStringify(current))) {
    const after = { ...settings };
    delete after[contribution.key];
    return {
      ok: true,
      plan: {
        outcome: "withdrawn",
        target: SETTING_PROJECTION_TARGET,
        before: settings,
        after,
        audit: {
          ...auditBase,
          event: "module_projection_withdrawn",
          before: settings,
          after,
        },
      },
    };
  }
  return {
    ok: true,
    plan: {
      outcome: "tenant-customized-kept",
      target: SETTING_PROJECTION_TARGET,
      before: settings,
      after: { ...settings },
      audit: {
        ...auditBase,
        event: "module_projection_withdrawn",
        before: settings,
        after: { ...settings },
      },
    },
  };
}
