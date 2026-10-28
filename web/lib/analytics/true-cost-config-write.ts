import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadTrueCostConfig, saveTrueCostConfig } from "@openbooks/engine/reports/true-cost-config";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { canonicalDecimal, compareDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import {
  DEFAULT_PROFILE,
  type TrueCostConfig,
  type TrueCostProfile,
  type CustomCategory,
} from "@/lib/analytics/true-cost-data";
import {
  ALLOCATION_BASES,
  ALLOCATION_METHODS,
  RATE_FORMATS,
  COMPOSITE_METHODS,
  type AllocationBase,
  type AllocationMethod,
  type RateFormat,
  type CompositeMethod,
} from "@/lib/analytics/true-cost-engine";

const BASE_KEYS = new Set(Object.keys(ALLOCATION_BASES));
const METHOD_KEYS = new Set(Object.keys(ALLOCATION_METHODS));
const FORMAT_KEYS = new Set(Object.keys(RATE_FORMATS));
const COMPOSITE_KEYS = new Set(Object.keys(COMPOSITE_METHODS));
const CUSTOM_TYPES = new Set(["manual", "derived", "formula"]);
const enumKeys = (keys: Set<string>, field: string) =>
  z.string().refine((value) => keys.has(value), `${field} must be an installed value`);
const exactAmount = (field: string) =>
  z.string().superRefine((value, ctx) => {
    const exact = canonicalDecimal(value, 4);
    if (exact === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, value) });
      return;
    }
    try {
      normalizeMoney(exact);
    } catch {
      ctx.addIssue({ code: "custom", message: moneyRefusal(field, value) });
      return;
    }
    if (compareDecimal(exact, "0") < 0)
      ctx.addIssue({ code: "custom", message: `${field} must be zero or greater` });
  });
const decimalRateRefusal = (field: string, value: string) =>
  moneyRefusal(field, value, "a decimal rate");
const boundedRate = (field: string, max: string) =>
  z.string().superRefine((value, ctx) => {
    const exact = canonicalDecimal(value, 4);
    if (exact === null) {
      ctx.addIssue({ code: "custom", message: decimalRateRefusal(field, value) });
      return;
    }
    if (compareDecimal(exact, "0") < 0 || compareDecimal(exact, max) > 0) {
      ctx.addIssue({ code: "custom", message: `${field} must be between 0 and ${max}` });
    }
  });
const allocationBaseSchema = enumKeys(BASE_KEYS, "allocationBase");
const allocationMethodSchema = enumKeys(METHOD_KEYS, "allocationMethod");
const rateFormatSchema = enumKeys(FORMAT_KEYS, "rateFormat");
const moneyMapSchema = z.record(z.string(), exactAmount("byDeptAmounts amount"));
const manualConfigSchema = z.discriminatedUnion("entryMode", [
  z.strictObject({ entryMode: z.literal("fixed_total"), fixedTotal: exactAmount("fixedTotal") }),
  z.strictObject({ entryMode: z.literal("by_dept"), byDeptAmounts: moneyMapSchema }),
  z.strictObject({
    entryMode: z.literal("per_unit"),
    unitType: allocationBaseSchema,
    perUnitRate: exactAmount("perUnitRate"),
  }),
]);
const customCategorySchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    color: z.string().max(40).nullable().optional(),
    type: z.literal("manual"),
    allocationBase: allocationBaseSchema,
    rateFormat: rateFormatSchema,
    includeInComposite: z.boolean(),
    manualConfig: manualConfigSchema,
  }),
  z.strictObject({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    color: z.string().max(40).nullable().optional(),
    type: z.literal("derived"),
    allocationBase: allocationBaseSchema,
    rateFormat: rateFormatSchema,
    includeInComposite: z.boolean(),
    derivedConfig: z.strictObject({
      sourceCategory: z.string().trim().min(1).max(120),
      percentage: boundedRate("percentage", "100"),
      allocationBase: z.union([z.literal("same"), allocationBaseSchema]),
    }),
  }),
  z.strictObject({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    color: z.string().max(40).nullable().optional(),
    type: z.literal("formula"),
    allocationBase: allocationBaseSchema,
    rateFormat: rateFormatSchema,
    includeInComposite: z.boolean(),
    formulaConfig: z.strictObject({ formula: z.string().trim().min(1).max(500) }),
  }),
]);
const categorySettingSchema = z.strictObject({
  allocationBase: allocationBaseSchema.optional(),
  allocationMethod: allocationMethodSchema.optional(),
  rateFormat: rateFormatSchema.optional(),
  includeInComposite: z.boolean().optional(),
  allocationWeights: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  allocationTiers: z
    .array(
      z
        .strictObject({
          min: z.number().finite().nonnegative(),
          max: z.number().finite().nonnegative().optional(),
          rate: exactAmount("allocation tier rate").optional(),
        })
        .refine((tier) => tier.max === undefined || tier.max >= tier.min, {
          error: "allocation tier maximum must not be below its minimum",
        }),
    )
    .max(10)
    .optional(),
});
const profileSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  color: z.string().max(40).nullable().optional(),
  compositeMethod: enumKeys(COMPOSITE_KEYS, "compositeMethod"),
  baseLaborRate: z.union([z.literal(""), exactAmount("baseLaborRate")]),
  categorySettings: z.record(z.string(), categorySettingSchema),
  customCategories: z.array(customCategorySchema).max(30),
  baseOverrides: z
    .strictObject({
      squareFeet: z.record(z.string(), z.number().finite().nonnegative()).optional(),
      units: z.record(z.string(), z.number().finite().nonnegative()).optional(),
      custom: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    })
    .optional(),
});
export const trueCostBodySchema = z
  .strictObject({
    activeProfileId: z.string().trim().min(1).max(80),
    expectedRevision: z
      .union([
        z.number().int().nonnegative(),
        z
          .string()
          .regex(/^\d+$/, "expectedRevision must be a non-negative integer")
          .transform(Number),
      ])
      .pipe(z.number().int().safe().nonnegative())
      .optional(),
    profiles: z.array(profileSchema).min(1).max(20),
  })
  .superRefine((body, ctx) => {
    if (!body.profiles.some((profile) => profile.id === body.activeProfileId)) {
      ctx.addIssue({
        code: "custom",
        path: ["activeProfileId"],
        message: "activeProfileId must identify one of the submitted profiles",
      });
    }
  });

