import "server-only";
import { after } from "next/server";
import {
  claimSharedCache,
  publishSharedCache,
  readSharedCache,
  releaseSharedCache,
} from "@openbooks/jobs/read-cache";
import { requirePermission } from "../authz";
import type { AnalyticsDashboardDefinition, AnalyticsSpotlight } from "./dashboard-catalog";
import { analyticsDashboardSpotlight } from "./dashboard-spotlight";
import { ANALYTICS_PREVIEW_FRESHNESS_MS } from "./preview-invalidation";
import { analyticsCacheIdentity, analyticsPreviewKey } from "./preview-cache";
import { analyticsSourceQuery } from "./query-params";

/**
 * Spotlights answer from their last projection while a newer one is built.
 *
 * A home dashboard opens every spotlight at once, and each one projects a
 * whole Analytics dashboard. Recomputing all of them on every visit after
 * the short shared-figure window would hold each card on a cold calculation.
 * Instead a spotlight keeps its latest projection for a day: within the
 * freshness window, and while no posting has advanced the organization's
 * analytics revision, it is served as current; otherwise it is served with
 * `refreshing` set — the card shows when it was calculated — and one
 * background build replaces it. A missing or expired projection is built
 * before answering. The key carries the caller's grants and subsidiary
 * scope, so equally authorized operators share work and no one reads a
 * projection built for a wider fence.
 */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LOCAL = 256;
type Stored = { version: 1; revision: string; observedAt: string; data: AnalyticsSpotlight };

const local = new Map<string, Stored>();
const building = new Map<string, Promise<Stored>>();

function remember(key: string, value: Stored) {
  local.delete(key);
  if (local.size >= MAX_LOCAL) local.delete(local.keys().next().value!);
  local.set(key, value);
}

function decode(raw: string | null | undefined): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Stored;
    return value.version === 1 &&
      typeof value.revision === "string" &&
      typeof value.observedAt === "string" &&
      value.data
      ? value
      : null;
  } catch {
    return null;
  }
}

const ageOf = (value: Stored) => Date.now() - Date.parse(value.observedAt);
const retained = (value: Stored | null): value is Stored =>
  !!value && ageOf(value) >= 0 && ageOf(value) < RETENTION_MS;

export async function cachedDashboardSpotlight(
  dashboard: AnalyticsDashboardDefinition,
  sp: Record<string, string | undefined>,
  orgId: string,
): Promise<AnalyticsSpotlight> {
  const authz = await requirePermission("reports.read");
  const query = analyticsSourceQuery(sp, dashboard.slug);
  const { locale, revision } = await analyticsCacheIdentity(orgId);
  // The revision is stored with the value rather than keyed, so a posting
  // leaves the previous projection available while the next one builds.
  const key = analyticsPreviewKey(authz, `spotlight:${dashboard.slug}`, query, locale, "latest");

  const build = (): Promise<Stored> => {
    const running = building.get(key);
    if (running) return running;
    const work = (async () => {
      const token = await claimSharedCache(key);
      try {
        const data = await analyticsDashboardSpotlight(dashboard, sp, orgId);
        const value: Stored = { version: 1, revision, observedAt: data.observedAt, data };
        remember(key, value);
        if (token) await publishSharedCache(key, token, JSON.stringify(value), RETENTION_MS);
        return value;
      } finally {
        if (token) await releaseSharedCache(key, token);
      }
    })().finally(() => building.delete(key));
    building.set(key, work);
    return work;
  };

  const known = local.get(key) ?? null;
  const stored = retained(known) ? known : decode(await readSharedCache(key));
  if (!retained(stored)) return (await build()).data;
  remember(key, stored);
  if (stored.revision === revision && ageOf(stored) < ANALYTICS_PREVIEW_FRESHNESS_MS)
    return stored.data;
  // Serve the last projection now; the card states its calculation time
  // and asks again once the replacement is ready. A failed background build
  // leaves the previous projection in place for the next request to retry.
  after(() =>
    build().then(
      () => undefined,
      () => undefined,
    ),
  );
  return { ...stored.data, refreshing: true };
}
