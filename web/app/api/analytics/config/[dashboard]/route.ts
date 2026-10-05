import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route'
import { NextResponse } from "next/server";
import { z } from 'zod'
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { Authz } from "@/lib/authz";
import { presentationCurrency } from "@/lib/fx-presentation";
import { ANALYTICS_DASHBOARD_MAP } from "@/lib/analytics/dashboard-catalog";
import { analyticsDashboardAvailable } from "@/lib/analytics/dashboard-access";
import {
  ANALYTICS_CONFIG,
  InvalidConfigValue,
  cleanConfigValues,
  configCurrencyKey,
  isAnalyticsDashboard,
  mergeConfig,
  type AnalyticsConfigValues,
  type AnalyticsDashboard,
} from "@/lib/analytics/config-spec";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/**
 * Per-org analytics dashboard settings, stored under
 * orgs.settings.analytics.<dashboard> with two sibling keys: a <dashboard>Revision
 * optimistic-concurrency token and a <dashboard>Currency stamp naming the
 * presentation currency the money thresholds were entered in. GET returns the
 * effective (merged) config, the defaults, the field spec, the ordered
 * ladders, the presentation currency and the revision; PUT replaces the
 * dashboard's overrides and requires the exact revision from the last read. A
 * stale token is a 409 carrying the current values, so a later PUT can never
 * silently restore another admin's threshold to its stale value.
 *
 * Both verbs answer only for a dashboard the caller can open: the same
 * permission and Company Features gate as the dashboard itself (the analytics
 * catalog entry named by the spec), so a switched-off feature's settings are
 * neither read nor written. Editing additionally needs the Setup permission.
 *
 * WRITE validation (cleanConfigValues) rejects malformed bodies with a named
 * 422; READ stays tolerant through mergeConfig for legacy stored settings.
 */
async function dashboardRefusal(authz: Authz, dashboard: string) {
  if (!isAnalyticsDashboard(dashboard)) return NextResponse.json({ error: "unknown dashboard" }, { status: 404 });
  const catalogEntry = ANALYTICS_DASHBOARD_MAP[ANALYTICS_CONFIG[dashboard].slug];
  if (!catalogEntry || !(await analyticsDashboardAvailable(authz, catalogEntry))) return notFound("record");
  return null;
}

const dashboardParams = z.object({ dashboard: z.string() })
const dashboardBody = z.strictObject({
  expectedRevision: z.union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/, 'expectedRevision must be a non-negative integer').transform(Number),
  ]).pipe(z.number().int().safe().nonnegative()).optional(),
  values: z.record(z.string(), z.union([z.number().finite(), z.string(), z.boolean()])),
})

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

export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: 'Dashboard access is governed by reports.read; utilization settings additionally require timeTracking.' },
  params: dashboardParams,
  handler: async ({ params, authz: gate }) => {
  const refusal = await dashboardRefusal(gate, params.dashboard)
  if (refusal) return refusal
  const dashboard = params.dashboard as AnalyticsDashboard;
  const spec = ANALYTICS_CONFIG[dashboard];

  const [r, currency] = await Promise.all([
    db.execute<{ cfg: unknown; rev: number; currency: string | null }>(sql`
      select settings -> 'analytics' -> ${dashboard} as cfg,
             coalesce((settings -> 'analytics' ->> ${revisionKey(dashboard)})::int, 0) as rev,
             settings -> 'analytics' ->> ${configCurrencyKey(dashboard)} as currency
        from orgs where id = ${gate.user.orgId}
    `),
    presentationCurrency(gate.user.orgId),
  ]);
  return NextResponse.json({
    values: mergeConfig(dashboard, r.rows[0]?.cfg ?? null, { stored: r.rows[0]?.currency ?? null, presentation: currency }),
    defaults: spec.defaults,
    fields: spec.fields,
    ordered: "ordered" in spec ? spec.ordered : [],
    groups: "groups" in spec ? spec.groups : [],
    currency,
    revision: Number(r.rows[0]?.rev ?? 0),
  });
  },
})

