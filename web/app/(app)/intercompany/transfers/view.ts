import "server-only";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  IntercompanyError,
  listIntercompanyFundTransfers,
  loadIntercompanyFundTransfer,
} from "@openbooks/engine/intercompany";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, mergeHref, pickString } from "../../../../lib/list-params";
import { getMoneyFormatter } from "@/lib/money-server";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";

/**
 * Bank transfers between entities: each moves cash from one entity's bank
 * account to another's and posts the pair's due-to/due-from legs. One drawer
 * records a new transfer or shows one with its reversal.
 */

const BASE = "/intercompany/transfers";

export interface TransferRow {
  id: string;
  transferNumber: string;
  href: string;
  transferDate: string;
  route: string;
  amount: string;
  statusLabel: string;
  statusVariant: "success" | "secondary";
}

export interface TransfersPageData {
  title: string;
  description: string;
  canSettle: boolean;
  newHref: string;
  newLabel: string;
  isEmpty: boolean;
  hasRows: boolean;
  emptyTitle: string;
  emptyDescription: string;
  columns: Record<string, string>;
  rows: TransferRow[];
  drawerOpen: boolean;
  drawer: Record<string, unknown> | null;
}

export async function loadTransfersPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<TransfersPageData> {
  const authz = await requirePermission("intercompany.read");
  await requireFeatureEnabled(authz.user.orgId, "intercompanyNetting");
  const orgId = authz.user.orgId;
  const t = await getTranslations("intercompany");
  const { money } = await getMoneyFormatter();
  const canSettle = can(authz, "intercompany.settle");
  const transfers = await listIntercompanyFundTransfers(orgId, authz.allowedSubsidiaryIds);
  const subsidiaries = await db.execute<{ id: string; name: string; baseCurrency: string }>(
    sql`
    select id, name, base_currency as "baseCurrency" from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination
       ${subsidiaryVisibleFilter(sql`id`, authz.allowedSubsidiaryIds)} order by name`,
    "objects",
  );
  const names = new Map(subsidiaries.map((sub) => [sub.id, sub.name]));
  const accounts = await db.execute<{
    id: string;
    label: string;
    subsidiaryId: string | null;
    currency: string | null;
  }>(
    sql`
    select id, concat_ws(' · ', number, name) as label, subsidiary_id as "subsidiaryId", currency_restriction as currency
      from accounts
     where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
     order by number nulls last, name`,
    "objects",
  );
  const accountLabels = new Map(accounts.map((account) => [account.id, account.label]));
  const param = pickString(sp.transfer);
  const closeHref = mergeHref(BASE, sp, { transfer: undefined });
  let drawer: Record<string, unknown> | null = null;
  if (param === "new" && canSettle) {
    drawer = {
      mode: "new",
      closeHref,
      today: await businessToday(orgId),
      subsidiaries: subsidiaries.filter(
        (sub) => authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(sub.id),
      ),
      banks: accounts,
      canSettle,
    };
  } else if (param && isUuid(param)) {
    const transfer = await loadIntercompanyFundTransfer(
      orgId,
      param,
      authz.allowedSubsidiaryIds,
    ).catch((error: unknown) => {
      if (error instanceof IntercompanyError && error.status === 404) return null;
      throw error;
    });
    if (transfer) {
      drawer = {
        mode: "view",
        closeHref,
        today: await businessToday(orgId),
        canSettle,
        transfer: {
          id: transfer.id,
          transferNumber: transfer.transferNumber,
          transferDate: transfer.transferDate,
          status: transfer.status,
          statusLabel: t(`transfers.statuses.${transfer.status}`),
          from: `${names.get(transfer.fromSubsidiaryId) ?? ""} · ${accountLabels.get(transfer.fromBankAccountId) ?? ""}`,
          to: `${names.get(transfer.toSubsidiaryId) ?? ""} · ${accountLabels.get(transfer.toBankAccountId) ?? ""}`,
          amount: money(transfer.amount, { currency: transfer.currency }),
          memo: transfer.memo,
          reason: transfer.reason,
          entryHref: `/journal?journalEntry=${transfer.entryId}`,
          reversalEntryHref: transfer.reversalEntryId
            ? `/journal?journalEntry=${transfer.reversalEntryId}`
            : null,
          reversalDate: transfer.reversalDate,
          reverseReason: transfer.reverseReason,
        },
      };
    }
  }
  return {
    title: t("transfers.title"),
    description: t("transfers.description"),
    canSettle,
    newHref: mergeHref(BASE, sp, { transfer: "new" }),
    newLabel: t("transfers.new"),
    isEmpty: transfers.length === 0,
    hasRows: transfers.length > 0,
    emptyTitle: t("transfers.empty.title"),
    emptyDescription: t("transfers.empty.description"),
    columns: {
      transfer: t("transfers.columns.transfer"),
      date: t("transfers.columns.date"),
      route: t("transfers.columns.route"),
      amount: t("transfers.columns.amount"),
      status: t("transfers.columns.status"),
    },
    rows: transfers.map((transfer) => ({
      id: transfer.id,
      transferNumber: transfer.transferNumber,
      href: mergeHref(BASE, sp, { transfer: transfer.id }),
      transferDate: transfer.transferDate,
      route: `${names.get(transfer.fromSubsidiaryId) ?? ""} → ${names.get(transfer.toSubsidiaryId) ?? ""}`,
      amount: money(transfer.amount, { currency: transfer.currency }),
      statusLabel: t(`transfers.statuses.${transfer.status}`),
      statusVariant: transfer.status === "posted" ? "success" : "secondary",
    })),
    drawerOpen: drawer !== null,
    drawer,
  };
}

const f = ref<TransfersPageData>();
const item = field;
const rootF = rootRef<TransfersPageData>();

export function transfersSpec(data: TransfersPageData): PageSpec {
  return page({
    route: "/intercompany/transfers",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget(
            "link-button",
            { href: data.newHref, label: data.newLabel, iconKey: "plus" },
            f("canSettle"),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock("empty-state", {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f("isEmpty"),
      },
      {
        ...grid(
          "mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
          [
            registeredListTable("intercompany_transfers", {
              variant: "app",
              rows: f("rows"),
              rowKey: item("id"),
              columns: [
                column(rootF("columns.transfer"), link(item("transferNumber"), item("href")), {
                  className: "font-medium",
                }),
                column(rootF("columns.date"), text(item("transferDate")), {
                  className: "tabular-nums",
                }),
                column(rootF("columns.route"), text(item("route"))),
                column(rootF("columns.amount"), text(item("amount")), {
                  align: "right",
                  className: "tabular-nums",
                }),
                column(
                  rootF("columns.status"),
                  badge(item("statusLabel"), { variant: item("statusVariant") }),
                ),
              ],
            }),
          ],
        ),
        when: f("hasRows"),
      },
      widgetBlock("intercompany-transfer-drawer", { drawer: data.drawer }, f("drawerOpen")),
    ],
  });
}
