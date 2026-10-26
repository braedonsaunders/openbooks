import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { healthData, healthSummaryData } from "../../../../lib/analytics/health-data";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import { healthStrings, localizedRatioDefs } from "../../../../lib/analytics/health-strings";
import type { FinancialHealthView } from "./FinancialHealthView";

/**
 * Financial health, split into a loader and a spec.
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
 * Loader work copied VERBATIM from page.tsx. Ratio definitions travel as plain
 * data through the widget exactly as the page passed them as a prop — resolved
 * from the analytics catalog (`localizedRatioDefs`) in the request locale.
 */

type ViewProps = Parameters<typeof FinancialHealthView>[0];

export interface FinancialHealthData {
  title: string;
  backLabel: string;
  periodLabel: string;
  /** Named fiscal periods for the shared period picker (URL-addressable). */
  extraPeriods: { id: string; label: string; from: string; to: string }[];
  extraPeriodsLabel: string;
  defs: ViewProps["defs"];
  budgetsEnabled: boolean;
  data: ViewProps["data"];
  /** Threshold editing needs admin.setup.manage with unrestricted scope (the
   * config PUT's gate); reports.read-only and scoped callers get read-only. */
  canConfigure: boolean;
}

async function financialHealthContext(sp: Record<string, string | undefined>) {
  const t = await getTranslations("analytics.financialHealth");
  const authz = await requirePermission("reports.read");

  const q = parseReportQuery(sp);
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to });

  // Finding sentences and ratio definitions resolve through the analytics
  // catalog in the request locale — the same locale the statements use.
  // Direct loader callers keep the English defaults.
  const locale = await getLocale();
  const [tc, picker] = await Promise.all([
    getTranslations("analytics"),
    analyticsFiscalPeriodPicker(authz.user.orgId, locale),
  ]);
  // An accounting-period window reads as every period list labels it, in
  // the viewer's locale; custom windows read as their localized dates.
  const periodLabel = reportPeriodLabel(period, locale);
  const boundT = (key: string, values?: Record<string, string | number>) => tc(key, values);
  const strings = healthStrings(boundT, locale);
  return { t, authz, period, periodLabel, strings, boundT, picker };
}

export async function loadFinancialHealthPreview(sp: Record<string, string | undefined>) {
  const { authz, period, periodLabel, strings } = await financialHealthContext(sp);
  return {
    data: await healthSummaryData(
      { ...period, label: periodLabel },
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      strings,
    ),
    periodLabel,
  };
}

export async function loadFinancialHealth(
  sp: Record<string, string | undefined>,
): Promise<FinancialHealthData> {
  const { t, authz, period, periodLabel, strings, boundT, picker } =
    await financialHealthContext(sp);
  const [data, budgetsEnabled] = await Promise.all([
    healthData(
      { from: period.from, to: period.to, label: periodLabel },
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      strings,
    ),
    isFeatureEnabled(authz.user.orgId, "budgets"),
  ]);

  return {
    title: t("title"),
    backLabel: t("backToHub"),
    periodLabel,
    extraPeriods: picker.extraPeriods,
    extraPeriodsLabel: picker.extraPeriodsLabel,
    defs: localizedRatioDefs(boundT),
    budgetsEnabled,
    data,
    canConfigure: authz.allowedSubsidiaryIds === null && can(authz, "admin.setup.manage"),
  };
}

export function financialHealthSpec(data: FinancialHealthData): PageSpec {
  return page({
    route: "/analytics/financial-health",
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
      widgetBlock("financial-health-view", {
        data: data.data,
        defs: data.defs,
        budgetsEnabled: data.budgetsEnabled,
        canConfigure: data.canConfigure,
      }),
    ],
  });
}
