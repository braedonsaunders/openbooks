import "server-only";

import { getTranslations } from "next-intl/server";
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
  widgetCell,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  IntercompanyError,
  intercompanyWorkspace,
  loadIntercompanyPairDetail,
  type PairDetail,
  type PairMismatch,
  type UnpairedDocument,
} from "@openbooks/engine/intercompany";
import { registeredListTable } from "../../../lib/list/prepared-spec";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { isUuid, mergeHref, pickString } from "../../../lib/list-params";
import { moduleDrawerHref } from "../../../lib/txn-links";
import { getMoneyFormatter } from "@/lib/money-server";
import type { ModuleHomeTab } from "../../../components/module-home/tab-types";

/**
 * Intercompany pairing workspace. Every intercompany sales and purchase
 * document the caller can see in both entities, read as unpaired, mismatched
 * or paired — one view at a time. An unpaired document can generate its
 * counterpart in the other entity or be linked to an existing one; a pair
 * opens in a drawer with both documents side by side.
 */

const BASE = "/intercompany";
type View = "unpaired" | "mismatched" | "paired";

const STATE_TONE: Record<string, "success" | "warning" | "destructive"> = {
  in_sync: "success",
  awaiting_counterpart: "warning",
  mismatched: "destructive",
};

export interface UnpairedRow {
  id: string;
  documentNumber: string;
  href: string;
  kindLabel: string;
  entity: string;
  counterparty: string;
  party: string;
  date: string;
  amount: string;
  statusLabel: string;
  actions: { documentId: string; linkHref: string; canManage: boolean };
}

export interface PairRow {
  id: string;
  href: string;
  kindLabel: string;
  sellerNumber: string;
  sellerHref: string;
  buyerNumber: string;
  buyerHref: string;
  entities: string;
  sellerAmount: string;
  buyerAmount: string;
  stateLabel: string;
  stateVariant: "success" | "warning" | "destructive";
  issues: string;
}

export interface IntercompanyPairingData {
  title: string;
  description: string;
  tabs: ModuleHomeTab[];
  onUnpaired: boolean;
  onPairs: boolean;
  isEmpty: boolean;
  hasUnpaired: boolean;
  hasPairs: boolean;
  emptyTitle: string;
  emptyDescription: string;
  truncated: boolean;
  truncatedNote: string;
  columns: Record<string, string>;
  unpairedRows: UnpairedRow[];
  pairRows: PairRow[];
  reconciliationHref: string;
  reconciliationLabel: string;
  pairDrawerOpen: boolean;
  pairDrawer: Record<string, unknown> | null;
  linkDrawerOpen: boolean;
  linkDrawer: Record<string, unknown> | null;
}

function mismatchText(
  t: (key: string, values?: Record<string, string>) => string,
  mismatch: PairMismatch,
  itemNames: Map<string, string>,
): string {
  switch (mismatch.kind) {
    case "currency":
      return t("mismatch.currency", { seller: mismatch.seller, buyer: mismatch.buyer });
    case "amount":
      return t("mismatch.amount", { difference: mismatch.difference });
    case "quantity":
      return t("mismatch.quantity", {
        item: itemNames.get(mismatch.itemId) ?? mismatch.itemId,
        seller: mismatch.seller,
        buyer: mismatch.buyer,
      });
    case "voided":
      return t(mismatch.side === "seller" ? "mismatch.sellerVoided" : "mismatch.buyerVoided");
    default: {
      const unreachable: never = mismatch;
      throw new Error(`unhandled pair mismatch ${String(unreachable)}`);
    }
  }
}

