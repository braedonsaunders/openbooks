import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "../../../../lib/format";
import {
  filterBar,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { AS_OF_DEFAULT_PERIOD_PRESET } from "@openbooks/reports";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { parseReportQuery } from "../../../../lib/report-filters";
import { resolvePeriod } from "../../../../lib/periods";
import { orgBranding } from "../../../../lib/report-pdf";
import { intercompanyReconciliationExportData } from "../../../../lib/intercompany-report";

/**
 * Intercompany reconciliation, as of the end of the chosen period: each
 * intercompany pair's balances by currency in both entities' ledgers and the
 * difference left to reconcile. The paper, exports and saved views share the
 * one report shape; the pairing workspace links here.
 */

export interface IntercompanyReconciliationData {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
  workspaceHref: string;
  workspaceLabel: string;
  exportParams: Record<string, string | undefined>;
  company: string;
  currency: string;
  emptyLabel: string;
  paper: unknown;
}

export async function loadIntercompanyReconciliation(
  sp: Record<string, string | undefined>,
): Promise<IntercompanyReconciliationData> {
  const authz = await requirePermission("intercompany.read");
  await requireFeatureEnabled(authz.user.orgId, "multiSubsidiary");
  const q = parseReportQuery(sp, { defaultPeriod: AS_OF_DEFAULT_PERIOD_PRESET });
  const period = await resolvePeriod(q.period, {
    customFrom: q.from,
    customTo: q.to,
    orgId: authz.user.orgId,
  });
  const [t, tr, branding, locale] = await Promise.all([
    getTranslations("intercompany"),
    getTranslations("reports"),
    orgBranding(authz.user.orgId),
    getLocale(),
  ]);
  const data = await intercompanyReconciliationExportData(
    authz.user.orgId,
    authz.allowedSubsidiaryIds,
    period.to,
    t("reconciliation.asOf", civilDateParams({ date: period.to }, locale)),
  );
  return {
    title: data.title,
    description: t("reconciliation.description"),
    backHref: "/reports",
    backLabel: tr("hub.title"),
    workspaceHref: "/intercompany",
    workspaceLabel: t("reconciliation.openWorkspace"),
    exportParams: sp,
    company: branding.orgName,
    currency: branding.baseCurrency,
    emptyLabel: t("reconciliation.empty"),
    paper: { ...data, periodPhrase: data.dateRangeLabel },
  };
}

const f = ref<IntercompanyReconciliationData>();

export function intercompanyReconciliationSpec(data: IntercompanyReconciliationData): PageSpec {
  return page({
    route: "/reports/intercompany-reconciliation",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        back: { href: f("backHref"), label: f("backLabel") },
      }),
      filterBar(
        { period: true, asOf: true },
        {
          defaultPeriod: AS_OF_DEFAULT_PERIOD_PRESET,
          actions: [
            widget("link-button", {
              href: data.workspaceHref,
              label: data.workspaceLabel,
              variant: "outline",
              size: "sm",
            }),
            widget("save-view"),
            widget("export-menu", {
              kind: "intercompany-reconciliation",
              params: data.exportParams,
            }),
          ],
        },
      ),
    ],
    body: [
      widgetBlock("paper-view", {
        company: data.company,
        currency: data.currency,
        emptyLabel: data.emptyLabel,
        data: data.paper,
      }),
    ],
  });
}
