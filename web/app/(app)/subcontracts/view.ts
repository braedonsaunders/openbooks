import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import {
  listSubcontractRegister,
  type SubcontractRegisterRow,
} from "@openbooks/engine/projects/subcontracts";
import {
  page,
  pageHeader,
  ref,
  column,
  link,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { requireSubcontractsFeature } from "../../../lib/subcontracts-gate";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import { createMoneyFormatter } from "../../../lib/money-format";
import type { ListToolbarFilter } from "../../../components/list-toolbar";
import { registeredListTable } from "../../../lib/list/prepared-spec";

export type SubcontractOption = {
  id: string;
  name: string;
  currency?: string | null;
};

export type SubcontractRegisterItem = SubcontractRegisterRow & {
  statusLabel: string;
  revisedCommitmentLabel: string;
  billedToDateLabel: string;
  href: string;
};

export interface SubcontractsData {
  title: string;
  description: string;
  registerHint: string;
  emptyTitle: string;
  emptyHint: string;
  newButtonLabel: string;
  searchPlaceholder: string;
  columns: {
    number: string;
    subcontract: string;
    project: string;
    vendor: string;
    revised: string;
    billed: string;
    status: string;
  };
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  filters: ListToolbarFilter[];
  rows: SubcontractRegisterItem[];
  total: number;
  page: number;
  perPage: number;
  projects: SubcontractOption[];
  vendors: SubcontractOption[];
  expenseAccounts: SubcontractOption[];
  parties: SubcontractOption[];
  multiCurrency: boolean;
  permissions: {
    create: boolean;
    approve: boolean;
    post: boolean;
    pay: boolean;
  };
}

const STATUS_VALUES = [
  "draft",
  "pending_approval",
  "active",
  "substantially_complete",
  "closed",
  "void",
] as const;
type Status = (typeof STATUS_VALUES)[number];
type SearchParams = Record<string, string | string[] | undefined>;
const scalar = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function registerHref(sp: SearchParams, id: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (!["subcontract", "tab"].includes(key) && typeof value === "string") params.set(key, value);
  }
  params.set("subcontract", id);
  params.set("tab", "overview");
  return `/subcontracts?${params}`;
}

