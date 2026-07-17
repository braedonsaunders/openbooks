import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import type { ForecastCategory } from "../../../../../lib/analytics/cashflow-data";

export const runtime = "nodejs";

/**
 * Cash Flow forecast categories — the openbooks port of Gantry's category
 * config CRUD. Stored as an array at orgs.settings.analytics.cashflowCategories.
 * PUT replaces the whole list (the editor sends the full state); each entry is
 * validated per method and unknown fields are dropped.
 */
const METHODS = new Set(["gl_history_average", "vendor_payment_history", "manual_recurring"]);
const FREQUENCIES = new Set(["weekly", "biweekly", "monthly"]);

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
  if (method === "gl_history_average") {
    const ids = Array.isArray(c.accountIds) ? c.accountIds.filter((x) => typeof x === "string").slice(0, 50) : [];
    if (!ids.length) return null;
    out.accountIds = ids as string[];
    const hw = Number(c.historyWeeks);
    out.historyWeeks = Number.isFinite(hw) ? Math.min(52, Math.max(1, Math.round(hw))) : 12;
    const adj = Number(c.adjustmentPct);
    out.adjustmentPct = Number.isFinite(adj) ? Math.min(200, Math.max(-90, adj)) : 0;
  } else if (method === "vendor_payment_history") {
    if (typeof c.partyId !== "string" || !c.partyId) return null;
    out.partyId = c.partyId;
    out.partyName = typeof c.partyName === "string" ? c.partyName.slice(0, 120) : undefined;
  } else {
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
  const r = (await db.execute(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats from orgs where id = ${gate.user.orgId}
  `)) as any;
  const raw = r.rows[0]?.cats;
  return NextResponse.json({ categories: Array.isArray(raw) ? raw : [] });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as { categories?: unknown[] } | null;
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
