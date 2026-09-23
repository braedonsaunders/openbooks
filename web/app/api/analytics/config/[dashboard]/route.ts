import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { canonicalDecimal, compareDecimal } from "../../../../../lib/exact-decimal";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import {
  ANALYTICS_CONFIG,
  mergeConfig,
  type AnalyticsConfigValues,
  type AnalyticsDashboard,
  type ConfigField,
} from "../../../../../lib/analytics/config";

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
 * and the revision; PUT replaces the dashboard's overrides and requires the
 * exact revision from the last read. A stale token is a 409 carrying the
 * current values, so a later PUT can never silently restore another admin's
 * threshold to its stale value. Editing is gated on the same permission as
 * the Setup workspace.
 *
 * WRITE validation is strict per field (types, ranges, no unknown keys — a
 * named 422 otherwise), because the merge-and-clamp reader exists to stay
 * tolerant of legacy stored settings, not to silently rewrite what an admin
 * asked to save. READ stays tolerant: mergeConfig still clamps legacy blobs.
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

class InvalidDashboardValue extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidDashboardValue";
  }
}

function fieldName(field: ConfigField): string {
  return `'${field.label}' (${field.key})`;
}

/**
 * Strict plain-number parsing with no coercion: null, "", booleans,
 * thousands separators, and scientific notation all refuse rather than
 * becoming 0 or a guess.
 */
function strictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanThresholdValue(
  dashboard: string,
  field: ConfigField,
  value: unknown,
): number | string {
  if (dashboard === "cashflow" && field.key === "weeklyApCap") {
    const exact = canonicalDecimal(value, 4);
    if (exact === null) {
      throw new InvalidDashboardValue(
        field.key,
        `threshold ${fieldName(field)} must be a non-negative dollar amount with at most 4 decimal places — enter a plain number like 5000 or 5000.25`,
      );
    }
    if (compareDecimal(exact, "0") < 0 || compareDecimal(exact, "100000000") > 0) {
      throw new InvalidDashboardValue(
        field.key,
        `threshold ${fieldName(field)} must be between 0 and 100000000`,
      );
    }
    try {
      return normalizeMoney(exact);
    } catch {
      throw new InvalidDashboardValue(
        field.key,
        `threshold ${fieldName(field)} must be a non-negative dollar amount with at most 4 decimal places — enter a plain number like 5000 or 5000.25`,
      );
    }
  }
  if (dashboard === "cashflow" && field.key === "restrictToSafe") {
    if (value === 0 || value === 1 || value === "0" || value === "1") return Number(value);
    throw new InvalidDashboardValue(
      field.key,
      `threshold ${fieldName(field)} must be 0 or 1`,
    );
  }
  const parsed = strictNumber(value);
  if (parsed === null) {
    throw new InvalidDashboardValue(
      field.key,
      `threshold ${fieldName(field)} must be a number between ${field.min} and ${field.max}`,
    );
  }
  if (parsed < field.min || parsed > field.max) {
    throw new InvalidDashboardValue(
      field.key,
      `threshold ${fieldName(field)} must be between ${field.min} and ${field.max} (received ${String(value).slice(0, 60)})`,
    );
  }
  return parsed;
}

/**
 * Strict per-dashboard write validator built from the single field spec the
 * form renders: every threshold required on each whole-object save, unknown
 * keys refused, each value type- and range-checked with a named 422. Never
 * the tolerant mergeConfig — that reader clamps legacy stored settings, and
 * using it at write would persist something other than what was requested.
 */
function cleanDashboardOverrides(dashboard: AnalyticsDashboard, raw: unknown): AnalyticsConfigValues {
  const spec = ANALYTICS_CONFIG[dashboard]!;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidDashboardValue(
      "",
      `threshold values for the ${dashboard} configuration must be an object of per-threshold values`,
    );
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(spec.fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new InvalidDashboardValue(
        key,
        `unknown threshold '${key}' for the ${dashboard} configuration — remove it and retry`,
      );
    }
  }
  const out: Record<string, number | string> = {};
  for (const field of spec.fields) {
    if (!(field.key in input)) {
      throw new InvalidDashboardValue(
        field.key,
        `threshold ${fieldName(field)} is required — send every threshold on each save`,
      );
    }
    out[field.key] = cleanThresholdValue(dashboard, field, input[field.key]);
  }
  return out;
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

  // Strict write validation: refuse unknown keys, missing thresholds, wrong
  // types, and out-of-range values with a named 422 before any lock or write.
  let cleaned: AnalyticsConfigValues;
  try {
    cleaned = cleanDashboardOverrides(dashboard as AnalyticsDashboard, body.values);
  } catch (error) {
    if (error instanceof InvalidDashboardValue) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }

  // Lock the current overrides, compare, and commit the replacement together
  // with complete before/after audit evidence. Concurrent editors serialize
  // on the org row, but serialization alone would still let the second writer
  // silently discard the first — the 409 forces a re-read.
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
    const rawBefore = existing.rows[0].cfg;
    const before = rawBefore && typeof rawBefore === "object" ? rawBefore : {};
    const nextRevision = currentRevision + 1;
    const updated = await tx.execute(sql`
      update orgs
      set settings = jsonb_set(
        jsonb_set(
          jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
          array['analytics', ${dashboard}], ${JSON.stringify(cleaned)}::jsonb, true),
        array['analytics', ${revisionKey(dashboard)}], ${JSON.stringify(nextRevision)}::jsonb, true)
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
          before: { analytics: { [dashboard]: before, [revisionKey(dashboard)]: currentRevision } },
          after: { analytics: { [dashboard]: cleaned, [revisionKey(dashboard)]: nextRevision } },
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
}
