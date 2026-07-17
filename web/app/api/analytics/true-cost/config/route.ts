import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { loadTrueCostConfig, type TrueCostProfile, type CustomCategory } from "../../../../../lib/analytics/true-cost-data";
import { ALLOCATION_BASES, ALLOCATION_METHODS, RATE_FORMATS, COMPOSITE_METHODS, type AllocationBase, type AllocationMethod, type RateFormat, type CompositeMethod } from "../../../../../lib/analytics/true-cost-engine";

export const runtime = "nodejs";

/**
 * True Cost engine config — profiles, per-category allocation settings, custom
 * categories, composite method, base overrides. Stored at
 * orgs.settings.analytics.trueCost. GET returns the resolved config; PUT
 * replaces the whole config (validated), gated on the Setup permission.
 */
const BASE_KEYS = new Set(Object.keys(ALLOCATION_BASES));
const METHOD_KEYS = new Set(Object.keys(ALLOCATION_METHODS));
const FORMAT_KEYS = new Set(Object.keys(RATE_FORMATS));
const COMPOSITE_KEYS = new Set(Object.keys(COMPOSITE_METHODS));
const CUSTOM_TYPES = new Set(["manual", "derived", "formula"]);

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
      fixedTotal: Number(m.fixedTotal) || 0,
      byDeptAmounts: m.byDeptAmounts && typeof m.byDeptAmounts === "object" ? (m.byDeptAmounts as Record<string, number>) : {},
      unitType: (BASE_KEYS.has(String(m.unitType)) ? m.unitType : "headcount") as AllocationBase,
      perUnitRate: Number(m.perUnitRate) || 0,
    };
  } else if (type === "derived") {
    const dc = (c.derivedConfig ?? {}) as Record<string, unknown>;
    out.derivedConfig = {
      sourceCategory: typeof dc.sourceCategory === "string" ? dc.sourceCategory : undefined,
      percentage: Number(dc.percentage) || 0,
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
      allocationTiers: Array.isArray(s.allocationTiers) ? (s.allocationTiers as { min?: number; max?: number; rate?: number }[]).slice(0, 10) : undefined,
    };
  }
  const bo = (p.baseOverrides ?? {}) as Record<string, unknown>;
  const numMap = (o: unknown): Record<string, number> => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0])) : {});
  return {
    id: typeof p.id === "string" && p.id ? p.id : `profile_${randomUUID().slice(0, 8)}`,
    name,
    color: typeof p.color === "string" ? p.color : "#3b82f6",
    compositeMethod: (COMPOSITE_KEYS.has(String(p.compositeMethod)) ? p.compositeMethod : "sum") as CompositeMethod,
    baseLaborRate: Number(p.baseLaborRate) || 50,
    fringeRate: Math.min(1, Math.max(0, Number(p.fringeRate) || 0.25)),
    categorySettings,
    customCategories: Array.isArray(p.customCategories) ? p.customCategories.map(cleanCustomCategory).filter((c): c is CustomCategory => c !== null).slice(0, 30) : [],
    baseOverrides: { squareFeet: numMap(bo.squareFeet), units: numMap(bo.units), custom: numMap(bo.custom) },
  };
}

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const cfg = await loadTrueCostConfig(gate.user.orgId);
  return NextResponse.json({ activeProfileId: cfg.activeProfileId, profiles: cfg.profiles });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as { activeProfileId?: string; profiles?: unknown[] } | null;
  if (!body || !Array.isArray(body.profiles)) return NextResponse.json({ error: "profiles array required" }, { status: 400 });
  if (body.profiles.length > 20) return NextResponse.json({ error: "too many profiles (max 20)" }, { status: 400 });

  let profiles = body.profiles.map(cleanProfile).filter((p): p is TrueCostProfile => p !== null);
  if (!profiles.length) return NextResponse.json({ error: "at least one valid profile required" }, { status: 400 });
  const activeProfileId = body.activeProfileId && profiles.some((p) => p.id === body.activeProfileId) ? body.activeProfileId : profiles[0]!.id;

  await db.execute(sql`
    update orgs
    set settings = jsonb_set(
      jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
      '{analytics,trueCost}', ${JSON.stringify({ activeProfileId, profiles })}::jsonb, true)
    where id = ${gate.user.orgId}
  `);
  return NextResponse.json({ ok: true, activeProfileId, profiles });
}
