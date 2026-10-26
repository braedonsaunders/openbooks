import "server-only";
import { getLocale } from "next-intl/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { getAuthz } from "./authz";
import {
  latestProjection,
  rebuildProjection,
  type LatestProjection,
} from "./analytics/latest-projection";
import { analyticsCacheIdentity, analyticsPreviewKey } from "./analytics/preview-cache";

type Params = Record<string, string | string[] | undefined>;

/**
 * Module cockpits whose figures are projections of the whole open book (the
 * receivables and payables control centers, the cash forecast, the customer
 * and vendor homes, compliance). Like dashboards, they answer from their
 * latest projection and rebuild when a write or the freshness window may
 * have changed it. Each loader runs under the caller's own authorization.
 */
const PAGE_LOADERS = {
  ar: async () => (await import("../app/(app)/ar/view")).loadArCockpit(),
  ap: async () => (await import("../app/(app)/ap/view")).loadApCockpit(),
  "banking-cash": async (sp: Params) =>
    (await import("../app/(app)/banking/cash/view")).loadBankingCash(sp),
  customers: async (sp: Params) =>
    (await import("../app/(app)/customers/view")).loadCustomers(
      sp as Record<string, string | undefined>,
    ),
  purchasing: async (sp: Params) =>
    (await import("../app/(app)/purchasing/view")).loadPurchasing(
      sp as Record<string, string | undefined>,
    ),
  compliance: async (sp: Params) =>
    (await import("../app/(app)/compliance/view")).loadCompliance(sp),
} as const;

export type ProjectedPageSlug = keyof typeof PAGE_LOADERS;
export type ProjectedPageData<S extends ProjectedPageSlug> = Awaited<
  ReturnType<(typeof PAGE_LOADERS)[S]>
>;

export function isProjectedPageSlug(value: string): value is ProjectedPageSlug {
  return Object.hasOwn(PAGE_LOADERS, value);
}

/** Only single-valued parameters shape a cockpit; their order never does. */
function pageQuery(sp: Params): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sp)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** The parameters that shape a cockpit's projection, as its page reports them back. */
export function projectedPageParams(slug: ProjectedPageSlug, sp: Params): Record<string, string> {
  return slug === "ar" || slug === "ap" ? {} : pageQuery(sp);
}

async function pageIdentity<S extends ProjectedPageSlug>(slug: S, sp: Params) {
  const authz = await getAuthz();
  if (!authz) return null;
  const [{ revision }, today, locale] = await Promise.all([
    analyticsCacheIdentity(authz.user.orgId),
    businessToday(authz.user.orgId),
    getLocale(),
  ]);
  const query = projectedPageParams(slug, sp);
  return {
    key: analyticsPreviewKey(
      authz,
      `page:${slug}`,
      { user: authz.user.id, ...query },
      locale,
      "latest",
    ),
    revision: `${revision}|${today}`,
    build: () => (PAGE_LOADERS[slug] as (sp: Params) => Promise<ProjectedPageData<S>>)(query),
  };
}

/**
 * The cockpit's latest projection for the caller. Without a session the
 * loader runs directly, so its own authorization answers the request.
 */
export async function projectedPage<S extends ProjectedPageSlug>(
  slug: S,
  sp: Params,
): Promise<LatestProjection<ProjectedPageData<S>>> {
  const identity = await pageIdentity(slug, sp);
  if (!identity) {
    const data = await (PAGE_LOADERS[slug] as (sp: Params) => Promise<ProjectedPageData<S>>)(
      pageQuery(sp),
    );
    return { data, observedAt: new Date().toISOString(), refreshing: false };
  }
  return latestProjection(identity.key, identity.revision, identity.build);
}

/** Rebuild the caller's projection of one cockpit. */
export async function rebuildProjectedPage(slug: ProjectedPageSlug, sp: Params): Promise<boolean> {
  const identity = await pageIdentity(slug, sp);
  if (!identity) return false;
  await rebuildProjection(identity.key, identity.revision, identity.build);
  return true;
}
