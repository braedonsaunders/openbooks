import "server-only";
import { sql } from "drizzle-orm";
import { analyticsQuery } from "./query";
import { presentationCurrency } from "../fx-presentation";
import {
  configCurrencyKey,
  mergeConfig,
  type AnalyticsDashboard,
  type ConfigValuesOf,
} from "./config-spec";

/**
 * Per-organization analytics dashboard settings, stored in
 * `orgs.settings.analytics.<dashboard>` with sibling revision and currency
 * keys. The specification (fields, kinds, defaults, ordered ladders) lives in
 * ./config-spec.ts; this module is the one server reader every loader uses.
 */

export {
  ANALYTICS_CONFIG,
  analyticsConfigSpec,
  mergeConfig,
  type AnalyticsConfigSpec,
  type AnalyticsConfigValues,
  type AnalyticsDashboard,
  type CashflowConfig,
  type ConfigField,
  type ConfigValuesOf,
} from "./config-spec";

/** Effective config for one dashboard: org overrides over defaults. */
export async function analyticsConfig<D extends AnalyticsDashboard>(orgId: string, dashboard: D): Promise<ConfigValuesOf<D>> {
  const [r, presentation] = await Promise.all([
    analyticsQuery<{ cfg: unknown; currency: string | null }>(sql`
      select settings -> 'analytics' -> ${dashboard} as cfg,
             settings -> 'analytics' ->> ${configCurrencyKey(dashboard)} as currency
        from orgs where id = ${orgId}
    `),
    presentationCurrency(orgId),
  ]);
  const row = r.rows[0];
  return mergeConfig(dashboard, row?.cfg ?? null, { stored: row?.currency ?? null, presentation });
}