export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: 'Dashboard access is governed by admin.setup.manage; utilization settings additionally require timeTracking.' },
  scope: 'unrestricted',
  params: dashboardParams,
  body: dashboardBody,
  handler: async ({ params, authz: gate, body }) => {
  const refusal = await dashboardRefusal(gate, params.dashboard)
  if (refusal) return refusal
  const dashboard = params.dashboard as AnalyticsDashboard;

  // Missing revisions need the dashboard-specific reload remedy below;
  // malformed supplied revisions are rejected by the body schema.
  const expectedRevision = parseRevision(body.expectedRevision);
  if (expectedRevision === null) {
    return NextResponse.json({ error: revisionRequired(dashboard) }, { status: 409 });
  }

  // Strict write validation: refuse unknown keys, missing thresholds, wrong
  // types, and out-of-range values with a named 422 before any lock or write.
  let cleaned: AnalyticsConfigValues;
  try {
    cleaned = cleanConfigValues(dashboard, body.values);
  } catch (error) {
    if (error instanceof InvalidConfigValue) {
      return apiErrorResponse(error, { safeStatus: 422 });
    }
    throw error;
  }

  // Lock the current overrides, compare, and commit the replacement together
  // with complete before/after audit evidence. Concurrent editors serialize
  // on the org row, but serialization alone would still let the second writer
  // silently discard the first — the 409 forces a re-read.
  const currency = await presentationCurrency(gate.user.orgId);
  const outcome = await db.transaction(async (tx) => {
    const existing = await tx.execute<{ cfg: unknown; rev: number; currency: string | null }>(sql`
      select settings -> 'analytics' -> ${dashboard} as cfg,
             coalesce((settings -> 'analytics' ->> ${revisionKey(dashboard)})::int, 0) as rev,
             settings -> 'analytics' ->> ${configCurrencyKey(dashboard)} as currency
        from orgs where id = ${gate.user.orgId} for update
    `);
    if (!existing.rows[0]) return { kind: "missing" as const };
    const currentRevision = Number(existing.rows[0].rev);
    if (currentRevision !== expectedRevision) {
      return {
        kind: "conflict" as const,
        revision: currentRevision,
        values: mergeConfig(dashboard, existing.rows[0].cfg ?? null, { stored: existing.rows[0].currency, presentation: currency }),
      };
    }
    const beforeCurrency = existing.rows[0].currency;
    const rawBefore = existing.rows[0].cfg;
    const before = rawBefore && typeof rawBefore === "object" ? rawBefore : {};
    const nextRevision = currentRevision + 1;
    const updated = await tx.execute(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
            array['analytics', ${dashboard}], ${JSON.stringify(cleaned)}::jsonb, true),
          array['analytics', ${revisionKey(dashboard)}], ${JSON.stringify(nextRevision)}::jsonb, true),
        -- The currency stamp makes every money threshold an amount IN a currency.
        array['analytics', ${configCurrencyKey(dashboard)}], to_jsonb(${currency}::text), true)
      where id = ${gate.user.orgId}
    `);
    // A write that matches zero rows is a failure, not a save: under RLS an
    // unscoped UPDATE silently matches nothing and reports success.
    if ((updated.rowCount ?? 0) !== 1) return { kind: "unwritten" as const };
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${gate.user.orgId}, 'orgs', ${gate.user.orgId}, 'update',
        ${JSON.stringify({
          before: { analytics: { [dashboard]: before, [revisionKey(dashboard)]: currentRevision, [configCurrencyKey(dashboard)]: beforeCurrency } },
          after: { analytics: { [dashboard]: cleaned, [revisionKey(dashboard)]: nextRevision, [configCurrencyKey(dashboard)]: currency } },
        })}::jsonb,
        ${gate.user.id}
      )
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
  if (outcome.kind === "unwritten") {
    return NextResponse.json(
      { error: `the ${dashboard} configuration was not saved — reload and retry` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, values: cleaned, revision: outcome.revision });
  },
})