export async function loadIntercompanyPairingPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<IntercompanyPairingData> {
  const authz = await requirePermission("intercompany.read");
  await requireFeatureEnabled(authz.user.orgId, "intercompanyTransactions");
  const orgId = authz.user.orgId;
  const t = await getTranslations("intercompany");
  const { money } = await getMoneyFormatter();
  const viewParam = pickString(sp.view);
  const view: View = viewParam === "mismatched" || viewParam === "paired" ? viewParam : "unpaired";
  const subsidiaryId = pickString(sp.sub);
  const workspace = await intercompanyWorkspace(orgId, authz.allowedSubsidiaryIds, {
    subsidiaryId: subsidiaryId && isUuid(subsidiaryId) ? subsidiaryId : null,
  });
  const canManage = can(authz, "intercompany.manage");

  const subsidiaryNames = new Map(
    (
      await db.execute<{ id: string; name: string }>(
        sql`
    select id, name from subsidiaries where org_id = ${orgId}`,
        "objects",
      )
    ).map((row) => [row.id, row.name]),
  );
  const itemIds = [
    ...new Set(
      [...workspace.mismatched, ...workspace.paired].flatMap((pair) =>
        pair.comparison.mismatches.flatMap((m) => (m.kind === "quantity" ? [m.itemId] : [])),
      ),
    ),
  ];
  const itemNames = new Map(
    itemIds.length === 0
      ? []
      : (
          await db.execute<{ id: string; label: string }>(
            sql`
    select id, coalesce(nullif(btrim(code), ''), name) as label from items
     where org_id = ${orgId} and id = any(${`{${itemIds.filter(isUuid).join(",")}}`}::uuid[])`,
            "objects",
          )
        ).map((row) => [row.id, row.label]),
  );

  const tabs: ModuleHomeTab[] = (["unpaired", "mismatched", "paired"] as const).map((key) => ({
    href: mergeHref(BASE, sp, {
      view: key === "unpaired" ? undefined : key,
      pair: undefined,
      link: undefined,
    }),
    label: t(`views.${key}`),
    active: view === key,
    count: workspace[key].length,
  }));

  const unpairedRows: UnpairedRow[] = workspace.unpaired.map((doc: UnpairedDocument) => ({
    id: doc.documentId,
    documentNumber: doc.documentNumber,
    href: moduleDrawerHref(doc.kind, doc.documentId) ?? "#",
    kindLabel: t(`kinds.${doc.kind}`),
    entity: doc.subsidiaryName,
    counterparty: doc.counterpartySubsidiaryName,
    party: doc.partyName,
    date: doc.documentDate,
    amount: money(doc.total, { currency: doc.currency }),
    statusLabel: t(`statuses.${doc.status}`),
    actions: {
      documentId: doc.documentId,
      linkHref: mergeHref(BASE, sp, { link: doc.documentId, pair: undefined }),
      canManage,
    },
  }));

  const pairRow = (pair: PairDetail): PairRow => ({
    id: pair.id,
    href: mergeHref(BASE, sp, { pair: pair.id, link: undefined }),
    kindLabel: t(`pairKinds.${pair.pairKind}`),
    sellerNumber: pair.seller.documentNumber,
    sellerHref: moduleDrawerHref(pair.seller.kind, pair.seller.documentId) ?? "#",
    buyerNumber: pair.buyer.documentNumber,
    buyerHref: moduleDrawerHref(pair.buyer.kind, pair.buyer.documentId) ?? "#",
    entities: `${subsidiaryNames.get(pair.sellerSubsidiaryId) ?? ""} → ${subsidiaryNames.get(pair.buyerSubsidiaryId) ?? ""}`,
    sellerAmount: money(pair.seller.total, { currency: pair.seller.currency }),
    buyerAmount: money(pair.buyer.total, { currency: pair.buyer.currency }),
    stateLabel: t(`states.${pair.comparison.state}`),
    stateVariant: STATE_TONE[pair.comparison.state] ?? "warning",
    issues: pair.comparison.mismatches.map((m) => mismatchText(t, m, itemNames)).join(" · "),
  });
  const pairs = view === "mismatched" ? workspace.mismatched : workspace.paired;

  // The pair drawer opens from the URL, independent of the active view.
  const pairParam = pickString(sp.pair);
  const openPair =
    pairParam && isUuid(pairParam)
      ? ([...workspace.mismatched, ...workspace.paired].find((pair) => pair.id === pairParam) ??
        // An unlinked pair keeps its history and still opens from a deep link;
        // one outside the caller's scope reads as missing.
        (await loadIntercompanyPairDetail(orgId, pairParam, authz.allowedSubsidiaryIds).catch(
          (error: unknown) => {
            if (error instanceof IntercompanyError && error.status === 404) return null;
            throw error;
          },
        )))
      : null;
  const closeHref = mergeHref(BASE, sp, { pair: undefined, link: undefined });

  const linkParam = pickString(sp.link);
  const linkSource =
    linkParam && isUuid(linkParam)
      ? (workspace.unpaired.find((doc) => doc.documentId === linkParam) ?? null)
      : null;
  const candidates = linkSource
    ? workspace.unpaired.filter(
        (doc) =>
          doc.pairKind === linkSource.pairKind &&
          doc.side !== linkSource.side &&
          doc.subsidiaryId === linkSource.counterpartySubsidiaryId &&
          doc.counterpartySubsidiaryId === linkSource.subsidiaryId,
      )
    : [];

  return {
    title: t("title"),
    description: t("description"),
    tabs,
    onUnpaired: view === "unpaired",
    onPairs: view !== "unpaired",
    isEmpty: (view === "unpaired" ? workspace.unpaired.length : pairs.length) === 0,
    hasUnpaired: view === "unpaired" && workspace.unpaired.length > 0,
    hasPairs: view !== "unpaired" && pairs.length > 0,
    emptyTitle: t(`empty.${view}.title`),
    emptyDescription: t(`empty.${view}.description`),
    truncated: workspace.truncated,
    truncatedNote: t("truncated"),
    columns: {
      document: t("columns.document"),
      kind: t("columns.kind"),
      entity: t("columns.entity"),
      counterparty: t("columns.counterparty"),
      party: t("columns.party"),
      date: t("columns.date"),
      amount: t("columns.amount"),
      status: t("columns.status"),
      actions: t("columns.actions"),
      pair: t("columns.pair"),
      seller: t("columns.seller"),
      buyer: t("columns.buyer"),
      entities: t("columns.entities"),
      sellerAmount: t("columns.sellerAmount"),
      buyerAmount: t("columns.buyerAmount"),
      state: t("columns.state"),
      issues: t("columns.issues"),
    },
    unpairedRows: view === "unpaired" ? unpairedRows : [],
    pairRows: view === "unpaired" ? [] : pairs.map(pairRow),
    reconciliationHref: "/reports/intercompany-reconciliation",
    reconciliationLabel: t("openReconciliation"),
    pairDrawerOpen: Boolean(openPair),
    pairDrawer: openPair
      ? {
          pair: {
            id: openPair.id,
            status: openPair.status,
            kindLabel: t(`pairKinds.${openPair.pairKind}`),
            originLabel: t(`origins.${openPair.origin}`),
            stateLabel: t(`states.${openPair.comparison.state}`),
            stateVariant: STATE_TONE[openPair.comparison.state] ?? "warning",
            issues: openPair.comparison.mismatches.map((m) => mismatchText(t, m, itemNames)),
            linkReason: openPair.linkReason,
            linkedAt: openPair.linkedAt.slice(0, 10),
            unlinkReason: openPair.unlinkReason,
            sides: (["seller", "buyer"] as const).map((side) => {
              const doc = openPair[side];
              return {
                side,
                entity:
                  subsidiaryNames.get(
                    side === "seller" ? openPair.sellerSubsidiaryId : openPair.buyerSubsidiaryId,
                  ) ?? "",
                documentNumber: doc.documentNumber,
                href: moduleDrawerHref(doc.kind, doc.documentId) ?? "#",
                kindLabel: t(`kinds.${doc.kind}`),
                date: doc.documentDate,
                total: money(doc.total, { currency: doc.currency }),
                statusLabel: t(`statuses.${doc.status}`),
              };
            }),
          },
          closeHref,
          canManage,
        }
      : null,
    linkDrawerOpen: Boolean(linkSource),
    linkDrawer: linkSource
      ? {
          source: {
            documentId: linkSource.documentId,
            documentNumber: linkSource.documentNumber,
            side: linkSource.side,
            kindLabel: t(`kinds.${linkSource.kind}`),
            entity: linkSource.subsidiaryName,
            counterparty: linkSource.counterpartySubsidiaryName,
            amount: money(linkSource.total, { currency: linkSource.currency }),
          },
          candidates: candidates.map((doc) => ({
            documentId: doc.documentId,
            label: `${doc.documentNumber} · ${doc.documentDate} · ${money(doc.total, { currency: doc.currency })}`,
          })),
          closeHref,
          pairHrefBase: mergeHref(BASE, sp, { link: undefined, view: "paired" }),
          canManage,
        }
      : null,
  };
}

