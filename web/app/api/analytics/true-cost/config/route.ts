import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { canonicalDecimal, compareDecimal } from "../../../../../lib/exact-decimal";
import { DEFAULT_PROFILE, type TrueCostConfig, type TrueCostProfile, type CustomCategory } from "../../../../../lib/analytics/true-cost-data";
import { ALLOCATION_BASES, ALLOCATION_METHODS, RATE_FORMATS, COMPOSITE_METHODS, type AllocationBase, type AllocationMethod, type RateFormat, type CompositeMethod } from "../../../../../lib/analytics/true-cost-engine";

export const runtime = "nodejs";

/**
 * True Cost engine config — profiles, per-category allocation settings, custom
 * categories, composite method, base overrides. Stored at
 * orgs.settings.analytics.trueCost. GET returns the resolved config; PUT
 * replaces the whole config (validated), gated on the Setup permission.
 *
 * The config is an aggregate edited by several setup controls. Its revision is
 * persisted alongside the aggregate so a stale whole-object PUT cannot erase a
 * concurrent administrator's change. The revision check and replacement happen
 * in one UPDATE statement, which PostgreSQL serializes on the org row.
 */
const BASE_KEYS = new Set(Object.keys(ALLOCATION_BASES));
const METHOD_KEYS = new Set(Object.keys(ALLOCATION_METHODS));
const FORMAT_KEYS = new Set(Object.keys(RATE_FORMATS));
const COMPOSITE_KEYS = new Set(Object.keys(COMPOSITE_METHODS));
const CUSTOM_TYPES = new Set(["manual", "derived", "formula"]);
const INITIAL_REVISION = 0;

type PersistedTrueCostConfig = Partial<TrueCostConfig> & { revision?: unknown };
type TrueCostSnapshotRow = { cfg: PersistedTrueCostConfig | null };

function parseRevision(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) return null;
  const revision = Number(text);
  // A successful write increments the token, so reserve the largest safe
  // integer rather than allowing it to round in JavaScript before persisting.
  return Number.isSafeInteger(revision) && revision >= INITIAL_REVISION && revision < Number.MAX_SAFE_INTEGER ? revision : null;
}

async function loadTrueCostSnapshot(orgId: string): Promise<{
  revision: number;
  activeProfileId: string;
  profiles: TrueCostProfile[];
}> {
  // Read the aggregate and its OCC token in one statement. Separate reads can
  // otherwise combine profiles from revision N with a token from revision N+1.
  const row = (await db.execute<TrueCostSnapshotRow>(sql`
    select settings -> 'analytics' -> 'trueCost' as cfg
      from orgs where id = ${orgId}
  `)).rows[0];
  const raw = row?.cfg;
  const profiles: TrueCostProfile[] = Array.isArray(raw?.profiles) && raw.profiles.length
    ? raw.profiles.map((p) => ({
        ...DEFAULT_PROFILE,
        ...p,
        categorySettings: p.categorySettings ?? {},
        customCategories: p.customCategories ?? [],
        baseOverrides: p.baseOverrides ?? {},
      }))
    : [DEFAULT_PROFILE];
  const activeProfileId = raw?.activeProfileId && profiles.some((p) => p.id === raw.activeProfileId)
    ? raw.activeProfileId
    : profiles[0]!.id;
  return { revision: parseRevision(raw?.revision) ?? INITIAL_REVISION, activeProfileId, profiles };
}

class InvalidTrueCostAmount extends Error {
  constructor() {
    super("invalid_amount");
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || value === "") continue;
    out[key] = persistMoney(value, "0.0000");
  }
  return out;
}

function cleanCustomCategory(raw: unknown): CustomCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
  const type = String(c.type ?? "");
  if (!name || !CUSTOM_TYPES.has(type)) return null;
  const allocationBase = (BASE_KEYS.has(String(c.allocationBase)) ? c.allocationBase : "billed_hours") as AllocationBase;
  const rateFormat = (FORMAT_KEYS.has(String(c.rateFormat)) ? c.rateFormat : "per_hour") as RateFormat;
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
    const m = (c.manualConfig ?? {}) as Record<string, unknown>;
    const entryMode = ["fixed_total", "by_dept", "per_unit"].includes(String(m.entryMode)) ? (m.entryMode as "fixed_total" | "by_dept" | "per_unit") : "fixed_total";
    out.manualConfig = {
      entryMode,
      fixedTotal: persistMoney(m.fixedTotal, "0.0000"),
      byDeptAmounts: persistMoneyMap(m.byDeptAmounts),
      unitType: (BASE_KEYS.has(String(m.unitType)) ? m.unitType : "headcount") as AllocationBase,
      perUnitRate: persistMoney(m.perUnitRate, "0.0000"),
    };
  } else if (type === "derived") {
    const dc = (c.derivedConfig ?? {}) as Record<string, unknown>;
    out.derivedConfig = {
      sourceCategory: typeof dc.sourceCategory === "string" ? dc.sourceCategory : undefined,
      percentage: persistBoundedDecimal(dc.percentage, "0", "100"),
      allocationBase: dc.allocationBase === "same" || BASE_KEYS.has(String(dc.allocationBase)) ? (dc.allocationBase as AllocationBase | "same") : "same",
    };
  } else {
    const fc = (c.formulaConfig ?? {}) as Record<string, unknown>;
    out.formulaConfig = { formula: typeof fc.formula === "string" ? fc.formula.slice(0, 500) : "" };
  }
  return out;
}

