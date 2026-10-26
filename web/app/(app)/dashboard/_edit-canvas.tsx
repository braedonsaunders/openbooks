import "server-only";
import { getLocale } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { Suspense, type ReactNode } from "react";
import type { DashboardLayoutData } from "@openbooks/schema";
import type { Authz } from "@/lib/authz";
import { insightVisibilitySql } from "@/lib/insight-access";
import { getAuthz, can } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { WIDGETS, isSpotlightWidget } from "./_widget-registry";
import { AnalyticsWidgetPreview, WidgetCard } from "./_widget-views";
import { WidgetSkeleton } from "./_widget-tiles";
import type { AllowedWidgetIds } from "./widget-features";
import { EMPTY_DASHBOARD_METRICS, pruneDashboardMetrics, widgetReadsMetrics } from "./_metrics";
import { dashboardGroupProjection } from "./_projection";
import { ProjectionFrame } from "./_projection-frame";
import type { LatestProjection } from "@/lib/analytics/latest-projection";
import type { DashboardMetrics } from "./_metrics";
import { CardTile, type CardTileData } from "../insights/CardTile";
import type { InsightQuery, VizSettings, VizType } from "@openbooks/analytics";
import { listApps } from "@/lib/apps/store";
import { appKeyFromWidgetId, appWidgetId } from "@/lib/apps/surfaces";
import { AppWidgetCard, type DashboardApp } from "./_app-widget";

export type LibraryCard = { id: string; name: string; description: string };

export async function loadDashboardApps(authz: Authz): Promise<DashboardApp[]> {
  if (!can(authz, "apps.use")) return [];
  const apps = await listApps(authz.user.orgId);
  return apps
    .filter((app) => app.status === "installed" && app.activeVersionId)
    .map((app) => ({
      key: app.key,
      name: app.name,
      description: app.description ?? "",
      iconKey: app.iconKey,
    }));
}

function appWidgetNodes(
  apps: DashboardApp[],
  widgetIds?: readonly string[],
): Record<string, ReactNode> {
  const requested = widgetIds
    ? new Set(widgetIds.map(appKeyFromWidgetId).filter((key): key is string => !!key))
    : null;
  return Object.fromEntries(
    apps
      .filter((app) => !requested || requested.has(app.key))
      .map((app) => [appWidgetId(app.key), <AppWidgetCard key={app.key} app={app} />]),
  );
}

export async function loadPublishedInsightCards(orgId: string): Promise<LibraryCard[]> {
  const authz = await getAuthz();
  if (!authz || authz.user.orgId !== orgId) return [];
  const res = await db.execute(
    sql`
    select id, name, coalesce(description, '') as description
      from insight_cards
     where org_id = ${orgId} and status = 'published' and ${insightVisibilitySql(authz)}
     order by name asc
  `,
    "objects",
  );
  return res as LibraryCard[];
}

async function loadInsightCardNodes(
  authz: Authz,
  widgetIds: string[],
): Promise<Record<string, ReactNode>> {
  const orgId = authz.user.orgId;
  const uuidIds = widgetIds.filter((id) => isUuid(id));
  if (uuidIds.length === 0) return {};
  const res = await db.execute<{
    id: string;
    name: string;
    description: string | null;
    query: InsightQuery;
    viz_type: VizType;
    viz_settings: VizSettings;
  }>(
    sql`
    select id, name, description, query, viz_type, viz_settings
      from insight_cards
     where org_id = ${orgId} and id = any(${`{${uuidIds.join(",")}}`}::uuid[])
       and status = 'published' and ${insightVisibilitySql(authz)}
  `,
    "objects",
  );
  const nodes: Record<string, ReactNode> = {};
  for (const row of res) {
    const data: CardTileData = {
      id: row.id,
      name: row.name,
      description: row.description,
      query: row.query,
      vizType: row.viz_type,
      vizSettings: row.viz_settings ?? {},
    };
    nodes[row.id] = <CardTile key={row.id} card={data} />;
  }
  return nodes;
}

/**
 * Tiles drawing on one Analytics dashboard share that dashboard's reader
 * context, so they load together; every other tile loads on its own.
 */
