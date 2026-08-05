import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Per-organization analytics dashboard settings for the editable Configuration
 * tabs. Stored in `orgs.settings.analytics.<dashboard>`
 * (no new table); unknown keys are ignored and every value is clamped to its
 * field's range, so a hand-edited settings blob can't break a dashboard.
 */

export interface ConfigField {
  key: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

export const ANALYTICS_CONFIG: Record<string, { fields: ConfigField[]; defaults: Record<string, number> }> = {
  financialHealth: {
    defaults: {
      grossMarginTarget: 40,
      operatingMarginTarget: 15,
      ebitdaMarginTarget: 20,
      netMarginTarget: 10,
      roaTarget: 8,
      roeTarget: 15,
      roicTarget: 12,
      revenuePerEmployee: 200_000,
      gpPerEmployee: 80_000,
    },
    fields: [
      { key: "grossMarginTarget", label: "Gross margin target (%)", help: "Benchmark for the Gross Margin grade", min: 0, max: 100, step: 1 },
      { key: "operatingMarginTarget", label: "Operating margin target (%)", help: "Benchmark for the Operating Margin grade", min: 0, max: 100, step: 1 },
      { key: "ebitdaMarginTarget", label: "EBITDA margin target (%)", help: "Benchmark for the EBITDA Margin grade", min: 0, max: 100, step: 1 },
      { key: "netMarginTarget", label: "Net margin target (%)", help: "Bottom-line profitability benchmark", min: 0, max: 100, step: 1 },
      { key: "roaTarget", label: "Return on assets target (%)", help: "Benchmark for the ROA grade (needs balance-sheet data)", min: 0, max: 100, step: 1 },
      { key: "roeTarget", label: "Return on equity target (%)", help: "Benchmark for the ROE grade (needs balance-sheet data)", min: 0, max: 100, step: 1 },
      { key: "roicTarget", label: "Return on invested capital target (%)", help: "Benchmark for the ROIC grade (needs balance-sheet data)", min: 0, max: 100, step: 1 },
      { key: "revenuePerEmployee", label: "Revenue per employee ($)", help: "Workforce productivity benchmark", min: 0, max: 10_000_000, step: 5_000 },
      { key: "gpPerEmployee", label: "Gross profit per employee ($)", help: "Workforce productivity benchmark", min: 0, max: 10_000_000, step: 5_000 },
    ],
  },
  customerIntelligence: {
    defaults: {
      churnCriticalScore: 70,
      churnHighScore: 50,
      churnMediumScore: 30,
      hhiWarning: 1500,
      hhiCritical: 2500,
      clvYears: 3,
    },
    fields: [
      { key: "churnCriticalScore", label: "Churn — critical (score)", help: "Composite churn score at or above this reads as critical risk", min: 1, max: 100, step: 1 },
      { key: "churnHighScore", label: "Churn — high (score)", help: "Composite churn score at or above this reads as high risk", min: 1, max: 100, step: 1 },
      { key: "churnMediumScore", label: "Churn — medium (score)", help: "Composite churn score at or above this reads as medium risk", min: 1, max: 100, step: 1 },
      { key: "hhiWarning", label: "Concentration warning (HHI)", help: "Herfindahl index at or above this flags a concentration warning", min: 0, max: 10_000, step: 100 },
      { key: "hhiCritical", label: "Concentration critical (HHI)", help: "Herfindahl index at or above this flags critical concentration", min: 0, max: 10_000, step: 100 },
      { key: "clvYears", label: "CLV projection horizon (years)", help: "Years of forward value in the customer lifetime value projection", min: 1, max: 10, step: 1 },
    ],
  },
  utilization: {
    defaults: { targetBillablePct: 70, costSpikeThreshold: 1000, minHours: 10 },
    fields: [
      { key: "targetBillablePct", label: "Target billable %", help: "Departments and employees below this read as under-target", min: 10, max: 100, step: 1 },
      { key: "costSpikeThreshold", label: "Cost spike threshold ($)", help: "Alert when non-billable cost rises more than this vs the prior period", min: 0, max: 1_000_000, step: 100 },
      { key: "minHours", label: "Minimum hours", help: "Employees under this many hours are excluded from anomaly / peer analysis", min: 0, max: 500, step: 1 },
    ],
  },
  sentinel: {
    defaults: { duplicateDays: 14, duplicateMinAmount: 100, sequentialMinCount: 3, sequentialMinDays: 7 },
    fields: [
      { key: "duplicateDays", label: "Duplicate window (days)", help: "Same vendor, kind and amount within this many days flags a pair", min: 1, max: 90, step: 1 },
      { key: "duplicateMinAmount", label: "Duplicate minimum ($)", help: "Pairs below this amount are ignored", min: 0, max: 100_000, step: 50 },
      { key: "sequentialMinCount", label: "Sequential run minimum", help: "Gap-free invoice-number runs need at least this many documents", min: 2, max: 50, step: 1 },
      { key: "sequentialMinDays", label: "Sequential span (days)", help: "Runs spread over fewer days than this are treated as batch entry, not a flag", min: 1, max: 365, step: 1 },
    ],
  },
  cashflow: {
    defaults: { weeklyApCap: 0, restrictToSafe: 0 },
    fields: [
      { key: "weeklyApCap", label: "Weekly AP cap ($)", help: "Maximum payables paid per week — 0 means unlimited (no scheduling)", min: 0, max: 100_000_000, step: 1000 },
      { key: "restrictToSafe", label: "Restrict to safe capacity (0/1)", help: "1 = never schedule payments beyond available cash that week; overflow defers", min: 0, max: 1, step: 1 },
    ],
  },
  spendVelocity: {
    defaults: {
      velocityHighThreshold: 15,
      velocityMediumThreshold: 5,
      anomalyStdDevThreshold: 2.5,
      boilingFrogMonths: 6,
      zombieMinMonths: 6,
      fragmentationMinTxns: 20,
      fragmentationMaxAvgSize: 500,
    },
    fields: [
      { key: "velocityHighThreshold", label: "High velocity (%/mo)", help: "Monthly CAGR above this classifies as accelerating/high", min: 1, max: 100, step: 1 },
      { key: "velocityMediumThreshold", label: "Medium velocity (%/mo)", help: "Monthly CAGR above this classifies as rising", min: 0, max: 50, step: 1 },
      { key: "anomalyStdDevThreshold", label: "Anomaly σ", help: "Months beyond this many standard deviations flag as anomalies (critical at σ+0.5)", min: 1, max: 6, step: 0.1 },
      { key: "boilingFrogMonths", label: "Boiling frog months", help: "Minimum months of sustained small increases", min: 3, max: 24, step: 1 },
      { key: "zombieMinMonths", label: "Zombie months", help: "Identical monthly vendor totals for at least this many months", min: 3, max: 24, step: 1 },
      { key: "fragmentationMinTxns", label: "Fragmentation txns/mo", help: "More monthly transactions than this (below the size cap) flags fragmentation", min: 5, max: 500, step: 5 },
      { key: "fragmentationMaxAvgSize", label: "Fragmentation avg size ($)", help: "Average transaction size cap for the fragmentation detector", min: 50, max: 10_000, step: 50 },
    ],
  },
};

export type AnalyticsDashboard = keyof typeof ANALYTICS_CONFIG;

function clampTo(field: ConfigField, v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(field.max, Math.max(field.min, n));
}

/** Merge stored per-org overrides over the defaults, clamped per field. */
export function mergeConfig(dashboard: AnalyticsDashboard, stored: unknown): Record<string, number> {
  const spec = ANALYTICS_CONFIG[dashboard]!;
  const out = { ...spec.defaults };
  if (stored && typeof stored === "object") {
    for (const f of spec.fields) {
      const v = clampTo(f, (stored as Record<string, unknown>)[f.key]);
      if (v !== null) out[f.key] = v;
    }
  }
  return out;
}

/** Effective config for one dashboard: org overrides over defaults. */
export async function analyticsConfig(orgId: string, dashboard: AnalyticsDashboard): Promise<Record<string, number>> {
  const r = (await db.execute(sql`
    select settings -> 'analytics' -> ${dashboard} as cfg from orgs where id = ${orgId}
  `)) as any;
  return mergeConfig(dashboard, r.rows[0]?.cfg ?? null);
}
