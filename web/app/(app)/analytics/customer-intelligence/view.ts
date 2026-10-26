import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { customerData, customerSummaryData } from "../../../../lib/analytics/customer-data";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import { customerStrings } from "../../../../lib/analytics/customer-strings";
import { projectCustomerDashboard } from "../../../../lib/analytics/overview-projection";
import type { CustomerView } from "./CustomerView";

/**
 * Customer intelligence, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx.
 */

type ViewProps = Parameters<typeof CustomerView>[0];

export interface CustomerIntelligenceData {
  title: string;
  backLabel: string;
  periodLabel: string;
  /** Named fiscal periods for the shared period picker (URL-addressable). */
  extraPeriods: { id: string; label: string; from: string; to: string }[];
  extraPeriodsLabel: string;
  profitability: ViewProps["profitability"];
  projectsEnabled: boolean;
  data: ViewProps["data"];
  /** Threshold editing needs admin.setup.manage with unrestricted scope (the
   * config PUT's gate); reports.read-only and scoped callers get read-only. */
  canConfigure: boolean;
}

async function customerContext(sp: Record<string, string | undefined>) {
  const t = await getTranslations("analytics.customer");
  const authz = await requirePermission("reports.read");

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
  const strings = customerStrings((key, values) => tc(key, values), locale);
  return { t, authz, period, periodLabel, strings, picker };
}

export async function loadCustomerIntelligencePreview(sp: Record<string, string | undefined>) {
  const { authz, period, periodLabel, strings } = await customerContext(sp);
  return {
    data: await customerSummaryData(
      { ...period, label: periodLabel },
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      strings,
    ),
    periodLabel,
  };
}

export async function loadCustomerIntelligence(
  sp: Record<string, string | undefined>,
): Promise<CustomerIntelligenceData> {
  const { t, authz, period, periodLabel, strings, picker } = await customerContext(sp);
  // The profitability tab's leak share divides by the loader's scoped,
  // customer-attributed period total — passed in, never a second unscoped
  // query that could divide scoped revenue by whole-org revenue.
  const [data, projectsEnabled] = await Promise.all([
    customerData(
      { from: period.from, to: period.to, label: periodLabel },
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      strings,
    ),
    isFeatureEnabled(authz.user.orgId, "projects"),
  ]);
  const { profitability = null, ...dashboardData } = data;

  return {
    title: t("title"),
    backLabel: t("backToHub"),
    periodLabel,
    extraPeriods: picker.extraPeriods,
    extraPeriodsLabel: picker.extraPeriodsLabel,
    profitability,
    projectsEnabled,
    data: projectCustomerDashboard(dashboardData),
    canConfigure: authz.allowedSubsidiaryIds === null && can(authz, "admin.setup.manage"),
  };
}

export function customerIntelligenceSpec(data: CustomerIntelligenceData): PageSpec {
  return page({
    route: "/analytics/customer-intelligence",
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
    body: [
      widgetBlock("customer-view", {
        data: data.data,
        profitability: data.profitability,
        projectsEnabled: data.projectsEnabled,
        canConfigure: data.canConfigure,
      }),
    ],
  });
}
