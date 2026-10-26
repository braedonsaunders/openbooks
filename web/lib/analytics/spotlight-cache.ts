import "server-only";
import { after } from "next/server";
import { requirePermission } from "../authz";
import type { AnalyticsDashboardDefinition, AnalyticsSpotlight } from "./dashboard-catalog";
import { analyticsDashboardSpotlight } from "./dashboard-spotlight";
import { latestProjection, rebuildProjection } from "./latest-projection";
import { analyticsCacheIdentity, analyticsPreviewKey } from "./preview-cache";
import { analyticsSourceQuery } from "./query-params";

/**
 * Spotlights answer from their latest projection while a newer one is built.
 *
 * A home dashboard opens every spotlight at once, and each one projects a
 * whole Analytics dashboard. Recomputing all of them on every visit after
 * the short shared-figure window would hold each card on a cold calculation.
 * A refreshing spotlight is served with its calculation time — the card
 * shows it and asks again — while one background build replaces it. The key
 * carries the caller's grants and subsidiary scope, so equally authorized
 * operators share work and no one reads a projection built for a wider
 * fence.
 */
export async function cachedDashboardSpotlight(
  dashboard: AnalyticsDashboardDefinition,
  sp: Record<string, string | undefined>,
  orgId: string,
): Promise<AnalyticsSpotlight> {
  const authz = await requirePermission("reports.read");
  const query = analyticsSourceQuery(sp, dashboard.slug);
  const { locale, revision } = await analyticsCacheIdentity(orgId);
  const key = analyticsPreviewKey(authz, `spotlight:${dashboard.slug}`, query, locale, "latest");
  const build = () => analyticsDashboardSpotlight(dashboard, sp, orgId);
  const observedAt = (data: AnalyticsSpotlight) => data.observedAt;
  const projection = await latestProjection(key, revision, build, observedAt);
  if (!projection.refreshing) return projection.data;
  // A failed background build leaves the previous projection in place for
  // the next request to retry.
  after(() =>
    rebuildProjection(key, revision, build, observedAt).then(
      () => undefined,
      () => undefined,
    ),
  );
  return { ...projection.data, refreshing: true };
}