export async function loadSubcontracts(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<SubcontractsData> {
  const authz = await requirePermission("ap.read");
  await requireSubcontractsFeature(authz.user.orgId);
  const [t, common, locale] = await Promise.all([
    getTranslations("subcontracts"),
    getTranslations("common"),
    getLocale(),
  ]);
  const orgId = authz.user.orgId;
  const multiCurrency = await isFeatureEnabled(orgId, "multiCurrency");
  const rawStatus = scalar(sp.status);
  const status =
    rawStatus && STATUS_VALUES.includes(rawStatus as Status) ? (rawStatus as Status) : undefined;
  const pageValue = Number.parseInt(scalar(sp.page) ?? "1", 10);
  const perPageValue = Number.parseInt(scalar(sp.perPage) ?? "25", 10);
  const page = Number.isInteger(pageValue) ? Math.min(100_000, Math.max(1, pageValue)) : 1;
  const perPage = Number.isInteger(perPageValue) ? Math.min(100, Math.max(10, perPageValue)) : 25;
  const q = scalar(sp.q)?.slice(0, 200);

  const loaded = await withScopeSnapshot(orgId, async () => {
    const projects = await db.execute<SubcontractOption>(
      sql`select id, name from projects
      where org_id = ${orgId} and is_active and status not in ('closed','cancelled')
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
      order by name`,
      "objects",
    );
    const vendors = multiCurrency
      ? await db.execute<SubcontractOption>(
          sql`select p.id, p.display_name as name, vr.currency from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active
          ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
        order by p.display_name`,
          "objects",
        )
      : await db.execute<SubcontractOption>(
          sql`select p.id, p.display_name as name from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active
          ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
        order by p.display_name`,
          "objects",
        );
    const accounts = await db.execute<SubcontractOption>(
      sql`select id, concat_ws(' · ', number, name) as name from accounts
      where org_id = ${orgId} and is_active and not is_summary and type in ('expense','cogs')
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
      order by number nulls last`,
      "objects",
    );
    const parties = await db.execute<SubcontractOption>(
      sql`select id, display_name as name from parties
      where org_id = ${orgId} and is_active
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
      order by display_name limit 2000`,
      "objects",
    );
    const register = await listSubcontractRegister(db, {
      orgId,
      actorId: authz.user.id,
      requestedScope: authz.allowedSubsidiaryIds,
      q,
      status,
      page,
      perPage,
    });
    return { projects, vendors, accounts, parties, register };
  });

  return {
    title: t("title"),
    description: t("description"),
    registerHint: t("register.hint"),
    emptyTitle: t("register.emptyTitle"),
    emptyHint: t("register.emptyHint"),
    newButtonLabel: t("register.newButton"),
    searchPlaceholder: common("actions.search"),
    columns: {
      number: t("columns.number"),
      subcontract: t("columns.subcontract"),
      project: t("columns.project"),
      vendor: t("columns.vendor"),
      revised: t("columns.revised"),
      billed: t("columns.billed"),
      status: t("columns.status"),
    },
    basePath: "/subcontracts",
    currentParams: { ...sp, status, page: String(page), perPage: String(perPage), q },
    filters: [
      {
        paramKey: "status",
        label: t("columns.status"),
        allLabel: common("labels.all"),
        options: STATUS_VALUES.map((value) => ({
          value,
          label: t(
            `statusNames.${value === "pending_approval" ? "pendingApproval" : value === "substantially_complete" ? "substantiallyComplete" : value}`,
          ),
        })),
      },
    ],
    rows: loaded.register.rows.map((row) => {
      const formatter = createMoneyFormatter(locale, row.currency);
      const statusName =
        row.status === "pending_approval"
          ? "pendingApproval"
          : row.status === "substantially_complete"
            ? "substantiallyComplete"
            : row.status;
      return {
        ...row,
        statusLabel: t(`statusNames.${statusName}`),
        revisedCommitmentLabel: formatter.money(row.revisedCommitment),
        billedToDateLabel: formatter.money(row.billedToDate),
        href: registerHref(sp, row.id),
      };
    }),
    total: loaded.register.total,
    page: loaded.register.page,
    perPage: loaded.register.perPage,
    projects: loaded.projects as SubcontractOption[],
    vendors: loaded.vendors as SubcontractOption[],
    expenseAccounts: loaded.accounts as SubcontractOption[],
    parties: loaded.parties as SubcontractOption[],
    multiCurrency,
    permissions: {
      create: can(authz, "ap.create"),
      approve: can(authz, "ap.approve"),
      post: can(authz, "ap.post"),
      pay: can(authz, "ap.pay"),
    },
  };
}

const f = ref<SubcontractsData>();
const row = ref<SubcontractsData["rows"][number]>();

export function subcontractsSpec(data: SubcontractsData): PageSpec {
  return page({
    route: "/subcontracts",
    layout: "list",
    bodyClassName: "flex h-full min-h-0 flex-col",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex items-center gap-2",
        actions: [
          widget(
            "link-button",
            {
              href: "/subcontracts?subcontract=new",
              label: f("newButtonLabel"),
              iconKey: "plus",
            },
            f("permissions.create"),
          ),
        ],
      }),
    ],
    body: [
      widgetBlock("page-notice", { message: f("registerHint") }),
      registeredListTable(
        "subcontracts_register",
        {
          variant: "app",
          rows: f("rows"),
          rowKey: row("id"),
          empty: { title: f("emptyTitle"), description: f("emptyHint") },
          columns: [
            column(f("columns.number"), link(row("number"), row("href")), {
              className: "font-medium",
            }),
            column(f("columns.subcontract"), text(row("title"))),
            column(f("columns.project"), text(row("projectName"))),
            column(f("columns.vendor"), text(row("vendorName"))),
            column(f("columns.status"), text(row("statusLabel"))),
            column(f("columns.revised"), text(row("revisedCommitmentLabel")), {
              align: "right",
              className: "tabular-nums",
            }),
            column(f("columns.billed"), text(row("billedToDateLabel")), {
              align: "right",
              className: "tabular-nums",
            }),
          ],
        },
        [
          widget("list-toolbar", {
            basePath: f("basePath"),
            currentParams: f("currentParams"),
            search: { placeholder: f("searchPlaceholder") },
            filters: f("filters"),
          }),
        ],
      ),
      widgetBlock("subcontracts-workspace", {
        projects: data.projects,
        vendors: data.vendors,
        expenseAccounts: data.expenseAccounts,
        parties: data.parties,
        multiCurrency: data.multiCurrency,
        permissions: data.permissions,
      }),
    ],
  });
}