function metricGroups(ids: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const source = WIDGETS[id]?.analyticsSource;
    const key = source ? `analytics:${source}` : `tile:${id}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups.values()];
}

async function MeteredWidget({
  widgetId,
  group,
  projection,
}: {
  widgetId: string;
  group: readonly string[];
  projection: Promise<LatestProjection<DashboardMetrics>>;
}) {
  const { data, observedAt, refreshing } = await projection;
  // Each widget card is a client component: hand it only the metric fields
  // it renders, never the whole org-wide metrics object.
  return (
    <ProjectionFrame group={group} observedAt={observedAt} refreshing={refreshing}>
      <WidgetCard widgetId={widgetId} data={pruneDashboardMetrics(data, [widgetId])} />
    </ProjectionFrame>
  );
}

/**
 * Registry tile nodes that stream independently. Every group's read starts
 * now, and each tile renders as soon as its own group settles, so one slow
 * reader never holds the whole dashboard. A group answers from its latest
 * projection when one is kept, so a repeat visit renders at once. Tiles that
 * read no server metrics (spotlights fetch their own projection) render at
 * once.
 */
function streamedWidgetNodes(
  authz: Authz,
  ids: readonly string[],
  locale: string,
): Record<string, ReactNode> {
  const nodes: Record<string, ReactNode> = {};
  const metered = ids.filter(widgetReadsMetrics);
  for (const id of ids) {
    if (!widgetReadsMetrics(id))
      nodes[id] = <WidgetCard key={id} widgetId={id} data={EMPTY_DASHBOARD_METRICS} />;
  }
  for (const group of metricGroups(metered)) {
    const projection = dashboardGroupProjection(authz, group, locale);
    // The tile awaiting this read reports its failure; this only keeps an
    // early rejection from surfacing as unhandled before that tile renders.
    projection.catch(() => undefined);
    for (const id of group) {
      nodes[id] = (
        <Suspense key={id} fallback={<WidgetSkeleton />}>
          <MeteredWidget widgetId={id} group={group} projection={projection} />
        </Suspense>
      );
    }
  }
  return nodes;
}

export async function loadDashboardView(
  authz: Authz,
  layout: DashboardLayoutData,
  /**
   * REQUIRED: the entry boundary's resolved set (view slot), carrying both
   * the permission decision and the feature gates. The canvas never resolves
   * features itself, so layout prune, node selection, and metric selection
   * below all enforce the same ids the slot filtered on. Non-registry
   * insight-card UUIDs and app tiles keep resolving through canSeeWidget.
   */
  allowedWidgetIds: AllowedWidgetIds,
): Promise<{ nodes: Record<string, ReactNode> }> {
  // The layout arriving here is already filtered by the slot on this same
  // set, but the allowedWidgetIds check below is the enforcement point —
  // derive the loader's query set from exactly the ids that survive it, so
  // a denied widget's reader never runs.
  const visibleIds = layout.widgets
    .map((w) => w.id)
    .filter((id) => id in WIDGETS && allowedWidgetIds.has(id));
  // Week labels on the forecast chart localize to the request locale — the
  // position reader defaults to en-US without one.
  const locale = await getLocale();
  const tiles = streamedWidgetNodes(authz, visibleIds, locale);
  const [cardNodes, apps] = await Promise.all([
    loadInsightCardNodes(
      authz,
      layout.widgets.map((w) => w.id),
    ),
    layout.widgets.some((widget) => appKeyFromWidgetId(widget.id))
      ? loadDashboardApps(authz)
      : Promise.resolve([]),
  ]);

  const nodes: Record<string, ReactNode> = {};
  for (const w of layout.widgets) {
    if (tiles[w.id] !== undefined) nodes[w.id] = tiles[w.id];
  }
  Object.assign(nodes, cardNodes);
  Object.assign(
    nodes,
    appWidgetNodes(
      apps,
      layout.widgets.map((widget) => widget.id),
    ),
  );
  return { nodes };
}

export async function loadDashboardEditCanvas(
  authz: Authz,
  layout: DashboardLayoutData,
  opts: {
    /**
     * REQUIRED: the entry boundary's resolved set (edit slot), carrying both
     * the permission decision and the feature gates. The canvas never
     * resolves features itself and never falls back to permission-only for
     * registry ids: an id absent from this set renders no preview node and
     * feeds no metric reader.
     */
    allowedWidgetIds: AllowedWidgetIds;
  },
): Promise<{
  nodes: Record<string, ReactNode>;
  libraryCards: LibraryCard[];
  apps: DashboardApp[];
}> {
  const widgetAllowed = (id: string) => opts.allowedWidgetIds.has(id);
  const canUseInsights = can(authz, "insights.read");

  // Only placed widgets need figures when the editor opens. Built-in tiles
  // added to the draft load their preview through a fresh server boundary;
  // unplaced Analytics tiles retain their save-to-preview composition.
  const placed = new Set(layout.widgets.map((w) => w.id));
  const previewIds = Object.keys(WIDGETS).filter((id) => widgetAllowed(id) && placed.has(id));
  const previewSet = new Set(previewIds);
  const previewLocale = await getLocale();
  const placedTiles = streamedWidgetNodes(authz, previewIds, previewLocale);
  const [libraryCards, placedCardNodes, apps] = await Promise.all([
    canUseInsights
      ? loadPublishedInsightCards(authz.user.orgId)
      : Promise.resolve([] as LibraryCard[]),
    loadInsightCardNodes(
      authz,
      layout.widgets.filter((w) => isUuid(w.id)).map((w) => w.id),
    ),
    loadDashboardApps(authz),
  ]);

  const nodes: Record<string, ReactNode> = {};
  for (const id of Object.keys(WIDGETS)) {
    if (!widgetAllowed(id)) continue;
    if (!previewSet.has(id)) {
      // Spotlights read their own projection, so an unsaved one previews live.
      if (isSpotlightWidget(id))
        nodes[id] = <WidgetCard key={id} widgetId={id} data={EMPTY_DASHBOARD_METRICS} />;
      else if (WIDGETS[id]!.analyticsSource)
        nodes[id] = <AnalyticsWidgetPreview key={id} widgetId={id} />;
      continue;
    }
    nodes[id] = placedTiles[id];
  }
  Object.assign(nodes, placedCardNodes);
  Object.assign(nodes, appWidgetNodes(apps));

  return { nodes, libraryCards, apps };
}

export type { DashboardMetrics };
