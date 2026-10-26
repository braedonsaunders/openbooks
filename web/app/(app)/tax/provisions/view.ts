import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission, can } from "../../../../lib/authz";
import { getMoneyFormatter } from "@/lib/money-server";
import { orgInfo } from "../../../../lib/data";
import { listProvisionRuns } from "@openbooks/engine/tax-returns/income-tax-provision";
import type { ProvisionRunListColumns, ProvisionRunListRow } from "./sections";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { taxWorkspaceTabs } from "../workspace-tabs";
import { mergeHref, pickString } from "../../../../lib/list-params";
import { loadProvisionDetail, type ProvisionDetailData } from "./[id]/view";

/**
 * Income-tax provision register. The loader preserves the reports permission,
 * entity-projected engine read, money formatting, and organization-wide
 * compute gate. Selected runs reuse the entity-projected detail reader before
 * their data is placed in the URL-addressed drawer.
 */

const STATUS_VARIANT: Record<string, "success" | "secondary" | "outline"> = {
  draft: "secondary",
  posted: "success",
  superseded: "outline",
};

export interface TaxProvisionsData {
  title: string;
  description: string;
  canCompute: boolean;
  emptyText: string;
  columns: ProvisionRunListColumns;
  rows: ProvisionRunListRow[];
  tabs: ModuleHomeTab[];
  drawerOpen: boolean;
  drawer: { detail: ProvisionDetailData; closeHref: string } | null;
}

export async function loadTaxProvisions(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<TaxProvisionsData> {
  const authz = await requirePermission("reports.read");
  const { money } = await getMoneyFormatter();
  const t = await getTranslations("tax.provisions");
  const org = await orgInfo();
  const tabs = await taxWorkspaceTabs(authz.user.orgId, "provisions");
  const runs = await listProvisionRuns(authz.user.orgId, authz.allowedSubsidiaryIds);
  const runId = pickString(sp.run);
  const selectedDetail = runId ? await loadProvisionDetail(sp, runId) : null;
  const m = (v: string) => money(v, { currency: org?.base_currency });

  const canCompute = authz.allowedSubsidiaryIds === null && can(authz, "reports.create");

  return {
    title: t("title"),
    description: t("description"),
    // The compute dialog posts an org-wide run, so restricted callers never
    // see the button — mirrors the native header gate exactly.
    canCompute,
    tabs,
    // Without the grant the empty table must not invite a Compute the reader
    // cannot open: it names the organization-wide access instead.
    emptyText: canCompute ? t("empty") : t("emptyNoGrant"),
    columns: {
      fiscalYear: t("columns.fiscalYear"),
      version: t("columns.version"),
      status: t("columns.status"),
      totalExpense: t("columns.totalExpense"),
      effectiveRate: t("columns.effectiveRate"),
      created: t("columns.created"),
    },
    rows: runs.map((run) => ({
      id: run.id,
      href: mergeHref("/tax/provisions", sp, { run: run.id }),
      fiscalYearLabel: t("fiscalYearLabel", { year: run.fiscalYear }),
      versionLabel: t("versionLabel", { version: run.version }),
      statusLabel: t(`status.${run.status}`),
      statusVariant: STATUS_VARIANT[run.status] ?? "secondary",
      totalExpense: m(run.totalExpense),
      // The engine emits no effectiveRatePercent for the seeded runs (null
      // projects to null for restricted callers too); the native page renders
      // an em-dash there, so the loader carries the finished text.
      effectiveRateText: run.effectiveRatePercent != null ? `${run.effectiveRatePercent}%` : "—",
      created: String(run.createdAt).slice(0, 10),
    })),
    drawerOpen: Boolean(selectedDetail),
    drawer: selectedDetail
      ? {
          detail: selectedDetail,
          closeHref: mergeHref("/tax/provisions", sp, { run: undefined }),
        }
      : null,
  };
}

const f = ref<TaxProvisionsData>();

export function taxProvisionsSpec(data: TaxProvisionsData): PageSpec {
  return page({
    route: "/tax/provisions",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        // Omit the compute action at construction when the caller lacks its
        // organization-wide grant; the Tax workspace tabs remain available.
        actions: [
          widget("module-home-tabs", { tabs: f("tabs") }),
          ...(data.canCompute ? [widget("provision-compute-button", {})] : []),
        ],
      }),
    ],
    body: [
      widgetBlock("provision-runs-table", {
        columns: data.columns,
        emptyText: data.emptyText,
        rows: data.rows,
      }),
      {
        ...widgetBlock("provision-run-drawer", { drawer: f("drawer") }),
        when: f("drawerOpen"),
      },
    ],
  });
}
