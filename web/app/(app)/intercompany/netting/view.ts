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
  listNettingRuns,
  loadNettingRun,
  type NettingRunDetail,
} from "@openbooks/engine/intercompany";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, mergeHref, pickString } from "../../../../lib/list-params";
import { moduleDrawerHref } from "../../../../lib/txn-links";
import { getMoneyFormatter } from "@/lib/money-server";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";

/**
 * Intercompany netting runs: the list of runs and one drawer that proposes a
 * new run (preview first, then the stored proposal) or shows a run with the
 * actions its status admits — submit for approval, post, cancel, reverse.
 */

const BASE = "/intercompany/netting";

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "secondary" | "outline"> =
  {
    proposed: "outline",
    pending_approval: "warning",
    approved: "warning",
    rejected: "destructive",
    posted: "success",
    cancelled: "secondary",
    reversed: "secondary",
  };

export interface NettingRunRow {
  id: string;
  runNumber: string;
  href: string;
  asOfDate: string;
  entities: string;
  pairCount: string;
  lineCount: string;
  cashLabel: string;
  statusLabel: string;
  statusVariant: "success" | "warning" | "destructive" | "secondary" | "outline";
}

export interface NettingPageData {
  title: string;
  description: string;
  canManage: boolean;
  newHref: string;
  newLabel: string;
  isEmpty: boolean;
  hasRows: boolean;
  emptyTitle: string;
  emptyDescription: string;
  columns: Record<string, string>;
  rows: NettingRunRow[];
  drawerOpen: boolean;
  drawer: Record<string, unknown> | null;
}

async function subsidiaryAndBankOptions(orgId: string, allowed: ReadonlySet<string> | null) {
  const subsidiaries = (
    await db.execute<{ id: string; name: string; baseCurrency: string }>(
      sql`
    select id, name, base_currency as "baseCurrency" from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination
       ${subsidiaryVisibleFilter(sql`id`, allowed)}
     order by name`,
      "objects",
    )
  ).filter((sub) => allowed === null || allowed.has(sub.id));
  const banks = await db.execute<{
    id: string;
    label: string;
    subsidiaryId: string | null;
    currency: string | null;
  }>(
    sql`
    select id, concat_ws(' · ', number, name) as label, subsidiary_id as "subsidiaryId", currency_restriction as currency
      from accounts
     where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
     order by number nulls last, name`,
    "objects",
  );
  const currencyRows = await db.execute<{ subsidiary_id: string; currency: string }>(
    sql`
    select distinct subsidiary_id, currency from journal_lines where org_id = ${orgId}
      ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}`,
    "objects",
  );
  const currencies = [
    ...new Set([
      ...subsidiaries.map((sub) => sub.baseCurrency),
      ...banks
        .filter(
          (bank) =>
            bank.subsidiaryId === null || allowed === null || allowed.has(bank.subsidiaryId),
        )
        .flatMap((bank) => (bank.currency ? [bank.currency] : [])),
      ...currencyRows
        .filter((row) => allowed === null || allowed.has(row.subsidiary_id))
        .map((row) => row.currency),
    ]),
  ].sort();
  return { subsidiaries, banks, currencies };
}

function runDrawer(
  run: NettingRunDetail,
  t: (key: string) => string,
  money: (value: string, options: { currency: string }) => string,
  names: Map<string, string>,
) {
  return {
    id: run.id,
    runNumber: run.runNumber,
    status: run.status,
    statusLabel: t(`netting.statuses.${run.status}`),
    statusVariant: STATUS_TONE[run.status] ?? "outline",
    asOfDate: run.asOfDate,
    entities: run.subsidiaryIds.map((id) => names.get(id) ?? id).join(", "),
    settleCash: run.settleCash,
    reason: run.reason,
    fingerprint: run.fingerprint,
    decisionNote: run.decisionNote,
    cancelReason: run.cancelReason,
    reverseReason: run.reverseReason,
    reversalDate: run.reversalDate,
    warnings: run.computation.warnings,
    pairs: run.computation.pairs.map((pair) => ({
      key: `${pair.pairId}:${pair.currency}`,
      label: `${names.get(pair.fromSubsidiaryId) ?? ""} ↔ ${names.get(pair.toSubsidiaryId) ?? ""}`,
      currency: pair.currency,
      fromNet: money(pair.fromNet, { currency: pair.currency }),
      toNet: money(pair.toNet, { currency: pair.currency }),
      unreconciled: money(pair.unreconciled, { currency: pair.currency }),
      netted: money(pair.fromNetted, { currency: pair.currency }),
      cash: money(pair.cashToFrom, { currency: pair.currency }),
    })),
    lines: run.lines.map((line) => ({
      key: String(line.lineNumber),
      component: t(`netting.components.${line.component}`),
      entity: line.subsidiaryName,
      counterparty: line.counterpartySubsidiaryName,
      reference: line.documentNumber ?? line.accountLabel,
      href: moduleDrawerHref(line.documentKind, line.documentId),
      open:
        line.component === "cash" ? "" : money(line.openTransaction, { currency: line.currency }),
      netted: money(line.netted, { currency: line.currency }),
      cash: money(line.cash, { currency: line.currency }),
      rate: line.rate,
      realizedFx: money(line.realizedFx, { currency: line.functionalCurrency }),
    })),
    entryHrefs: run.entryIds.map((id) => `/journal?journalEntry=${id}`),
  };
}

