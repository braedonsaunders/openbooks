import "server-only";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import {
  badge,
  column,
  link,
  page,
  pageHeader,
  ref,
  text,
  widget,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import type { RebateAgreement, RebateClaim } from "@openbooks/engine/revenue/rebates";
import { getMoneyFormatter } from "@/lib/money-server";
import type { ListToolbarFilter } from "@/components/list-toolbar";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { isUuid, parseListParams, pickString } from "@/lib/list-params";
import { registeredListTable } from "@/lib/list/prepared-spec";

const AGREEMENT_STATUSES = ["draft", "approved"] as const;
const CLAIM_STATUSES = ["draft", "approved", "document_pending", "settled", "cancelled"] as const;
type RebateView = "agreements" | "claims";

export type RebateRegisterRow = {
  id: string;
  label: string;
  href: string;
  party: string;
  sideLabel: string;
  sideVariant: "outline" | "secondary";
  statusLabel: string;
  statusVariant: "outline" | "success" | "warning" | "secondary";
  amountLabel: string;
};

export type RebateDrawerData = {
  agreement: RebateAgreement;
  claim: RebateClaim | null;
  parties: { id: string; name: string }[];
  banks: { id: string; name: string }[];
  canPost: boolean;
  today: string;
  baseCurrency: string;
  sources: { lineId: string; documentId: string; label: string }[];
  closeHref: string;
};

export interface RebatesData {
  title: string;
  description: string;
  newAgreementLabel: string;
  settingsLabel: string;
  reportsLabel: string;
  settingsHref: string;
  reportsHref: string;
  canCreate: boolean;
  tabs: { href: string; label: string; active?: boolean }[];
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  filters: ListToolbarFilter[];
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  columns: {
    agreement: string;
    counterparty: string;
    side: string;
    status: string;
    amount: string;
  };
  view: RebateView;
  rows: RebateRegisterRow[];
  total: number;
  page: number;
  perPage: number;
  selected: RebateDrawerData | null;
}

type SearchParams = Record<string, string | string[] | undefined>;
type RawRegisterRow = {
  id: string;
  label: string;
  party: string;
  side: "customer" | "vendor";
  status: string;
  currency: string;
  amount: string | null;
};

function routeParams(sp: SearchParams, view: RebateView, recordId?: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "record" || key === "view" || typeof value !== "string") continue;
    params.set(key, value);
  }
  if (view === "claims") params.set("view", "claims");
  if (recordId) params.set("record", recordId);
  return params;
}

function hrefFor(sp: SearchParams, view: RebateView, recordId?: string): string {
  const query = routeParams(sp, view, recordId).toString();
  return query ? `/rebates?${query}` : "/rebates";
}

function statusVariant(status: string): RebateRegisterRow["statusVariant"] {
  if (status === "approved" || status === "settled") return "success";
  if (status === "document_pending") return "warning";
  if (status === "draft") return "outline";
  return "secondary";
}

