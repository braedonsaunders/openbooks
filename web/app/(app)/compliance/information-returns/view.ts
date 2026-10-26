import "server-only";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  textBlock,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { FORM_TYPES } from "@openbooks/engine/compliance/information-returns";
import { can, requirePermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import {
  loadFilings,
  loadInformationReturnReadiness,
  requireInformationReturnsFeature,
} from "../../../../lib/compliance";
import { getMoneyFormatter } from "@/lib/money-server";
import { complianceTabs } from "../tabs";
import { isUuid, pickString } from "../../../../lib/list-params";
import { loadFilingDetail, type FilingDetailData } from "./[id]/view";
import {
  informationReturnDrawerCloseHref,
  informationReturnFilingHref,
  informationReturnsViewState,
  type InformationReturnsView,
} from "./view-state";

/** Information-return filings and the readiness queue, selected as URL views. */

const STATUS_TONE: Record<string, "success" | "warning" | "secondary" | "outline" | "destructive"> =
  {
    draft: "outline",
    computed: "warning",
    finalized: "success",
    filed: "success",
    void: "secondary",
  };

export interface FilingRow {
  id: string;
  taxYear: string;
  href: string;
  formType: string;
  entity: string;
  includedCount: string;
  excludedNote: string;
  filedTotal: string;
  statusLabel: string;
  statusVariant: "success" | "warning" | "secondary" | "outline" | "destructive";
  missingTin: boolean;
  missingTinLabel: string;
}

export interface ReadinessRow {
  partyId: string;
  vendorName: string;
  href: string;
  issueLabel: string;
  issueVariant: "destructive" | "warning";
  classification: string;
  paidThisYear: string;
}

export interface InformationReturnsData {
  title: string;
  description: string;
  tabs: Awaited<ReturnType<typeof complianceTabs>>;
  viewTabs: Awaited<ReturnType<typeof informationReturnsViewState>>["tabs"];
  view: InformationReturnsView;
  showFilingEmpty: boolean;
  showFilingRows: boolean;
  showReadiness: boolean;
  showReadinessClear: boolean;
  showReadinessRows: boolean;
  filingDetail: FilingDetailData | null;
  filingCloseHref: string;
  canManage: boolean;
  formTypes: string[];
  defaultYear: number;
  emptyTitle: string;
  emptyDescription: string;
  columnYear: string;
  columnForm: string;
  columnEntity: string;
  columnRecipients: string;
  columnTotal: string;
  columnStatus: string;
  columnAttention: string;
  rows: FilingRow[];
  readinessTitle: string;
  readinessDescription: string;
  readinessClear: string;
  columnVendor: string;
  columnIssue: string;
  columnClassification: string;
  columnPaid: string;
  readiness: ReadinessRow[];
}

export async function loadInformationReturns(
  sp: Record<string, string | string[] | undefined>,
): Promise<InformationReturnsData> {
  const authz = await requirePermission("compliance.read");
  const orgId = authz.user.orgId;
  await requireInformationReturnsFeature(orgId);
  const t = await getTranslations("compliance");
  const { money } = await getMoneyFormatter();
  const lastYear = Number((await businessToday(orgId)).slice(0, 4)) - 1;
  const selectedFilingId = pickString(sp.filing);
  if (selectedFilingId && !isUuid(selectedFilingId)) notFound();

  const [filings, readiness, projectsEnabled, complianceEnabled, filingDetail] = await Promise.all([
    loadFilings(orgId, authz.allowedSubsidiaryIds),
    loadInformationReturnReadiness(orgId, lastYear, authz.allowedSubsidiaryIds),
    isFeatureEnabled(orgId, "projects"),
    isFeatureEnabled(orgId, "subcontractorCompliance"),
    selectedFilingId ? loadFilingDetail(selectedFilingId) : Promise.resolve(null),
  ]);
  const tabs = await complianceTabs("/compliance/information-returns", {
    projectsEnabled,
    complianceEnabled,
  });
  const readinessTitle = t("informationReturns.readinessTitle", { year: lastYear });
  const { view, tabs: viewTabs } = informationReturnsViewState(sp, readiness.length, {
    filings: t("informationReturns.title"),
    readiness: readinessTitle,
  });

  return {
    title: t("informationReturns.title"),
    description: t("informationReturns.description"),
    tabs,
    viewTabs,
    view,
    showFilingEmpty: view === "filings" && filings.length === 0,
    showFilingRows: view === "filings" && filings.length > 0,
    showReadiness: view === "readiness",
    showReadinessClear: view === "readiness" && readiness.length === 0,
    showReadinessRows: view === "readiness" && readiness.length > 0,
    filingDetail,
    filingCloseHref: informationReturnDrawerCloseHref(sp),
    canManage: can(authz, "compliance.manage"),
    formTypes: [...FORM_TYPES],
    defaultYear: lastYear,
    emptyTitle: t("informationReturns.empty.title"),
    emptyDescription: t("informationReturns.empty.description"),
    columnYear: t("informationReturns.columns.year"),
    columnForm: t("informationReturns.columns.form"),
    columnEntity: t("informationReturns.columns.entity"),
    columnRecipients: t("informationReturns.columns.recipients"),
    columnTotal: t("informationReturns.columns.total"),
    columnStatus: t("informationReturns.columns.status"),
    columnAttention: t("informationReturns.columns.attention"),
    rows: filings.map((filing) => ({
      id: filing.id,
      taxYear: String(filing.taxYear),
      href: informationReturnFilingHref(sp, filing.id),
      formType: filing.formType,
      entity: filing.subsidiaryName ?? t("informationReturns.orgRoot"),
      includedCount: String(filing.includedCount),
      excludedNote:
        filing.excludedCount > 0
          ? t("informationReturns.excluded", { count: filing.excludedCount })
          : "",
      filedTotal: money(filing.filedTotal, { currency: filing.currency }),
      statusLabel: t(`filingStatus.${filing.status}`),
      statusVariant: STATUS_TONE[filing.status] ?? "secondary",
      missingTin: filing.missingTinCount > 0,
      missingTinLabel:
        filing.missingTinCount > 0
          ? t("informationReturns.missingTin", { count: filing.missingTinCount })
          : "",
    })),
    readinessTitle,
    readinessDescription: t("informationReturns.readinessDescription"),
    readinessClear: t("informationReturns.readinessClear"),
    columnVendor: t("informationReturns.columns.vendor"),
    columnIssue: t("informationReturns.columns.issue"),
    columnClassification: t("informationReturns.columns.classification"),
    columnPaid: t("informationReturns.columns.paid"),
    readiness: readiness.map((row) => ({
      partyId: row.partyId,
      vendorName: row.vendorName,
      // The vendor (payee) record carries TIN capture behind the
      // informationReturns switch itself, so a missing TIN never strands
      // an information-returns-only org on a compliance-gated drawer.
      href: `/parties?party=${row.partyId}&partyTab=compliance`,
      issueLabel: !row.reportable
        ? t("readiness.unflagged")
        : !row.hasTin
          ? t("readiness.missingTin")
          : t("readiness.noForm"),
      issueVariant: row.reportable ? "destructive" : "warning",
      classification: row.taxClassification ? t(`taxClassification.${row.taxClassification}`) : "—",
      paidThisYear: money(row.paidThisYear),
    })),
  };
}

const f = ref<InformationReturnsData>();
const item = field;
const rootF = rootRef<InformationReturnsData>();

const MUTED = "text-slate-500 dark:text-slate-400";

export function informationReturnsSpec(data: InformationReturnsData): PageSpec {
  return page({
    route: "/compliance/information-returns",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget(
            "new-filing",
            { formTypes: data.formTypes, defaultYear: data.defaultYear },
            f("canManage"),
          ),
        ],
      }),
      widgetBlock("module-home-tabs", { tabs: data.tabs }),
    ],
    body: [
      widgetBlock("module-home-tabs", { tabs: f("viewTabs"), placement: "local" }),
      {
        ...widgetBlock("empty-state", {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f("showFilingEmpty"),
      },
      {
        ...registeredListTable("compliance_information_returns", {
          variant: "app",
          rows: f("rows"),
          rowKey: item("id"),
          columns: [
            column(rootF("columnYear"), link(item("taxYear"), item("href"), "hover:underline"), {
              className: "font-medium tabular-nums",
            }),
            column(rootF("columnForm"), text(item("formType"))),
            column(rootF("columnEntity"), text(item("entity")), { className: MUTED }),
            column(
              rootF("columnRecipients"),
              text(item("includedCount"), {
                suffix: { field: item("excludedNote"), className: "ml-1 text-xs text-slate-400" },
              }),
              { align: "right", className: "tabular-nums" },
            ),
            column(rootF("columnTotal"), text(item("filedTotal")), {
              align: "right",
              className: "tabular-nums",
            }),
            column(
              rootF("columnStatus"),
              badge(item("statusLabel"), { variant: item("statusVariant") }),
            ),
            column(
              rootF("columnAttention"),
              widgetCell("badge-or-dash", {
                shown: item("missingTin"),
                label: item("missingTinLabel"),
                variant: "destructive",
              }),
            ),
          ],
        }),
        when: f("showFilingRows"),
      },
      {
        ...grid(
          "space-y-3",
          [
            heading(
              2,
              f("readinessTitle"),
              "mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100",
            ),
            textBlock(f("readinessDescription"), { size: "sm", className: "mb-1", tone: "muted" }),
            {
              ...textBlock(f("readinessClear"), {
                size: "sm",
                className:
                  "rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300",
              }),
              when: f("showReadinessClear"),
            },
            {
              ...registeredListTable("compliance_information_return_readiness", {
                variant: "app",
                rows: f("readiness"),
                rowKey: item("partyId"),
                columns: [
                  column(
                    rootF("columnVendor"),
                    link(item("vendorName"), item("href"), "hover:underline"),
                    {
                      className: "font-medium",
                    },
                  ),
                  column(
                    rootF("columnIssue"),
                    badge(item("issueLabel"), { variant: item("issueVariant") }),
                  ),
                  column(rootF("columnClassification"), text(item("classification")), {
                    className: MUTED,
                  }),
                  column(rootF("columnPaid"), text(item("paidThisYear")), {
                    align: "right",
                    className: "tabular-nums",
                  }),
                ],
              }),
              when: f("showReadinessRows"),
            },
          ],
          { as: "section" },
        ),
        when: f("showReadiness"),
      },
      widgetBlock("information-return-filing-drawer", {
        detail: f("filingDetail"),
        closeHref: f("filingCloseHref"),
      }),
    ],
  });
}