export async function loadNettingPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<NettingPageData> {
  const authz = await requirePermission("intercompany.read");
  await requireFeatureEnabled(authz.user.orgId, "intercompanyNetting");
  const orgId = authz.user.orgId;
  const t = await getTranslations("intercompany");
  const { money } = await getMoneyFormatter();
  const canManage = can(authz, "intercompany.manage");
  const canSettle = can(authz, "intercompany.settle");
  const runs = await listNettingRuns(orgId, authz.allowedSubsidiaryIds);
  const names = new Map(
    (
      await db.execute<{ id: string; name: string }>(
        sql`
    select id, name from subsidiaries where org_id = ${orgId}`,
        "objects",
      )
    ).map((row) => [row.id, row.name]),
  );
  const runParam = pickString(sp.run);
  const closeHref = mergeHref(BASE, sp, { run: undefined });
  let drawer: Record<string, unknown> | null = null;
  if (runParam === "new" && canManage) {
    const options = await subsidiaryAndBankOptions(orgId, authz.allowedSubsidiaryIds);
    drawer = {
      mode: "new",
      closeHref,
      today: await businessToday(orgId),
      ...options,
      canManage,
      canSettle,
    };
  } else if (runParam && isUuid(runParam)) {
    const run = await loadNettingRun(orgId, runParam, authz.allowedSubsidiaryIds).catch(
      (error: unknown) => {
        if (error instanceof IntercompanyError && error.status === 404) return null;
        throw error;
      },
    );
    if (run) {
      drawer = {
        mode: "view",
        closeHref,
        today: await businessToday(orgId),
        run: runDrawer(run, t, money, names),
        canManage,
        canSettle,
      };
    }
  }
  return {
    title: t("netting.title"),
    description: t("netting.description"),
    canManage,
    newHref: mergeHref(BASE, sp, { run: "new" }),
    newLabel: t("netting.new"),
    isEmpty: runs.length === 0,
    hasRows: runs.length > 0,
    emptyTitle: t("netting.empty.title"),
    emptyDescription: t("netting.empty.description"),
    columns: {
      run: t("netting.columns.run"),
      asOf: t("netting.columns.asOf"),
      entities: t("netting.columns.entities"),
      pairs: t("netting.columns.pairs"),
      lines: t("netting.columns.lines"),
      cash: t("netting.columns.cash"),
      status: t("netting.columns.status"),
    },
    rows: runs.map((run) => ({
      id: run.id,
      runNumber: run.runNumber,
      href: mergeHref(BASE, sp, { run: run.id }),
      asOfDate: run.asOfDate,
      entities: run.subsidiaryIds.map((id) => names.get(id) ?? id).join(", "),
      pairCount: String(run.pairCount),
      lineCount: String(run.lineCount),
      cashLabel: run.settleCash ? t("netting.cashYes") : t("netting.cashNo"),
      statusLabel: t(`netting.statuses.${run.status}`),
      statusVariant: STATUS_TONE[run.status] ?? "outline",
    })),
    drawerOpen: drawer !== null,
    drawer,
  };
}

const f = ref<NettingPageData>();
const item = field;
const rootF = rootRef<NettingPageData>();

export function nettingSpec(data: NettingPageData): PageSpec {
  return page({
    route: "/intercompany/netting",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget(
            "link-button",
            { href: data.newHref, label: data.newLabel, iconKey: "plus" },
            f("canManage"),
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
            registeredListTable("intercompany_netting_runs", {
              variant: "app",
              rows: f("rows"),
              rowKey: item("id"),
              columns: [
                column(rootF("columns.run"), link(item("runNumber"), item("href")), {
                  className: "font-medium",
                }),
                column(rootF("columns.asOf"), text(item("asOfDate")), {
                  className: "tabular-nums",
                }),
                column(rootF("columns.entities"), text(item("entities"))),
                column(rootF("columns.pairs"), text(item("pairCount")), {
                  align: "right",
                  className: "tabular-nums",
                }),
                column(rootF("columns.lines"), text(item("lineCount")), {
                  align: "right",
                  className: "tabular-nums",
                }),
                column(rootF("columns.cash"), text(item("cashLabel")), { className: "text-xs" }),
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
      widgetBlock("intercompany-netting-drawer", { drawer: data.drawer }, f("drawerOpen")),
    ],
  });
}