export async function loadRebates(
  sp: Record<string, string | string[] | undefined>,
): Promise<RebatesData> {
  const t = await getTranslations("rebates");
  const authz = await requirePermission("documents.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "rebateManagement");

  const view: RebateView = pickString(sp.view) === "claims" ? "claims" : "agreements";
  const statuses: readonly string[] = view === "claims" ? CLAIM_STATUSES : AGREEMENT_STATUSES;
  const params = parseListParams(sp, { sort: "code", allowedSorts: ["code"] });
  const requestedStatus = pickString(sp.status);
  const status =
    requestedStatus && statuses.includes(requestedStatus) ? requestedStatus : undefined;
  const requestedSide = pickString(sp.side);
  const sideFilter =
    requestedSide === "customer" || requestedSide === "vendor" ? requestedSide : undefined;
  const canReadCustomers = can(authz, "ar.read");
  const canReadVendors = can(authz, "ap.read");
  const sidePermission = sql`and ((a.side = 'customer' and ${canReadCustomers}) or (a.side = 'vendor' and ${canReadVendors}))`;
  const sideScope = subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds);
  const q = params.q
    ? sql`and (a.code ilike ${`%${params.q}%`} or a.name ilike ${`%${params.q}%`} or p.display_name ilike ${`%${params.q}%`})`
    : sql``;
  const statusFilter = status
    ? sql`and ${view === "claims" ? sql`c.status` : sql`a.status`} = ${status}`
    : sql``;
  const selectedId = pickString(sp.record);

  const loaded = await withScopeSnapshot(orgId, async () => {
    const from =
      view === "claims"
        ? sql`rebate_claims c join rebate_agreements a on a.org_id = c.org_id and a.id = c.agreement_id left join parties p on p.org_id = c.org_id and p.id = c.party_id`
        : sql`rebate_agreements a left join parties p on p.org_id = a.org_id and p.id = a.party_id`;
    const where = sql`where a.org_id = ${orgId} ${sideScope} ${sidePermission}
      ${sideFilter ? sql`and a.side = ${sideFilter}` : sql``} ${statusFilter} ${q}`;
    const total = Number(
      (
        await db.execute<{ total: string }>(
          sql`
      select count(*)::text as total from ${from} ${where}`,
          "objects",
        )
      )[0]?.total ?? 0,
    );
    const rows = await db.execute<RawRegisterRow>(
      sql`
      select ${view === "claims" ? sql`c.id` : sql`a.id`} as id,
             a.code || ' · ' || a.name as label,
             coalesce(p.display_name, ${t("classAgreement")}) as party,
             a.side, ${view === "claims" ? sql`c.status` : sql`a.status`} as status,
             a.currency, ${view === "claims" ? sql`c.amount::text` : sql`null::text`} as amount
        from ${from} ${where}
       order by a.code, ${view === "claims" ? sql`c.created_at desc, c.id` : sql`a.id`}
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`,
      "objects",
    );

    let selected: RebateDrawerData | null = null;
    if (selectedId && isUuid(selectedId)) {
      const agreement = (
        await db.execute<RebateAgreement>(
          sql`
        select a.* from rebate_agreements a
        ${view === "claims" ? sql`join rebate_claims c on c.org_id = a.org_id and c.agreement_id = a.id` : sql``}
         where a.org_id = ${orgId} and ${view === "claims" ? sql`c.id` : sql`a.id`} = ${selectedId}
           ${sideScope} ${sidePermission} ${sideFilter ? sql`and a.side = ${sideFilter}` : sql``}`,
          "objects",
        )
      )[0];
      if (agreement) {
        const claim =
          view === "claims"
            ? ((
                await db.execute<RebateClaim>(
                  sql`select * from rebate_claims where org_id = ${orgId} and id = ${selectedId}`,
                  "objects",
                )
              )[0] ?? null)
            : null;
        const [parties, banks, base] = await Promise.all([
          db.execute<{ id: string; name: string }>(
            sql`
            select distinct p.id, p.display_name as name from rebate_accruals f
            join parties p on p.org_id = f.org_id and p.id = f.party_id
             where f.org_id = ${orgId} and f.agreement_id = ${agreement.id}
             order by p.display_name, p.id`,
            "objects",
          ),
          db.execute<{ id: string; name: string }>(
            sql`
            select id, name from accounts where org_id = ${orgId} and type = 'asset_bank'
              and is_active and not is_summary
              and (subsidiary_id is null or subsidiary_id = ${agreement.subsidiary_id})
              ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
             order by number, name`,
            "objects",
          ),
          db.execute<{ base_currency: string }>(
            sql`
            select base_currency from subsidiaries where org_id = ${orgId} and id = ${agreement.subsidiary_id}`,
            "objects",
          ),
        ]);
        const sources = await db.execute<{ lineId: string; documentId: string; label: string }>(
          sql`
          select dl.id as "lineId", d.id as "documentId",
                 d.document_number || ' · ' || coalesce(dl.description, ${t("drawer.line")} || ' ' || dl.line_number::text) as label
            from document_lines dl join documents d on d.org_id = dl.org_id and d.id = dl.document_id
           where d.org_id = ${orgId} and d.status in ('draft', 'approved', 'posted')
             and d.currency = ${agreement.currency} and d.subsidiary_id = ${agreement.subsidiary_id}
             and d.document_date between ${agreement.effective_from} and ${agreement.effective_to}
             and d.kind in ${
               agreement.activity === "purchase"
                 ? ["vendor_bill", "vendor_credit"]
                 : ["customer_invoice", "cash_sale", "customer_credit", "cash_refund"]
             }
             ${agreement.party_id && agreement.activity !== "downstream_sale" ? sql`and d.party_id = ${agreement.party_id}` : sql``}
             ${agreement.item_id ? sql`and dl.item_id = ${agreement.item_id}` : sql``}
             ${agreement.class_id ? sql`and coalesce(dl.class_id, d.class_id) = ${agreement.class_id}` : sql``}
           order by d.document_date desc, d.document_number, dl.line_number`,
          "objects",
        );
        const baseCurrency = base[0]?.base_currency;
        if (claim !== null || view === "agreements") {
          if (baseCurrency) {
            selected = {
              agreement,
              claim,
              parties,
              banks,
              canPost: can(authz, agreement.side === "customer" ? "ar.post" : "ap.post"),
              today: await businessToday(orgId),
              baseCurrency,
              sources,
              closeHref: hrefFor(sp, view),
            };
          }
        }
      }
    }
    return { rows, total, selected };
  });

  const rows = await Promise.all(
    loaded.rows.map(async (row) => {
      const formatter = await getMoneyFormatter(orgId, row.currency);
      const knownStatuses = view === "claims" ? CLAIM_STATUSES : AGREEMENT_STATUSES;
      const status = knownStatuses.find((candidate) => candidate === row.status) ?? "unknown";
      return {
        ...row,
        href: hrefFor(sp, view, row.id),
        sideLabel: t(`sides.${row.side}`),
        sideVariant: row.side === "customer" ? ("outline" as const) : ("secondary" as const),
        statusLabel: t(`statuses.${status}`),
        statusVariant: statusVariant(row.status),
        amountLabel:
          row.amount === null ? "" : formatter.money(row.amount, { currency: row.currency }),
      };
    }),
  );
  const currentParams = {
    ...sp,
    view: view === "claims" ? "claims" : undefined,
    page: String(params.page),
    perPage: String(params.perPage),
    q: params.q,
    side: sideFilter,
    status,
  };
  const statusValues = view === "claims" ? CLAIM_STATUSES : AGREEMENT_STATUSES;
  const drawer = loaded.selected ? { ...loaded.selected, closeHref: hrefFor(sp, view) } : null;

  return {
    title: t("title"),
    description: t("description"),
    newAgreementLabel: t("actions.newAgreement"),
    settingsLabel: t("actions.agreementSettings"),
    reportsLabel: t("actions.reports"),
    settingsHref: "/admin/setup/rebate-agreements",
    reportsHref: "/reports?category=orders",
    canCreate: can(authz, "admin.setup.manage") && can(authz, "documents.manage"),
    tabs: [
      { href: "/rebates", label: t("tabs.agreements"), active: view === "agreements" },
      { href: "/rebates?view=claims", label: t("tabs.claims"), active: view === "claims" },
    ],
    basePath: "/rebates",
    currentParams,
    filters: [
      {
        paramKey: "side",
        label: t("filters.side"),
        allLabel: t("filters.all"),
        options: [
          { value: "customer", label: t("sides.customer") },
          { value: "vendor", label: t("sides.vendor") },
        ],
      },
      {
        paramKey: "status",
        label: t("filters.status"),
        allLabel: t("filters.all"),
        options: statusValues.map((value) => ({ value, label: t(`statuses.${value}`) })),
      },
    ],
    searchPlaceholder: t("searchPlaceholder"),
    emptyTitle: t(`empty.${view}.title`),
    emptyDescription: t(`empty.${view}.description`),
    columns: {
      agreement: t("columns.agreement"),
      counterparty: t("columns.counterparty"),
      side: t("columns.side"),
      status: t("columns.status"),
      amount: t("columns.amount"),
    },
    view,
    rows,
    total: loaded.total,
    page: params.page,
    perPage: params.perPage,
    selected: drawer,
  };
}

