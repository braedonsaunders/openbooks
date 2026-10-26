import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import { CollectionPeriodError } from "../../../../lib/analytics/receivables-metrics";
import { analyticsFiscalPeriodPicker } from "../../../../lib/analytics/fiscal-period-options";
import { reportPeriodLabel } from "../../../../lib/format";
import {
  receivablesIntelligenceData,
  type ReceivablesIntelligence,
} from "../../../../lib/analytics/receivables-intelligence-data";

export interface ReceivablesIntelligenceData {
  title: string;
  backLabel: string;
  periodLabel: string;
  /** Named fiscal periods for the shared period picker (URL-addressable). */
  extraPeriods: { id: string; label: string; from: string; to: string }[];
  extraPeriodsLabel: string;
  data: ReceivablesIntelligence & { canConfigure: boolean };
  canOpenCustomers: boolean;
}

export async function loadReceivablesIntelligence(
  sp: Record<string, string | undefined>,
): Promise<ReceivablesIntelligenceData> {
  await requirePermission("reports.read");
  const authz = await requirePermission("ar.read");
  const q = parseReportQuery(sp);
  const locale = await getLocale();
  const [t, period, today, picker] = await Promise.all([
    getTranslations("analytics.receivables"),
    resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId }),
    businessToday(authz.user.orgId),
    analyticsFiscalPeriodPicker(authz.user.orgId, locale),
  ]);
  const asOf = period.to < today ? period.to : today;
  if (period.from > asOf) {
    throw new CollectionPeriodError(t("futurePeriod"));
  }
  const data = await receivablesIntelligenceData(
    authz.user.orgId,
    period.from,
    asOf,
    authz.allowedSubsidiaryIds,
    sp,
  );
  // An accounting-period window reads as every period list labels it, in
  // the viewer's locale; custom windows read as their localized dates.
  return {
    title: t("title"),
    backLabel: t("backToHub"),
    periodLabel: reportPeriodLabel(period, locale),
    extraPeriods: picker.extraPeriods,
    extraPeriodsLabel: picker.extraPeriodsLabel,
    data: {
      ...data,
      canConfigure: authz.allowedSubsidiaryIds === null && can(authz, "admin.setup.manage"),
    },
    canOpenCustomers: can(authz, "parties.read"),
  };
}

export function receivablesIntelligenceSpec(data: ReceivablesIntelligenceData): PageSpec {
  return page({
    route: "/analytics/receivables-intelligence",
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
      widgetBlock("receivables-view", { data: data.data, canOpenCustomers: data.canOpenCustomers }),
    ],
  });
}
