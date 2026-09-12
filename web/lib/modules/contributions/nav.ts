import { z } from "zod";
import {
  NAV_GROUP_BY_KEY,
  NAV_MODULES,
  defaultNavConfig,
  type NavItemConfig,
  type OrgNavConfig,
} from "../../nav/registry";

/**
 * Nav contributions — a module's shortcut entries in the org navigation.
 *
 * Projection target: `org_nav_configs` (one row per org, `{ version: 2,
 * groups }`), written through the module installer in the same transaction
 * as every other projection, with the same audit envelope (actor,
 * before/after, reason) the page projection carries. The installer consumes
 * `planNavProjection` / `planNavWithdrawal` below: the plan is pure
 * (existing config in, next config + audit out), the installer executes the
 * upsert. Until the installer wires the `nav` kind, an install carrying one
 * is refused exactly like any other not-yet-projected kind — never half
 * performed.
 *
 * Why `link` items: a module cannot mint registry modules — `NAV_MODULES`
 * keys are stable ids shipped in code, and the /admin/navigation validator
 * refuses `module` items whose key is not in `MODULE_BY_KEY`. The
 * projectable shape is therefore `{ kind: 'link', href, label, iconKey }`,
 * which the resolver renders verbatim and the validator accepts.
 *
 * Page-grade guarantees, mirrored from the page projection:
 * - Org isolation: every plan threads orgId; there is no default org.
 * - Tenant beats module: an org-saved item on the same href that this
 *   module did not project aborts the plan (the installer aborts the whole
 *   install) instead of shadowing the tenant's customization.
 * - Native beats module: an href owned by a registry module is refused —
 *   a module links to its own pages, never squats a native route.
 * - Idempotent: byte-identical re-projection plans `already-projected`.
 * - Deactivate, never delete: withdrawal sets `hidden: true` on the
 *   module's items, preserving the row and every org edit (labels, order).
 * - Fail closed: unknown groups, item-cap overflow, and blank authority
 *   are plan errors, never silent skips.
 *
 * Provenance: projected items carry a namespaced `moduleKey` extra field.
 * The navigation PUT validator only inspects known fields, so the marker
 * round-trips through saves; the resolver ignores unknown fields, so
 * rendering is unchanged. If an editor round-trip ever drops the marker,
 * withdrawal falls back to href matching — safe because install refused
 * any pre-existing same-href item, so an unmarked same-href item can only
 * be ours.
 *
 * Visibility: `link` items render for every user (the resolver gates only
 * `module`/`app` items), so a contribution SHOULD declare
 * `requiredPermission` for anything behind a gated page. The planner carries
 * it on the item (forward-compatible: tolerated by the validator, ignored
 * by the resolver today); the route behind the href enforces it — nav is a
 * shortcut, never an authorization boundary.
 */