const f = ref<RebatesData>();
const row = ref<RebateRegisterRow>();

export function rebatesSpec(data: RebatesData): PageSpec {
  return page({
    route: "/rebates",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions: [
          widget("module-home-tabs", { tabs: f("tabs") }),
          widget("link-button", {
            href: f("settingsHref"),
            label: f("settingsLabel"),
            variant: "outline",
          }),
          widget("link-button", {
            href: f("reportsHref"),
            label: f("reportsLabel"),
            variant: "outline",
          }),
          widget(
            "link-button",
            {
              href: "/admin/setup/rebate-agreements?row=new",
              label: f("newAgreementLabel"),
              iconKey: "plus",
            },
            f("canCreate"),
          ),
        ],
      }),
    ],
    body: [
      registeredListTable(
        data.view === "claims" ? "rebate_claims" : "rebate_agreements",
        {
          variant: "app",
          rows: f("rows"),
          rowKey: row("id"),
          empty: { title: f("emptyTitle"), description: f("emptyDescription") },
          columns: [
            column(f("columns.agreement"), link(row("label"), row("href")), {
              className: "font-medium",
            }),
            column(f("columns.counterparty"), text(row("party"))),
            column(f("columns.side"), badge(row("sideLabel"), { variant: row("sideVariant") })),
            column(
              f("columns.status"),
              badge(row("statusLabel"), { variant: row("statusVariant") }),
            ),
            ...(data.view === "claims"
              ? [
                  column(f("columns.amount"), text(row("amountLabel")), {
                    align: "right",
                    className: "tabular-nums",
                  }),
                ]
              : []),
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
    ],
  });
}
