import { z } from "zod";
import { FEATURES } from "../feature-registry.ts";
const featureKeys = new Set(FEATURES.map((feature) => feature.key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)));
import { NAV_GROUP_BY_KEY, NAV_MODULES } from "./nav-registry.ts";
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const PERMISSION_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
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
    .max(120).refine((href) => !NAV_MODULES.some((entry) => entry.href === href), "native navigation route"),
  /** Canonical workspace group the entry is appended to. */
  group: z.string().min(1).max(100).refine((key) => NAV_GROUP_BY_KEY.has(key as never), "unknown navigation group"),
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
export const permissionContributionSchema = z.object({
  kind: z.literal('permission'),
  /** New permission key the module introduces, e.g. 'revenue.recast'. */
  key: z.string().regex(PERMISSION_KEY, 'key must be a hierarchical permission key').max(80),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
})

const settingContributionBase = z.object({
  kind: z.literal('setting'),
  /** Org settings key (orgs.settings jsonb path segment). */
  key: z.string().regex(KEY, 'key must be a snake_case identifier').max(64).refine((key) => !featureKeys.has(key) && !/(^|_)(features?|enabled|disabled)(_|$)/.test(key), 'Feature gates belong on Company Settings → Features'),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Value type the admin surface renders. */
  valueType: z.enum(['boolean', 'number', 'string', 'json']),
  defaultValue: z.unknown().optional(),
}).strict()

/** Setting contribution whose default, when given, matches its value type — a boolean setting defaulting to 'yes' renders nowhere. */
export const settingContributionSchema = settingContributionBase.superRefine((s, ctx) => {
  if (s.defaultValue === undefined) return
  const isJson = (value: unknown, ancestors = new Set<object>()): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const next = new Set(ancestors).add(value);
    return Object.values(value).every((entry) => isJson(entry, next));
  };
  if (!isJson(s.defaultValue)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultValue'], message: 'defaultValue must be finite, serializable JSON' });
  const ok =
    s.valueType === 'json' ||
    (s.valueType === 'boolean' && typeof s.defaultValue === 'boolean') ||
    (s.valueType === 'number' && typeof s.defaultValue === 'number') ||
    (s.valueType === 'string' && typeof s.defaultValue === 'string')
  if (!ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultValue'], message: `defaultValue must be a ${s.valueType}` })
  }
})


export const supplementalContributionSchema = z.discriminatedUnion("kind", [navContributionSchema, settingContributionSchema, permissionContributionSchema]);
export type SupplementalContribution = z.infer<typeof supplementalContributionSchema>;