const f = ref<IntercompanyPairingData>();
const item = field;
const rootF = rootRef<IntercompanyPairingData>();
const MUTED = "text-slate-500 dark:text-slate-400";
const TABLE_FRAME =
  "mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";

export function intercompanyPairingSpec(data: IntercompanyPairingData): PageSpec {
  return page({
    route: "/intercompany",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("link-button", {
            href: data.reconciliationHref,
            label: data.reconciliationLabel,
            variant: "outline",
          }),
        ],
      }),
      widgetBlock("module-home-tabs", { tabs: data.tabs }),
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
        ...grid(TABLE_FRAME, [
          registeredListTable("intercompany_unpaired", {
            variant: "app",
            rows: f("unpairedRows"),
            rowKey: item("id"),
            columns: [
              column(rootF("columns.document"), link(item("documentNumber"), item("href")), {
                className: "font-medium",
              }),
              column(rootF("columns.kind"), text(item("kindLabel")), { className: "text-xs" }),
              column(rootF("columns.entity"), text(item("entity"))),
              column(rootF("columns.counterparty"), text(item("counterparty"))),
              column(rootF("columns.party"), text(item("party")), { className: MUTED }),
              column(rootF("columns.date"), text(item("date")), { className: "tabular-nums" }),
              column(rootF("columns.amount"), text(item("amount")), {
                align: "right",
                className: "tabular-nums",
              }),
              column(rootF("columns.status"), text(item("statusLabel")), { className: "text-xs" }),
              column(
                rootF("columns.actions"),
                widgetCell("intercompany-unpaired-actions", { actions: item("actions") }),
              ),
            ],
          }),
        ]),
        when: f("hasUnpaired"),
      },
      {
        ...grid(TABLE_FRAME, [
          registeredListTable("intercompany_pairs", {
            variant: "app",
            rows: f("pairRows"),
            rowKey: item("id"),
            columns: [
              column(rootF("columns.pair"), link(item("kindLabel"), item("href")), {
                className: "font-medium",
              }),
              column(rootF("columns.seller"), link(item("sellerNumber"), item("sellerHref"))),
              column(rootF("columns.buyer"), link(item("buyerNumber"), item("buyerHref"))),
              column(rootF("columns.entities"), text(item("entities")), { className: MUTED }),
              column(rootF("columns.sellerAmount"), text(item("sellerAmount")), {
                align: "right",
                className: "tabular-nums",
              }),
              column(rootF("columns.buyerAmount"), text(item("buyerAmount")), {
                align: "right",
                className: "tabular-nums",
              }),
              column(
                rootF("columns.state"),
                badge(item("stateLabel"), { variant: item("stateVariant") }),
              ),
              column(rootF("columns.issues"), text(item("issues")), { className: "text-xs" }),
            ],
          }),
        ]),
        when: f("hasPairs"),
      },
      { ...widgetBlock("page-notice", { message: data.truncatedNote }), when: f("truncated") },
      widgetBlock("intercompany-pair-drawer", { drawer: data.pairDrawer }, f("pairDrawerOpen")),
      widgetBlock("intercompany-link-drawer", { drawer: data.linkDrawer }, f("linkDrawerOpen")),
    ],
  });
}
