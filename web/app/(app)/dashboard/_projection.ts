import "server-only";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import type { Authz } from "@/lib/authz";
import {
  latestProjection,
  rebuildProjection,
  type LatestProjection,
} from "@/lib/analytics/latest-projection";
import { analyticsCacheIdentity, analyticsPreviewKey } from "@/lib/analytics/preview-cache";
import { WIDGETS } from "./_widget-registry";
import {
  loadDashboardMetrics,
  pruneDashboardMetrics,
  widgetReadsLiveMetrics,
  type DashboardMetrics,
} from "./_metrics";

/**
 * Dashboard tile figures answer from their latest projection.
 *
 * A tile group's figures are read once and kept: a later visit renders the
 * last projection at once, marked with its calculation time when a write or
 * the passing of the freshness window may have changed it, and the page asks
 * for a rebuild and re-renders when it is ready. Tiles over the viewer's own
 * work queue are read live instead. The key carries the viewer as well as
 * their grants and subsidiary scope, so a projection is only ever read by
 * the person it was built for. The organization's business day travels with
 * the revision, so a new day re-reads every figure.
 */
async function projectionIdentity(authz: Authz, group: readonly string[], locale: string) {
  const [{ revision }, today] = await Promise.all([
    analyticsCacheIdentity(authz.user.orgId),
    businessToday(authz.user.orgId),
  ]);
  const ids = [...group].sort();
  return {
    key: analyticsPreviewKey(
      authz,
      "dashboard-tiles",
      { user: authz.user.id, widgets: ids.join(",") },
      locale,
      "latest",
    ),
    revision: `${revision}|${today}`,
    build: async () =>
      pruneDashboardMetrics(await loadDashboardMetrics(authz, ids, undefined, locale), ids),
  };
}

export async function dashboardGroupProjection(
  authz: Authz,
  group: readonly string[],
  locale: string,
): Promise<LatestProjection<DashboardMetrics>> {
  if (group.some(widgetReadsLiveMetrics)) {
    const observedAt = new Date().toISOString();
    return {
      data: await loadDashboardMetrics(authz, group, undefined, locale),
      observedAt,
      refreshing: false,
    };
  }
  const { key, revision, build } = await projectionIdentity(authz, group, locale);
  return latestProjection(key, revision, build);
}

/** Rebuild the named tile groups the viewer may see; ids outside their set
 * are dropped, and groups read live keep no projection to rebuild. */
export async function refreshDashboardGroups(
  authz: Authz,
  groups: readonly (readonly string[])[],
  allowed: ReadonlySet<string>,
  locale: string,
): Promise<number> {
  const visible = groups
    .map((group) => group.filter((id) => id in WIDGETS && allowed.has(id)))
    .filter((group) => group.length > 0 && !group.some(widgetReadsLiveMetrics));
  await Promise.all(
    visible.map(async (group) => {
      const { key, revision, build } = await projectionIdentity(authz, group, locale);
      await rebuildProjection(key, revision, build);
    }),
  );
  return visible.length;
}
