import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import type { ForecastCategory } from "../../../../../lib/analytics/cashflow-data";

export const runtime = "nodejs";

/**
 * Cash Flow forecast-category configuration. Stored as an array at
 * orgs.settings.analytics.cashflowCategories.
 * PUT replaces the whole list (the editor sends the full state); each entry is
 * validated per method (all seven strategies) and unknown fields are
 * dropped.
 */
const METHODS = new Set([
  "gl_history_average",
  "vendor_payment_history",
  "credit_card_cycle",
  "manual_recurring",
  "formula_expression",
  "vendor_recurring_average",
  "bank_register_history",
]);
const FREQUENCIES = new Set(["weekly", "biweekly", "bi_weekly", "monthly"]);

const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x).slice(0, max) : [];
const clampNum = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

function clean(raw: unknown): ForecastCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
  const method = String(c.method ?? "");
  const direction = c.direction === "inflow" ? "inflow" : "outflow";
  if (!name || !METHODS.has(method)) return null;
  const out: ForecastCategory = {
    id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
    name,
    direction,
    method: method as ForecastCategory["method"],
  };

  // Shared placement + adjustment knobs (getProrationFactor inputs).
  const day = Number(c.expectedDay);
  if (c.expectedDay !== "" && c.expectedDay !== null && c.expectedDay !== undefined && Number.isInteger(day) && day >= 0 && day <= 6) {
    out.expectedDay = day;
  }
  const wk = Number(c.expectedWeek);
  if (c.expectedWeek !== "" && c.expectedWeek !== null && c.expectedWeek !== undefined && Number.isInteger(wk) && wk >= 1 && wk <= 4) {
    out.expectedWeek = wk;
  }
  const adj = Number(c.adjustmentPct);
  if (Number.isFinite(adj) && adj !== 0) out.adjustmentPct = Math.min(200, Math.max(-90, adj));

  if (method === "gl_history_average") {
    const ids = strList(c.accountIds, 50);
    if (!ids.length) return null;
    out.accountIds = ids;
    out.historyWeeks = clampNum(c.historyWeeks, 1, 52, 12);
    if (c.useNetAmt === true) out.useNetAmt = true;
  } else if (method === "vendor_payment_history" || method === "vendor_recurring_average") {
    const ids = strList(c.partyIds, 50);
    if (!ids.length && typeof c.partyId === "string" && c.partyId) ids.push(c.partyId);
    if (!ids.length) return null;
    out.partyIds = ids;
    out.partyId = ids[0];
    out.partyName = typeof c.partyName === "string" ? c.partyName.slice(0, 120) : undefined;
    out.historyMonths = clampNum(c.historyMonths, 1, 36, method === "vendor_recurring_average" ? 3 : 12);
  } else if (method === "credit_card_cycle") {
    const ids = strList(c.cardAccountIds, 20).length ? strList(c.cardAccountIds, 20) : strList(c.accountIds, 20);
    if (!ids.length) return null;
    out.cardAccountIds = ids;
    out.historyMonths = clampNum(c.historyMonths, 1, 24, 6);
    const threshold = Number(c.significantPaymentThreshold);
    if (Number.isFinite(threshold) && threshold > 0) out.significantPaymentThreshold = Math.min(1e9, threshold);
  } else if (method === "formula_expression") {
    const formula = typeof c.formula === "string" ? c.formula.trim().slice(0, 500) : "";
    if (!formula) return null;
    out.formula = formula;
  } else if (method === "bank_register_history") {
    const ids = strList(c.bankAccountIds, 20);
    if (!ids.length) return null;
    out.bankAccountIds = ids;
    out.historyWeeks = clampNum(c.historyWeeks, 1, 52, 12);
    const keywords = strList(c.memoKeywords, 10).map((k) => k.trim().slice(0, 40)).filter(Boolean);
    if (keywords.length) out.memoKeywords = keywords;
    if (c.includeTransfers === false) out.includeTransfers = false;
    if (c.includeChecks === false) out.includeChecks = false;
    if (c.includeJournals === true) out.includeJournals = true;
  } else {
    // manual_recurring
    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    out.amount = Math.min(1e9, amount);
    out.frequency = FREQUENCIES.has(String(c.frequency)) ? (c.frequency as ForecastCategory["frequency"]) : "monthly";
  }
  return out;
}

export async function GET() {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const r = ((await db.execute(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats from orgs where id = ${gate.user.orgId}
  `)));
  const raw = r.rows[0]?.cats;
  return NextResponse.json({ categories: Array.isArray(raw) ? raw : [] });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { categories?: unknown[] } | null;
  if (!body || !Array.isArray(body.categories)) return NextResponse.json({ error: "categories array required" }, { status: 400 });
  if (body.categories.length > 50) return NextResponse.json({ error: "too many categories (max 50)" }, { status: 400 });

  const cleaned = body.categories.map(clean).filter((c): c is ForecastCategory => c !== null);
  await db.execute(sql`
    update orgs
    set settings = jsonb_set(
      jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
      '{analytics,cashflowCategories}', ${JSON.stringify(cleaned)}::jsonb, true)
    where id = ${gate.user.orgId}
  `);
  return NextResponse.json({ ok: true, categories: cleaned });
}
