import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { ANALYTICS_CONFIG, mergeConfig, type AnalyticsDashboard } from "../../../../../lib/analytics/config";

export const runtime = "nodejs";

/**
 * Per-org analytics dashboard settings, stored under
 * orgs.settings.analytics.<dashboard>. GET returns the effective (merged)
 * config plus the defaults; PUT overwrites the dashboard's overrides (unknown
 * keys dropped, values clamped — see lib/analytics/config.ts). Editing is
 * gated on the same permission as the Setup workspace.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ dashboard: string }> }) {
  const gate = await guardPermission("reports.read");
  if (gate instanceof NextResponse) return gate;
  const { dashboard } = await params;
  const spec = ANALYTICS_CONFIG[dashboard as AnalyticsDashboard];
  if (!spec) return NextResponse.json({ error: "unknown dashboard" }, { status: 404 });

  const r = (await db.execute(sql`
    select settings -> 'analytics' -> ${dashboard} as cfg from orgs where id = ${gate.user.orgId}
  `)) as any;
  return NextResponse.json({
    values: mergeConfig(dashboard as AnalyticsDashboard, r.rows[0]?.cfg ?? null),
    defaults: spec.defaults,
    fields: spec.fields,
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ dashboard: string }> }) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { dashboard } = await params;
  const spec = ANALYTICS_CONFIG[dashboard as AnalyticsDashboard];
  if (!spec) return NextResponse.json({ error: "unknown dashboard" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "object body required" }, { status: 400 });

  // Keep only known keys, clamped — then store the cleaned overrides verbatim.
  const cleaned = mergeConfig(dashboard as AnalyticsDashboard, body);

  await db.execute(sql`
    update orgs
    set settings = jsonb_set(
      jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
      array['analytics', ${dashboard}], ${JSON.stringify(cleaned)}::jsonb, true)
    where id = ${gate.user.orgId}
  `);
  return NextResponse.json({ ok: true, values: cleaned });
}