function cleanProfile(raw: unknown): TrueCostProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 60) : "";
  if (!name) return null;
  const catSettingsRaw = (p.categorySettings ?? {}) as Record<string, Record<string, unknown>>;
  const categorySettings: TrueCostProfile["categorySettings"] = {};
  for (const [id, s] of Object.entries(catSettingsRaw)) {
    if (!s || typeof s !== "object") continue;
    categorySettings[id] = {
      allocationBase: BASE_KEYS.has(String(s.allocationBase)) ? (s.allocationBase as AllocationBase) : undefined,
      allocationMethod: METHOD_KEYS.has(String(s.allocationMethod)) ? (s.allocationMethod as AllocationMethod) : undefined,
      rateFormat: FORMAT_KEYS.has(String(s.rateFormat)) ? (s.rateFormat as RateFormat) : undefined,
      includeInComposite: s.includeInComposite === false ? false : s.includeInComposite === true ? true : undefined,
      allocationWeights: s.allocationWeights && typeof s.allocationWeights === "object" ? (s.allocationWeights as Record<string, number>) : undefined,
      allocationTiers: Array.isArray(s.allocationTiers)
        ? (s.allocationTiers as { min?: number; max?: number; rate?: unknown }[]).slice(0, 10).map((tier) => ({
            min: tier.min,
            max: tier.max,
            rate: tier.rate == null || tier.rate === "" ? undefined : persistMoney(tier.rate, "0.0000"),
          }))
        : undefined,
    };
  }
  const bo = (p.baseOverrides ?? {}) as Record<string, unknown>;
  const numMap = (o: unknown): Record<string, number> => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0])) : {});
  return {
    id: typeof p.id === "string" && p.id ? p.id : `profile_${randomUUID().slice(0, 8)}`,
    name,
    color: typeof p.color === "string" ? p.color : "#3b82f6",
    compositeMethod: (COMPOSITE_KEYS.has(String(p.compositeMethod)) ? p.compositeMethod : "sum") as CompositeMethod,
    baseLaborRate: persistMoney(p.baseLaborRate, "50.0000"),
    fringeRate: persistBoundedDecimal(p.fringeRate, "0.25", "1"),
    categorySettings,
    customCategories: Array.isArray(p.customCategories) ? p.customCategories.map(cleanCustomCategory).filter((c): c is CustomCategory => c !== null).slice(0, 30) : [],
    baseOverrides: { squareFeet: numMap(bo.squareFeet), units: numMap(bo.units), custom: numMap(bo.custom) },
  };
}

export async function GET() {
  const gate = await guardFeaturePermission("reports.read", "projects");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await loadTrueCostSnapshot(gate.user.orgId));
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission("admin.setup.manage", "projects");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { expectedRevision?: unknown; activeProfileId?: string; profiles?: unknown[] } | null;
  if (!body || !Array.isArray(body.profiles)) return NextResponse.json({ error: "profiles array required" }, { status: 400 });
  if (body.profiles.length > 20) return NextResponse.json({ error: "too many profiles (max 20)" }, { status: 400 });

  const expectedRevision = parseRevision(body.expectedRevision);
  if (expectedRevision === null) {
    return NextResponse.json(
      { error: "the True Cost configuration revision is required; reload and review the latest revision" },
      { status: 409 },
    );
  }

  let profiles: TrueCostProfile[];
  try {
    profiles = body.profiles.map(cleanProfile).filter((p): p is TrueCostProfile => p !== null);
  } catch (error) {
    if (error instanceof InvalidTrueCostAmount) {
      return NextResponse.json({ error: "rates and amounts must be non-negative decimals" }, { status: 400 });
    }
    throw error;
  }
  if (!profiles.length) return NextResponse.json({ error: "at least one valid profile required" }, { status: 400 });
  const activeProfileId = body.activeProfileId && profiles.some((p) => p.id === body.activeProfileId) ? body.activeProfileId : profiles[0]!.id;
  const revision = expectedRevision + 1;
  const config = { revision, activeProfileId, profiles };

  const updated = await db.execute(sql`
    update orgs
    set settings = jsonb_set(
      jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
      '{analytics,trueCost}', ${JSON.stringify(config)}::jsonb, true)
    where id = ${gate.user.orgId}
      and coalesce(settings -> 'analytics' -> 'trueCost' ->> 'revision', '0') = ${String(expectedRevision)}
    returning settings -> 'analytics' -> 'trueCost' ->> 'revision' as revision
  `);
  if (!updated.rows.length) {
    return NextResponse.json(
      { error: "this True Cost configuration changed after you opened it; reload and review the latest revision" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, revision, activeProfileId, profiles });
}
