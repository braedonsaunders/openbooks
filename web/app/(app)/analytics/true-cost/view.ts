import "server-only";
import { OverheadCalculationError } from "@openbooks/engine/projects/overhead-rates";

import { getLocale, getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { trueCostData } from "../../../../lib/analytics/true-cost-data";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import { trueCostStrings } from "../../../../lib/analytics/true-cost-strings";
import { presentationCurrency } from "../../../../lib/fx-presentation";
import type { TrueCostView } from "./TrueCostView";

/**
 * True Cost, split into a loader and a spec.
 *
 * The dashboard shape is the family shape: the compact `AnalyticsHeader`
 * breadcrumb row wrapping its controls, and a body that is a single bespoke
 * client view. The header is a FRAME because it wraps spec-authored
 * children: the shared `report-period-filter` widget (`controls={{ period:
 * true }}`, byte-identical across the dashboards) plus the `link-button`
 * that opens the tabular report at `/reports/true-cost` with the same
 * query — dashboards are hub pages, reports are report-engine pages, and
 * the dashboard links to its report rather than redirecting to it. The body
 * stays whole: KPIs, the cost-pool breakdown, profile/category panels and
 * drill targets live in the view, and decomposing them into generic blocks
 * would reimplement the component rather than compose it.
 *
 * Loader work is the `reports.read` gate, the `projects` feature gate, the
 * period query, and the reader's subsidiary fence handed straight to
 * `trueCostData`. The interactive recovery (absorption) and selling planning
 * tabs are part of this dashboard.
 */

type ViewProps = Parameters<typeof TrueCostView>[0];

export interface TrueCostDashboardData {
  title: string;
  backLabel: string;
  periodLabel: string;
  /** Named fiscal periods for the shared period picker (URL-addressable). */
  extraPeriods: { id: string; label: string; from: string; to: string }[];
  extraPeriodsLabel: string;
  reportHref: string;
  reportLabel: string;
  data: ViewProps["data"] | null;
  refusal: string | null;
}

export async function loadTrueCost(
  sp: Record<string, string | undefined>,
): Promise<TrueCostDashboardData> {
  const t = await getTranslations("analytics.trueCost");
  const authz = await requirePermission("reports.read");
  await requireFeatureEnabled(authz.user.orgId, "projects");

  const q = parseReportQuery(sp);
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to });

  // Insight sentences resolve through the analytics catalog in the request
  // locale — the same locale the statements use.
  const locale = await getLocale();
  const [tc, picker] = await Promise.all([
    getTranslations("analytics"),
    analyticsFiscalPeriodPicker(authz.user.orgId, locale),
  ]);
  // An accounting-period window reads as every period list labels it, in
  // the viewer's locale; custom windows read as their localized dates.
  const periodLabel = reportPeriodLabel(period, locale);
  const strings = trueCostStrings(
    (key, values) => tc(key, values),
    locale,
    await presentationCurrency(authz.user.orgId),
  );
  let refusal: string | null = null;
  const data = await trueCostData(
    authz.user.orgId,
    { from: period.from, to: period.to, label: periodLabel },
    authz.allowedSubsidiaryIds,
    strings,
  ).catch((error: unknown) => {
    if (!(error instanceof OverheadCalculationError)) throw error;
    refusal = error.message;
    return null;
  });

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) if (value) query.set(key, value);
  const qs = query.toString();

  return {
    title: t("title"),
    backLabel: t("backToHub"),
    periodLabel,
    extraPeriods: picker.extraPeriods,
    extraPeriodsLabel: picker.extraPeriodsLabel,
    reportHref: `/reports/true-cost${qs ? `?${qs}` : ""}`,
    reportLabel: t("openReport"),
    data,
    refusal,
  };
}

export function trueCostSpec(data: TrueCostDashboardData): PageSpec {
  return page({
    route: "/analytics/true-cost",
    layout: "list",
    header: [
      frame(
        "analytics-header",
        [
          widgetBlock("report-period-filter", {
            extraPeriods: data.extraPeriods,
            extraPeriodsLabel: data.extraPeriodsLabel,
          }),
          widgetBlock("link-button", {
            href: data.reportHref,
            label: data.reportLabel,
            variant: "outline",
            size: "sm",
          }),
        ],
        {
          title: data.title,
          periodLabel: data.periodLabel,
          backLabel: data.backLabel,
        },
      ),
    ],
    body: data.data
      ? [widgetBlock("true-cost-view", { data: data.data })]
      : [
          widgetBlock("empty-state", {
            title: data.title,
            description: data.refusal,
          }),
        ],
  });
}
