import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { utilizationData } from "../../../../lib/analytics/utilization-data";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import { utilizationStrings } from "../../../../lib/analytics/utilization-strings";
import type { UtilizationView } from "./UtilizationView";

/**
 * Utilization, split into a loader and a spec.
 *
 * The dashboard shape is the family shape: the compact `AnalyticsHeader`
 * breadcrumb row wrapping ONE control, and a body that is a single bespoke
 * client view. The header is a FRAME because it wraps a spec-authored child;
 * the control is the shared `report-period-filter` widget (`controls={{ period:
 * true }}`), byte-identical across six of the seven dashboards. The body
 * stays whole: charts, drill tables and client filter state live in the view,
 * and decomposing them into generic blocks would reimplement the component
 * rather than compose it.
 *
 * Loader work copied VERBATIM from page.tsx. The `timeTracking` feature gate runs
 * in the loader wherever it renders, so a spec render redirects exactly as the
 * native one does — a gate that only guarded the native path would be a hole.
 */

type ViewProps = Parameters<typeof UtilizationView>[0];

export interface UtilizationData {
  title: string;
  backLabel: string;
  periodLabel: string;
  /** Named fiscal periods for the shared period picker (URL-addressable). */
  extraPeriods: { id: string; label: string; from: string; to: string }[];
  extraPeriodsLabel: string;
  data: ViewProps["data"];
  /** Threshold editing needs admin.setup.manage with unrestricted scope (the
   * config PUT's gate); reports.read-only and scoped callers get read-only. */
  canConfigure: boolean;
}

export async function loadUtilization(
  sp: Record<string, string | undefined>,
): Promise<UtilizationData> {
  const t = await getTranslations("analytics.utilization");
  const authz = await requirePermission("reports.read");
  await requireFeatureEnabled(authz.user.orgId, "timeTracking");

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
  const strings = utilizationStrings((key, values) => tc(key, values), locale);
  const data = await utilizationData(
    authz.user.orgId,
    { from: period.from, to: period.to, label: periodLabel },
    authz.allowedSubsidiaryIds,
    strings,
  );

  return {
    title: t("title"),
    backLabel: t("backToHub"),
    periodLabel,
    extraPeriods: picker.extraPeriods,
    extraPeriodsLabel: picker.extraPeriodsLabel,
    data,
    canConfigure: authz.allowedSubsidiaryIds === null && can(authz, "admin.setup.manage"),
  };
}

export function utilizationSpec(data: UtilizationData): PageSpec {
  return page({
    route: "/analytics/utilization",
    layout: "list",
    header: [
      frame(
        "analytics-header",
        [
          widgetBlock("report-period-filter", {
            extraPeriods: data.extraPeriods,
            extraPeriodsLabel: data.extraPeriodsLabel,
          }),
        ],
        {
          title: data.title,
          periodLabel: data.periodLabel,
          backLabel: data.backLabel,
        },
      ),
    ],
    body: [widgetBlock("utilization-view", { data: data.data, canConfigure: data.canConfigure })],
  });
}
