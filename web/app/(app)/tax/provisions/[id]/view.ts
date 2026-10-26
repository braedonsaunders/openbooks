import "server-only";

import { page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { requirePermission, can } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { getMoneyFormatter } from "@/lib/money-server";
import { orgInfo } from "../../../../../lib/data";
import { getProvisionRun } from "@openbooks/engine/tax-returns/income-tax-provision";
import type { ProvisionDifference, ProvisionSummary, ReconStep } from "./sections";

/**
 * Load the authorized, formatted data shown in a provision-run drawer.
 * Restricted callers receive the same entity-projected read as the detail
 * API, and posting remains available only to unrestricted draft-run readers
 * with the `gl.post` permission.
 */

const STATUS_VARIANT: Record<string, "success" | "secondary" | "outline"> = {
  draft: "secondary",
  posted: "success",
  superseded: "outline",
};

export interface ProvisionDetailData {
  headerTitle: string;
  frameworkLabel: string;
  statusLabel: string;
  statusVariant: "success" | "secondary" | "outline";
  canPost: boolean;
  runId: string;
  reconTitle: string;
  pretaxLabel: string;
  pretaxAmount: string;
  enactedRateText: string;
  amountLabel: string;
  percentLabel: string;
  steps: ReconStep[];
  summaries: ProvisionSummary[];
  diffTitle: string;
  diffEmptyNote: string;
  diffColumns: {
    item: string;
    bookBasis: string;
    taxBasis: string;
    difference: string;
    effect: string;
  };
  differences: ProvisionDifference[];
}

export async function loadProvisionDetail(
  _sp: Record<string, string | string[] | undefined>,
  id: string,
): Promise<ProvisionDetailData> {
  const authz = await requirePermission("reports.read");
  const { money } = await getMoneyFormatter();
  const t = await getTranslations("tax.provisions");
  const org = await orgInfo();
  // A malformed id never reaches the read: it renders not-found, never a
  // 500 out of the query.
  if (!isUuid(id)) notFound();
  // Same entity projection as the REST twin: a run with no visible entity is
  // indistinguishable from a missing one.
  const run = await getProvisionRun(authz.user.orgId, id, authz.allowedSubsidiaryIds);
  if (!run) notFound();
  const payload = run.payload as {
    presentationCurrency?: string;
    framework?: "asc740" | "ias12";
    pretaxBookIncome: string;
    enactedRatePercent: string;
    taxableIncome: string;
    currentTax: string;
    deferredExpense: string;
    totalExpense: string;
    balances: { dtaGross: string; dtlGross: string; valuationAllowance: string };
    rateReconciliation: { key: string; label: string; amount: string; percent: string | null }[];
  };
  const presentationCurrency = payload.presentationCurrency ?? org?.base_currency;
  const m = (v: string) => money(v, { currency: presentationCurrency });
  const framework = payload.framework ?? "asc740";
  const recon = payload.rateReconciliation ?? [];
  // Posting is the gl.post route's authority, and it refuses restricted callers
  // (a provision posts the whole entity set); the button mirrors both.
  const canPost =
    can(authz, "gl.post") && authz.allowedSubsidiaryIds === null && run.status === "draft";

  return {
    headerTitle: t("detail.title", { year: run.fiscalYear, version: run.version }),
    frameworkLabel: framework === "ias12" ? "IAS 12" : "ASC 740",
    statusLabel: t(`status.${run.status}`),
    statusVariant: STATUS_VARIANT[run.status] ?? "secondary",
    canPost,
    runId: run.id,
    reconTitle: t("detail.reconciliation"),
    pretaxLabel: t("detail.pretax"),
    pretaxAmount: m(payload.pretaxBookIncome),
    enactedRateText: `${payload.enactedRatePercent}%`,
    amountLabel: t("detail.amount"),
    percentLabel: t("detail.percent"),
    steps: recon.map((step) => ({
      key: step.key,
      // The total step renders translated copy, not the engine label.
      label: step.label,
      amount: m(step.amount),
      percent: step.percent,
      isTotal: step.key === "total",
      totalLabel: t("detail.total"),
    })),
    summaries: [
      { label: t("detail.taxableIncome"), value: m(payload.taxableIncome) },
      { label: t("detail.currentTax"), value: m(payload.currentTax) },
      { label: t("detail.deferredExpense"), value: m(payload.deferredExpense) },
      { label: t("detail.balances.dta"), value: m(payload.balances.dtaGross) },
      { label: t("detail.balances.dtl"), value: m(payload.balances.dtlGross) },
      {
        label: framework === "ias12" ? t("detail.balances.vaIas12") : t("detail.balances.va"),
        value: m(payload.balances.valuationAllowance),
      },
    ],
    diffTitle: t("detail.differences"),
    diffEmptyNote: t("detail.noDifferences"),
    diffColumns: {
      item: t("detail.columns.item"),
      bookBasis: t("detail.columns.bookBasis"),
      taxBasis: t("detail.columns.taxBasis"),
      difference: t("detail.columns.difference"),
      effect: t("detail.columns.effect"),
    },
    differences: run.differences.map((d) => ({
      id: d.id,
      description: d.description,
      categorySourceLabel: `${t(`categories.${d.category}`)} · ${d.source === "auto" ? t("detail.auto") : t("detail.manual")}`,
      bookBasis: money(d.bookBasis, { currency: d.currency }),
      taxBasis: money(d.taxBasis, { currency: d.currency }),
      difference: money(d.difference, { currency: d.currency }),
      taxEffect: money(d.taxEffect, { currency: d.currency }),
    })),
  };
}

export function provisionDetailSpec(data: ProvisionDetailData): PageSpec {
  return page({
    route: "/tax/provisions/[id]",
    layout: "detail",
    body: [
      widgetBlock("provision-run-drawer", {
        drawer: { detail: data, closeHref: "/tax/provisions" },
      }),
    ],
  });
}