const INITIAL_REVISION = 0;

type PersistedTrueCostConfig = Partial<TrueCostConfig> & { revision?: unknown };
function parseRevision(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) return null;
  const revision = Number(text);
  // A successful write increments the token, so reserve the largest safe
  // integer rather than allowing it to round in JavaScript before persisting.
  return Number.isSafeInteger(revision) &&
    revision >= INITIAL_REVISION &&
    revision < Number.MAX_SAFE_INTEGER
    ? revision
    : null;
}

export async function loadTrueCostSnapshot(orgId: string): Promise<{
  revision: number;
  activeProfileId: string;
  profiles: TrueCostProfile[];
}> {
  // Read the aggregate and its OCC token in one statement. Separate reads can
  // otherwise combine profiles from revision N with a token from revision N+1.
  const raw = (await loadTrueCostConfig(orgId)) as PersistedTrueCostConfig | null;
  const profiles: TrueCostProfile[] =
    Array.isArray(raw?.profiles) && raw.profiles.length
      ? raw.profiles.map((p) => ({
          ...DEFAULT_PROFILE,
          ...p,
          categorySettings: p.categorySettings ?? {},
          customCategories: p.customCategories ?? [],
          baseOverrides: p.baseOverrides ?? {},
        }))
      : [DEFAULT_PROFILE];
  const activeProfileId =
    raw?.activeProfileId && profiles.some((p) => p.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]!.id;
  return { revision: parseRevision(raw?.revision) ?? INITIAL_REVISION, activeProfileId, profiles };
}

class InvalidTrueCostAmount extends Error {
  constructor() {
    super("invalid_amount");
  }
}

class InvalidTrueCostConfiguration extends Error {
  constructor() {
    super("invalid_true_cost_configuration");
  }
}

/** Persist a non-negative ledger amount. Missing values use the fallback. */
function persistMoney(value: unknown, fallback: string): string {
  if (value == null || value === "") return fallback;
  const exact = canonicalDecimal(value, 4);
  if (exact === null || compareDecimal(exact, "0") < 0) throw new InvalidTrueCostAmount();
  try {
    return normalizeMoney(exact);
  } catch {
    throw new InvalidTrueCostAmount();
  }
}

/** Persist a non-negative decimal in [0, max] without IEEE-754 coercion. */
function persistBoundedDecimal(value: unknown, fallback: string, max: string, scale = 4): string {
  if (value == null || value === "") return fallback;
  const exact = canonicalDecimal(value, scale);
  if (exact === null || compareDecimal(exact, "0") < 0 || compareDecimal(exact, max) > 0) {
    throw new InvalidTrueCostAmount();
  }
  return exact;
}

function persistMoneyMap(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new InvalidTrueCostConfiguration();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || value === "") continue;
    out[key] = persistMoney(value, "0.0000");
  }
  return out;
}