/** A nav contribution as declared in a module manifest (`kind: 'nav'`). */
export const navContributionSchema = z.object({
  kind: z.literal("nav"),
  /** Link label, as the navigation validator bounds link labels. */
  label: z.string().trim().min(1).max(100),
  /**
   * In-app absolute path. Modules link to their own pages: external URLs
   * are refused (a module is org UI, never an off-site shortcut), as are
   * hrefs owned by native registry modules.
   */
  href: z
    .string()
    .regex(/^\/[A-Za-z0-9\-_/[\]().]*$/, "href must be an in-app absolute path")
    .max(120),
  /** Canonical workspace group the entry is appended to. */
  group: z.string().min(1).max(100),
  /** Icon key, as NavModule.iconKey; the resolver falls back to 'link'. */
  iconKey: z.string().trim().min(1).max(64).default("link"),
  /**
   * Permission guarding the page behind the link. Carried on the projected
   * item for the resolver; hierarchical `module.action[.qualifier]`, as
   * authz checks.
   */
  requiredPermission: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
      "requiredPermission must be a hierarchical permission key",
    )
    .max(80)
    .optional(),
  /** Render order among this module's entries in the same group. */
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type NavContribution = z.infer<typeof navContributionSchema>;

/** Where nav contributions project, once the installer wires the kind. */
export const NAV_PROJECTION_TARGET = "org_nav_configs" as const;

/** Hrefs owned by native registry modules — a module may never claim one. */
const NATIVE_HREFS = new Set(NAV_MODULES.map((m) => m.href));

/** The navigation validator's whole-config item cap. */
const MAX_ITEMS = 256;

export interface ProjectionContext {
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  /** Why: the approval/gate reference the installer passes to audit. */
  reason: string;
}

export interface ProjectionAudit {
  table: typeof NAV_PROJECTION_TARGET;
  event:
    | "module_projection"
    | "module_projection_superseded"
    | "module_projection_withdrawn";
  reason: string;
  before: unknown;
  after: unknown;
  actorId: string;
}

export type NavPlanResult =
  | {
      ok: true;
      plan: {
        outcome: "projected" | "already-projected";
        target: typeof NAV_PROJECTION_TARGET;
        before: OrgNavConfig | null;
        after: OrgNavConfig;
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

export type NavWithdrawalResult =
  | {
      ok: true;
      plan: {
        outcome: "withdrawn" | "already-withdrawn";
        target: typeof NAV_PROJECTION_TARGET;
        before: OrgNavConfig;
        after: OrgNavConfig;
        /** Ids (hrefs) the withdrawal hid, for the audit line. */
        withdrawnHrefs: string[];
        audit: ProjectionAudit;
      };
    }
  | { ok: false; errors: string[] };

function contextError(ctx: ProjectionContext): string | null {
  if (!ctx.orgId.trim())
    return "orgId is required — a nav projection never assumes an org";
  if (!ctx.actorId.trim())
    return "actorId is required — every projection is audited to someone";
  if (!ctx.moduleKey.trim())
    return "moduleKey is required — projected items carry provenance";
  if (!ctx.reason.trim())
    return "reason is required — audit rows carry the approval reference";
  return null;
}

/** Parse a raw nav contribution. Never throws. */
export function parseNavContribution(
  raw: unknown,
):
  | { ok: true; contribution: NavContribution }
  | { ok: false; errors: string[] } {
  const res = navContributionSchema.safeParse(raw);
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  if (!NAV_GROUP_BY_KEY.has(res.data.group as never)) {
    return {
      ok: false,
      errors: [`group: unknown navigation group "${res.data.group}"`],
    };
  }
  const owner = NATIVE_HREFS.has(res.data.href);
  if (owner) {
    return {
      ok: false,
      errors: [
        `href: ${res.data.href} is a native navigation route — a module links to its own pages`,
      ],
    };
  }
  return { ok: true, contribution: res.data };
}

/** Parse + duplicate-check a manifest's nav contributions. Never throws. */
export function parseNavContributions(
  raw: unknown[],
):
  | { ok: true; contributions: NavContribution[] }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const contributions: NavContribution[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const parsed = parseNavContribution(item);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((e) => `contributions[${i}]: ${e}`));
      return;
    }
    if (seen.has(parsed.contribution.href)) {
      errors.push(
        `duplicate nav contribution href: ${parsed.contribution.href}`,
      );
      return;
    }
    seen.add(parsed.contribution.href);
    contributions.push(parsed.contribution);
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, contributions };
}

/** The provenance marker a projected item carries. */
export function navItemModuleKey(item: NavItemConfig): string | null {
  const marker = (item as unknown as { moduleKey?: unknown }).moduleKey;
  return item.kind === "link" && typeof marker === "string" ? marker : null;
}

function projectedItem(
  contribution: NavContribution,
  moduleKey: string,
): NavItemConfig {
  return {
    kind: "link",
    href: contribution.href,
    label: contribution.label,
    iconKey: contribution.iconKey,
    ...(contribution.requiredPermission
      ? { requiredPermission: contribution.requiredPermission }
      : {}),
    moduleKey,
  } as NavItemConfig;
}

/**
 * Plan the projection of one nav contribution against the org's saved
 * navigation config (null when the org never customized navigation).
 * Pure: no database access. The installer executes the plan — upserting
 * `org_nav_configs` for the org plus one audit_log row — inside its
 * install transaction.
 */
