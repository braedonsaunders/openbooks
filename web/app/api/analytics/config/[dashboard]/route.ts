import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { ANALYTICS_CONFIG, mergeConfig, type AnalyticsDashboard } from "../../../../../lib/analytics/config";

export const runtime = "nodejs";

/** Dashboards that disappear when their parent Features switch is off. */
const DASHBOARD_FEATURE: Partial<Record<string, string>> = {
  utilization: "timeTracking",
};

/**
 * Per-org analytics dashboard settings, stored under
 * orgs.settings.analytics.<dashboard> with a sibling <dashboard>Revision
 * optimistic-concurrency token (the cashflow-categories shape — the sibling
 * key keeps every existing reader of the overrides blob compatible). GET
 * returns the effective (merged) config plus the defaults, the field spec,
 * and the revision; PUT replaces the dashboard's overrides (unknown keys
 * dropped, values clamped — see lib/analytics/config.ts) and requires the
 * exact revision from the last read. A stale token is a 409 carrying the
 * current values, so a later PUT can never silently restore another admin's
 * threshold to its stale value. Editing is gated on the same permission as
 * the Setup workspace.
 */
async function gateDashboard(permission: string, dashboard: string) {
  const gate = await guardPermission(permission);
  if (gate instanceof NextResponse) return gate;
  const featureKey = DASHBOARD_FEATURE[dashboard];
  if (featureKey && !(await isFeatureEnabled(gate.user.orgId, featureKey))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return gate;
}

/** Sibling OCC token for a dashboard's overrides (never inside the blob). */
function revisionKey(dashboard: string): string {
  return `${dashboard}Revision`;
}

function parseRevision(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) return null;
  const revision = Number(text);
  return Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER
    ? revision
    : null;
}

function revisionRequired(dashboard: string): string {
  return `the ${dashboard} configuration revision is required; reload and review the latest revision`;
}

function revisionConflict(dashboard: string): string {
  return `this ${dashboard} configuration changed after you opened it; the latest values are returned — reapply your change and save again`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ dashboard: string }> }) {
  const { dashboard } = await params;
  const gate = await gateDashboard("reports.read", dashboard);
  if (gate instanceof NextResponse) return gate;
  const spec = ANALYTICS_CONFIG[dashboard as AnalyticsDashboard];
  if (!spec) return NextResponse.json({ error: "unknown dashboard" }, { status: 404 });

  const r = ((await db.execute<{ cfg: unknown; rev: number }>(sql`
    select settings -> 'analytics' -> ${dashboard} as cfg,
           coalesce((settings -> 'analytics' ->> ${revisionKey(dashboard)})::int, 0) as rev
      from orgs where id = ${gate.user.orgId}
  `)));
  return NextResponse.json({
    values: mergeConfig(dashboard as AnalyticsDashboard, r.rows[0]?.cfg ?? null),
    defaults: spec.defaults,
    fields: spec.fields,
    revision: Number(r.rows[0]?.rev ?? 0),
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ dashboard: string }> }) {
  const { dashboard } = await params;
  const gate = await gateDashboard("admin.setup.manage", dashboard);
  if (gate instanceof NextResponse) return gate;
  const spec = ANALYTICS_CONFIG[dashboard as AnalyticsDashboard];
  if (!spec) return NextResponse.json({ error: "unknown dashboard" }, { status: 404 });

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { expectedRevision?: unknown; values?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "object body required" }, { status: 400 });

  const expectedRevision = parseRevision(body.expectedRevision);
  if (expectedRevision === null) {
    return NextResponse.json({ error: revisionRequired(dashboard) }, { status: 409 });
  }

  // Keep only known keys, clamped — then store the cleaned overrides verbatim.
  const cleaned = mergeConfig(dashboard as AnalyticsDashboard, body.values);

  // Lock and compare in the same transaction as the replacement. Concurrent
  // editors serialize on the org row, but serialization alone would still let
  // the second writer silently discard the first — the 409 forces a re-read.
  const outcome = await db.transaction(async (tx) => {
    const existing = await tx.execute<{ cfg: unknown; rev: number }>(sql`
      select settings -> 'analytics' -> ${dashboard} as cfg,
             coalesce((settings -> 'analytics' ->> ${revisionKey(dashboard)})::int, 0) as rev
        from orgs where id = ${gate.user.orgId} for update
    `);
    if (!existing.rows[0]) return { kind: "missing" as const };
    const currentRevision = Number(existing.rows[0].rev);
    if (currentRevision !== expectedRevision) {
      return {
        kind: "conflict" as const,
        revision: currentRevision,
        values: mergeConfig(dashboard as AnalyticsDashboard, existing.rows[0].cfg ?? null),
      };
    }
    const nextRevision = currentRevision + 1;
    await tx.execute(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
          array['analytics', ${dashboard}], ${JSON.stringify(cleaned)}::jsonb, true),
        array['analytics', ${revisionKey(dashboard)}], ${JSON.stringify(nextRevision)}::jsonb, true)
      where id = ${gate.user.orgId}
    `);
    return { kind: "ok" as const, revision: nextRevision };
  });

  if (outcome.kind === "missing") {
    return NextResponse.json({ error: "org not found" }, { status: 404 });
  }
  if (outcome.kind === "conflict") {
    return NextResponse.json(
      { error: revisionConflict(dashboard), revision: outcome.revision, values: outcome.values },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, values: cleaned, revision: outcome.revision });
}