function cleanCustomCategory(raw: unknown): CustomCategory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new InvalidTrueCostConfiguration();
  const c = raw as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
  const type = String(c.type ?? "");
  if (!name || !CUSTOM_TYPES.has(type)) throw new InvalidTrueCostConfiguration();
  if (c.allocationBase != null && !BASE_KEYS.has(String(c.allocationBase)))
    throw new InvalidTrueCostConfiguration();
  if (c.rateFormat != null && !FORMAT_KEYS.has(String(c.rateFormat)))
    throw new InvalidTrueCostConfiguration();
  if (c.includeInComposite != null && typeof c.includeInComposite !== "boolean")
    throw new InvalidTrueCostConfiguration();
  const allocationBase = (
    c.allocationBase == null ? "billed_hours" : c.allocationBase
  ) as AllocationBase;
  const rateFormat = (c.rateFormat == null ? "per_hour" : c.rateFormat) as RateFormat;
  const out: CustomCategory = {
    id: typeof c.id === "string" && c.id ? c.id : `cat_${randomUUID().slice(0, 8)}`,
    name,
    color: typeof c.color === "string" ? c.color : null,
    type: type as CustomCategory["type"],
    allocationBase,
    rateFormat,
    includeInComposite: c.includeInComposite !== false,
  };
  if (type === "manual") {
    if (
      c.manualConfig != null &&
      (typeof c.manualConfig !== "object" || Array.isArray(c.manualConfig))
    )
      throw new InvalidTrueCostConfiguration();
    const m = (c.manualConfig ?? {}) as Record<string, unknown>;
    if (
      m.entryMode != null &&
      !["fixed_total", "by_dept", "per_unit"].includes(String(m.entryMode))
    )
      throw new InvalidTrueCostConfiguration();
    if (m.unitType != null && !BASE_KEYS.has(String(m.unitType)))
      throw new InvalidTrueCostConfiguration();
    const entryMode = (m.entryMode ?? "fixed_total") as "fixed_total" | "by_dept" | "per_unit";
    out.manualConfig = {
      entryMode,
      fixedTotal: persistMoney(m.fixedTotal, "0.0000"),
      byDeptAmounts: persistMoneyMap(m.byDeptAmounts),
      unitType: (m.unitType ?? "headcount") as AllocationBase,
      perUnitRate: persistMoney(m.perUnitRate, "0.0000"),
    };
  } else if (type === "derived") {
    if (
      c.derivedConfig != null &&
      (typeof c.derivedConfig !== "object" || Array.isArray(c.derivedConfig))
    )
      throw new InvalidTrueCostConfiguration();
    const dc = (c.derivedConfig ?? {}) as Record<string, unknown>;
    if (dc.sourceCategory != null && typeof dc.sourceCategory !== "string")
      throw new InvalidTrueCostConfiguration();
    out.derivedConfig = {
      sourceCategory: typeof dc.sourceCategory === "string" ? dc.sourceCategory : undefined,
      percentage: persistBoundedDecimal(dc.percentage, "0", "100"),
      allocationBase:
        dc.allocationBase === "same" || BASE_KEYS.has(String(dc.allocationBase))
          ? (dc.allocationBase as AllocationBase | "same")
          : "same",
    };
  } else {
    if (
      c.formulaConfig != null &&
      (typeof c.formulaConfig !== "object" || Array.isArray(c.formulaConfig))
    )
      throw new InvalidTrueCostConfiguration();
    const fc = (c.formulaConfig ?? {}) as Record<string, unknown>;
    if (fc.formula != null && typeof fc.formula !== "string")
      throw new InvalidTrueCostConfiguration();
    out.formulaConfig = { formula: typeof fc.formula === "string" ? fc.formula.slice(0, 500) : "" };
  }
  return out;
}

