import "server-only";

import { getTranslations } from "next-intl/server";
import {
  badge,
  column,
  field,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  txn,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { listAccountMerges } from "@openbooks/engine/chart/account-merge";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, pickString } from "../../../../lib/list-params";

/**
 * Merge history: every executed account merge and every merge proposal,
 * newest first. A proposal awaiting approval or approved but not applied
 * links to its account, whose drawer carries the decision state and the
 * apply action.
 */

type StatusVariant = "success" | "warning" | "secondary" | "destructive" | "outline";

const STATUS_VARIANT: Record<string, StatusVariant> = {
  completed: "success",
  applied: "success",
  draft: "outline",
  pending: "warning",
  approved: "secondary",
  rejected: "destructive",
};

export interface AccountMergesData {
  title: string;
  description: string;
  tabs: { href: string; label: string; active: boolean }[];
  emptyTitle: string;
  isEmpty: boolean;
  hasRows: boolean;
  columnSource: string;
  columnSurvivor: string;
  columnEffective: string;
  columnStatus: string;
  columnReason: string;
  columnActor: string;
  columnEntry: string;
  rows: {
    id: string;
    sourceLabel: string;
    sourceHref: string;
    targetLabel: string;
    targetHref: string;
    effectiveDate: string;
    statusLabel: string;
    statusVariant: StatusVariant;
    reason: string;
    actor: string;
    entryLabel: string;
    txn: { kind: "transaction"; entryId: string } | null;
  }[];
}

export async function loadAccountMerges(
  sp: Record<string, string | string[] | undefined>,
): Promise<AccountMergesData> {
  const authz = await requirePermission("gl.read");
  await requireFeatureEnabled(authz.user.orgId, "accountMerges");
  const t = await getTranslations("accounts");
  const account = pickString(sp.account);
  const { rows } = await listAccountMerges(authz.user.orgId, {
    limit: 500,
    offset: 0,
    accountId: account && isUuid(account) ? account : null,
  });
  return {
    title: t("merge.historyTitle"),
    description: t("merge.historyDescription"),
    tabs: [
      { href: "/accounts", label: t("list.views.list"), active: false },
      { href: "/accounts?layout=hierarchy", label: t("list.views.hierarchy"), active: false },
      { href: "/accounts/merges", label: t("merge.history"), active: true },
    ],
    emptyTitle: t("merge.historyEmpty"),
    isEmpty: rows.length === 0,
    hasRows: rows.length > 0,
    columnSource: t("merge.columns.source"),
    columnSurvivor: t("merge.columns.survivor"),
    columnEffective: t("merge.effectiveDate"),
    columnStatus: t("merge.columns.status"),
    columnReason: t("merge.reason"),
    columnActor: t("merge.columns.actor"),
    columnEntry: t("merge.columns.entries"),
    rows: rows.map((row) => ({
      id: row.id,
      sourceLabel: row.sourceLabel,
      sourceHref: `/accounts?account=${row.sourceAccountId}`,
      targetLabel: row.targetLabel,
      targetHref: `/accounts?account=${row.targetAccountId}`,
      effectiveDate: row.effectiveDate,
      statusLabel: t(`merge.status.${row.status}`),
      statusVariant: STATUS_VARIANT[row.status] ?? "outline",
      reason: row.reason,
      actor: `${row.actorName ?? "—"} · ${row.at.slice(0, 10)}`,
      entryLabel: row.entryIds.length > 0 ? t("merge.viewEntry") : "—",
      txn: row.entryIds[0] ? { kind: "transaction", entryId: row.entryIds[0] } : null,
    })),
  };
}

const f = ref<AccountMergesData>();
const item = field;
const rootF = rootRef<AccountMergesData>();

export function accountMergesSpec(data: AccountMergesData): PageSpec {
  return page({
    route: "/accounts/merges",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [widget("module-home-tabs", { tabs: data.tabs })],
      }),
    ],
    body: [
      {
        ...widgetBlock("empty-state", { title: data.emptyTitle, action: null }),
        when: f("isEmpty"),
      },
      {
        ...registeredListTable("accounts_merges", {
          variant: "app",
          rows: f("rows"),
          rowKey: item("id"),
          columns: [
            column(rootF("columnSource"), link(item("sourceLabel"), item("sourceHref"))),
            column(rootF("columnSurvivor"), link(item("targetLabel"), item("targetHref"))),
            column(rootF("columnEffective"), text(item("effectiveDate"))),
            column(
              rootF("columnStatus"),
              badge(item("statusLabel"), { variant: item("statusVariant") }),
            ),
            column(rootF("columnReason"), text(item("reason"))),
            column(rootF("columnActor"), text(item("actor"))),
            column(rootF("columnEntry"), txn(item("txn"), text(item("entryLabel")))),
          ],
        }),
        when: f("hasRows"),
      },
    ],
  });
}