export function planNavProjection(args: {
  contribution: NavContribution;
  savedConfig: OrgNavConfig | null;
  orgId: string;
  actorId: string;
  moduleKey: string;
  version: string;
  reason: string;
}): NavPlanResult {
  const { contribution, savedConfig } = args;
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };
  if (!NAV_GROUP_BY_KEY.has(contribution.group as never)) {
    return {
      ok: false,
      errors: [`unknown navigation group "${contribution.group}"`],
    };
  }
  if (NATIVE_HREFS.has(contribution.href)) {
    return {
      ok: false,
      errors: [
        `href ${contribution.href} is a native navigation route — a module links to its own pages`,
      ],
    };
  }

  const base: OrgNavConfig = savedConfig ?? defaultNavConfig();
  const totalItems = base.groups.reduce((n, g) => n + g.items.length, 0);

  for (const g of base.groups) {
    for (const item of g.items) {
      if (
        item.kind !== "link" ||
        item.href !== contribution.href ||
        item.hidden
      )
        continue;
      const owner = navItemModuleKey(item);
      if (owner === args.moduleKey) {
        // Owned by this module: identical bytes converge, drift re-projects below.
        if (
          item.label === contribution.label &&
          (item.iconKey ?? "link") === contribution.iconKey &&
          (item as { requiredPermission?: unknown }).requiredPermission ===
            contribution.requiredPermission
        ) {
          const audit: ProjectionAudit = {
            table: NAV_PROJECTION_TARGET,
            event: "module_projection",
            reason: args.reason,
            before: savedConfig,
            after: savedConfig,
            actorId: args.actorId,
          };
          return {
            ok: true,
            plan: {
              outcome: "already-projected",
              target: NAV_PROJECTION_TARGET,
              before: savedConfig,
              after: base,
              audit,
            },
          };
        }
      } else {
        // Tenant customization (or another module's entry) always beats an
        // installed module: the entry stays exactly as it was and the plan
        // fails so the installer aborts instead of shadowing it.
        return {
          ok: false,
          errors: [
            `href ${contribution.href} is already in this org's navigation${owner ? ` (projected by module "${owner}")` : ""}; ` +
              `module "${args.moduleKey}" not projected — one module owns an href`,
          ],
        };
      }
    }
  }

  if (totalItems >= MAX_ITEMS) {
    return {
      ok: false,
      errors: [
        `navigation already holds ${MAX_ITEMS} items — refusing to exceed the validator cap`,
      ],
    };
  }

  const groups = base.groups.map((g) => ({ ...g, items: [...g.items] }));
  let group = groups.find((g) => g.id === contribution.group);
  if (!group) {
    const canonical = NAV_GROUP_BY_KEY.get(contribution.group as never);
    if (!canonical)
      return {
        ok: false,
        errors: [`unknown navigation group "${contribution.group}"`],
      };
    group = { id: canonical.key, label: canonical.label, items: [] };
    groups.push(group);
  }
  // Withdrawn-then-reinstalled entries reactivate in place (order preserved).
  const dormant = group.items.findIndex(
    (item) =>
      item.kind === "link" &&
      item.href === contribution.href &&
      item.hidden === true &&
      (navItemModuleKey(item) === args.moduleKey ||
        navItemModuleKey(item) === null),
  );
  let event: ProjectionAudit["event"] = "module_projection";
  if (dormant >= 0) {
    group.items[dormant] = { ...projectedItem(contribution, args.moduleKey) };
    event = "module_projection_superseded";
  } else {
    group.items.push(projectedItem(contribution, args.moduleKey));
  }
  const after: OrgNavConfig = { version: 2, groups };

  return {
    ok: true,
    plan: {
      outcome: "projected",
      target: NAV_PROJECTION_TARGET,
      before: savedConfig,
      after,
      audit: {
        table: NAV_PROJECTION_TARGET,
        event,
        reason: args.reason,
        before: savedConfig,
        after,
        actorId: args.actorId,
      },
    },
  };
}

/**
 * Plan withdrawal (uninstall): hide this module's entries, never delete
 * them. Org edits to the entries (labels, order, group moves) survive —
 * only `hidden` flips. Pure; the installer executes the config update plus
 * one audit_log row in its uninstall transaction.
 */
export function planNavWithdrawal(args: {
  savedConfig: OrgNavConfig | null;
  moduleKey: string;
  /** The module's declared hrefs (this version's manifest), for marker-loss recovery. */
  declaredHrefs: readonly string[];
  orgId: string;
  actorId: string;
  version: string;
  reason: string;
}): NavWithdrawalResult {
  const ctxError = contextError(args);
  if (ctxError) return { ok: false, errors: [ctxError] };
  if (!args.savedConfig) {
    const empty: OrgNavConfig = { version: 2, groups: [] };
    return {
      ok: true,
      plan: {
        outcome: "already-withdrawn",
        target: NAV_PROJECTION_TARGET,
        before: { version: 2, groups: [] },
        after: empty,
        withdrawnHrefs: [],
        audit: {
          table: NAV_PROJECTION_TARGET,
          event: "module_projection_withdrawn",
          reason: args.reason,
          before: null,
          after: null,
          actorId: args.actorId,
        },
      },
    };
  }

  const declared = new Set(args.declaredHrefs);
  const groups = args.savedConfig.groups.map((g) => ({
    ...g,
    items: [...g.items],
  }));
  const withdrawnHrefs: string[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.items.length; i++) {
      const item = g.items[i]!;
      if (item.kind !== "link" || item.hidden) continue;
      const owner = navItemModuleKey(item);
      const marked = owner === args.moduleKey;
      // Marker-loss recovery: an unmarked visible item on a declared href is
      // ours — install refused every pre-existing same-href entry.
      const recovered = owner === null && declared.has(item.href);
      if (marked || recovered) {
        g.items[i] = { ...item, hidden: true };
        withdrawnHrefs.push(item.href);
      }
    }
  }
  const after: OrgNavConfig = { version: 2, groups };
  return {
    ok: true,
    plan: {
      outcome: withdrawnHrefs.length > 0 ? "withdrawn" : "already-withdrawn",
      target: NAV_PROJECTION_TARGET,
      before: args.savedConfig,
      after,
      withdrawnHrefs,
      audit: {
        table: NAV_PROJECTION_TARGET,
        event: "module_projection_withdrawn",
        reason: args.reason,
        before: args.savedConfig,
        after,
        actorId: args.actorId,
      },
    },
  };
}