function cleanProfile(raw: unknown): TrueCostProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new InvalidTrueCostConfiguration();
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 60) : "";
  if (!name) throw new InvalidTrueCostConfiguration();
  if (
    p.categorySettings != null &&
    (typeof p.categorySettings !== "object" || Array.isArray(p.categorySettings))
  )
    throw new InvalidTrueCostConfiguration();
  if (p.customCategories != null && !Array.isArray(p.customCategories))
    throw new InvalidTrueCostConfiguration();
  if (Array.isArray(p.customCategories) && p.customCategories.length > 30)
    throw new InvalidTrueCostConfiguration();
  const catSettingsRaw = (p.categorySettings ?? {}) as Record<string, Record<string, unknown>>;
  const categorySettings: TrueCostProfile["categorySettings"] = {};
  for (const [id, s] of Object.entries(catSettingsRaw)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new InvalidTrueCostConfiguration();
    if (
      s.allocationWeights != null &&
      (typeof s.allocationWeights !== "object" || Array.isArray(s.allocationWeights))
    )
      throw new InvalidTrueCostConfiguration();
    if (
      s.allocationTiers != null &&
      (!Array.isArray(s.allocationTiers) || s.allocationTiers.length > 10)
    )
      throw new InvalidTrueCostConfiguration();
    categorySettings[id] = {
      allocationBase: BASE_KEYS.has(String(s.allocationBase))
        ? (s.allocationBase as AllocationBase)
        : undefined,
      allocationMethod: METHOD_KEYS.has(String(s.allocationMethod))
        ? (s.allocationMethod as AllocationMethod)
        : undefined,
      rateFormat: FORMAT_KEYS.has(String(s.rateFormat)) ? (s.rateFormat as RateFormat) : undefined,
      includeInComposite:
        s.includeInComposite === false ? false : s.includeInComposite === true ? true : undefined,
      allocationWeights:
        s.allocationWeights && typeof s.allocationWeights === "object"
          ? (s.allocationWeights as Record<string, number>)
          : undefined,
      allocationTiers: Array.isArray(s.allocationTiers)
        ? (s.allocationTiers as unknown[]).map((rawTier) => {
            if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier))
              throw new InvalidTrueCostConfiguration();
            const tier = rawTier as { min?: number; max?: number; rate?: unknown };
            return {
              min: tier.min,
              max: tier.max,
              rate:
                tier.rate == null || tier.rate === ""
                  ? undefined
                  : persistMoney(tier.rate, "0.0000"),
            };
          })
        : undefined,
    };
  }
  const bo = (p.baseOverrides ?? {}) as Record<string, unknown>;
  const numMap = (o: unknown): Record<string, number> =>
    o && typeof o === "object"
      ? Object.fromEntries(
          Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
        )
      : {};
  return {
    id: typeof p.id === "string" && p.id ? p.id : `profile_${randomUUID().slice(0, 8)}`,
    name,
    color: typeof p.color === "string" ? p.color : "#3b82f6",
    compositeMethod: (COMPOSITE_KEYS.has(String(p.compositeMethod))
      ? p.compositeMethod
      : "sum") as CompositeMethod,
    // No assumed labor rate: empty persists as unset, and the dashboard
    // derives from costed time or refuses when cascading needs one.
    baseLaborRate:
      p.baseLaborRate == null || p.baseLaborRate === ""
        ? ""
        : persistMoney(p.baseLaborRate, "0.0000"),
    categorySettings,
    customCategories: Array.isArray(p.customCategories)
      ? p.customCategories.map(cleanCustomCategory)
      : [],
    baseOverrides: {
      squareFeet: numMap(bo.squareFeet),
      units: numMap(bo.units),
      custom: numMap(bo.custom),
    },
  };
}

export type TrueCostWriteResult =
  | { kind: "invalid_body"; message: string }
  | { kind: "revision_required" }
  | { kind: "invalid_amount" }
  | { kind: "invalid_configuration" }
  | { kind: "conflict" }
  | { kind: "saved"; revision: number; activeProfileId: string; profiles: TrueCostProfile[] };

export async function replaceTrueCostConfig(input: {
  orgId: string;
  actorId: string;
  body: unknown;
}): Promise<TrueCostWriteResult> {
  const parsed = trueCostBodySchema.safeParse(input.body);
  if (!parsed.success)
    return {
      kind: "invalid_body",
      message:
        parsed.error.issues[0]?.message ??
        "invalid_true_cost_configuration: correct the configuration fields and save again",
    };
  const expectedRevision = parseRevision(parsed.data.expectedRevision);
  if (expectedRevision === null) return { kind: "revision_required" };

  let profiles: TrueCostProfile[];
  try {
    profiles = parsed.data.profiles.map(cleanProfile);
  } catch (error) {
    if (error instanceof InvalidTrueCostAmount) return { kind: "invalid_amount" };
    if (error instanceof InvalidTrueCostConfiguration) return { kind: "invalid_configuration" };
    throw error;
  }
  const activeProfileId = parsed.data.activeProfileId;
  const revision = expectedRevision + 1;
  const updated = await saveTrueCostConfig({
    orgId: input.orgId,
    actorId: input.actorId,
    expectedRevision,
    config: { revision, activeProfileId, profiles },
  });
  if (!updated) return { kind: "conflict" };
  return { kind: "saved", revision, activeProfileId, profiles };
}
