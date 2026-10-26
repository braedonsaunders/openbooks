import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { spendVelocityData } from "../../../../lib/analytics/spend-velocity-data";
import { reportExpenseAccess } from "../../../../lib/expense-access";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import { spendVelocityStrings } from "../../../../lib/analytics/spend-velocity-strings";
import type { SpendVelocityView } from "./SpendVelocityView";

/**
 * Spend velocity, split into a loader and a spec.
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

type ViewProps = Parameters<typeof SpendVelocityView>[0];

export interface SpendVelocityData {
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

export async function loadSpendVelocity(
  sp: Record<string, string | undefined>,
): Promise<SpendVelocityData> {
  const t = await getTranslations("analytics.spendVelocity");
  const authz = await requirePermission("reports.read");

  const q = parseReportQuery(sp);
  // The org id lets the org's fiscal calendar name the period, as on Vendor Performance.
  const period = await resolvePeriod(q.period, {
    customFrom: q.from,
    customTo: q.to,
    orgId: authz.user.orgId,
  });

  // Insight sentences resolve through the analytics catalog in the request
  // locale (users.locale ?? org defaultLocale ?? en) — the same locale the
  // statements use. Direct loader callers keep the English default.
  const locale = await getLocale();
  const [tc, picker] = await Promise.all([
    getTranslations("analytics"),
    analyticsFiscalPeriodPicker(authz.user.orgId, locale),
  ]);
  // An accounting-period window reads as every period list labels it, in
  // the viewer's locale; custom windows read as their localized dates.
  const periodLabel = reportPeriodLabel(period, locale);
  const strings = spendVelocityStrings((key, values) => tc(key, values), locale);
  const data = await spendVelocityData(
    authz.user.orgId,
    { from: period.from, to: period.to, label: periodLabel },
    authz.allowedSubsidiaryIds,
    strings,
    { expenseAccess: await reportExpenseAccess(authz) },
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

export function spendVelocitySpec(data: SpendVelocityData): PageSpec {
  return page({
    route: "/analytics/spend-velocity",
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
      widgetBlock("spend-velocity-view", { data: data.data, canConfigure: data.canConfigure }),
    ],
  });
}
