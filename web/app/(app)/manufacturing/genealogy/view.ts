import "server-only";

import { column, link, page, ref, text, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import {
  searchManufacturingGenealogySeeds,
  traceManufacturingGenealogy,
  type GenealogyEdge,
} from "@openbooks/engine/manufacturing/genealogy";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getLocale, getTranslations } from "next-intl/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { timeCommandGrants } from "@/lib/time-workspace";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { formatDecimal } from "@/lib/money-format";

export interface GenealogyRow extends GenealogyEdge {
  evidenceLabel: string;
  issuedLabel: string;
  receivedLabel: string;
  orderHref: string;
  componentLotHref: string | null;
  componentSerialHref: string | null;
  outputLotHref: string | null;
  outputSerialHref: string | null;
}

export interface GenealogyData {
  edges: GenealogyRow[];
  columns: {
    evidence: string;
    depth: string;
    order: string;
    component: string;
    componentLot: string;
    componentSerial: string;
    issued: string;
    output: string;
    outputLot: string;
    outputSerial: string;
    received: string;
  };
  emptyTitle: string;
  emptyDescription: string;
}

export interface GenealogyPageData extends GenealogyData {
  title: string;
  traceDescription: string | undefined;
  associationLabel: string;
  scopedLabel: string;
  truncatedLabel: string;
  kind: "lot" | "serial";
  id: string | undefined;
  direction: "forward" | "backward";
  maxDepth: number;
  initialSeeds: Awaited<ReturnType<typeof searchManufacturingGenealogySeeds>>;
  trace: Awaited<ReturnType<typeof traceManufacturingGenealogy>> | null;
  tabs: ModuleHomeTab[];
}

const Kind = z.enum(["lot", "serial"]);
const Direction = z.enum(["forward", "backward"]);
const Id = uuidString();
const MaxDepth = z.coerce.number().int().min(1).max(32);

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function traceHref(
  kind: "lot" | "serial",
  id: string,
  direction: "forward" | "backward",
  maxDepth: number,
) {
  const params = new URLSearchParams({ kind, id, direction, maxDepth: String(maxDepth) });
  return `/manufacturing/genealogy?${params.toString()}`;
}

export function loadManufacturingGenealogy(
  sp: Record<string, string | string[] | undefined>,
): Promise<GenealogyPageData> {
  return loadManufacturingGenealogyData(sp);
}

async function loadManufacturingGenealogyData(
  raw: Record<string, string | string[] | undefined>,
): Promise<GenealogyPageData> {
  const authz = await requirePermission("manufacturing.read");
  await requirePermission("items.read");
  await requireFeatureEnabled(authz.user.orgId, "manufacturing");
  const [t, tMfg, tNav, locale] = await Promise.all([
    getTranslations("manufacturing.genealogy"),
    getTranslations("manufacturing"),
    getTranslations("nav"),
    getLocale(),
  ]);
  const mrpEnabled = await manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp");
  const productionTimeGrants = timeCommandGrants("time.read");
  const parsedKind = Kind.safeParse(first(raw.kind));
  const kind = parsedKind.success ? parsedKind.data : "lot";
  const idValue = first(raw.id);
  const id = idValue && Id.safeParse(idValue).success ? idValue : undefined;
  const parsedDirection = Direction.safeParse(first(raw.direction));
  const direction = parsedDirection.success ? parsedDirection.data : "forward";
  const maxDepthValue = first(raw.maxDepth);
  const parsedDepth = maxDepthValue === undefined ? undefined : MaxDepth.safeParse(maxDepthValue);
  const maxDepth = parsedDepth?.success ? parsedDepth.data : 8;

  const { seeds, trace } = await withOrgTransaction(authz.user.orgId, async () => {
    const seeds = await searchManufacturingGenealogySeeds(
      db,
      authz.user.orgId,
      authz.user.id,
      { kind, selected: id },
      authz.allowedSubsidiaryIds,
    );
    const trace = id
      ? await traceManufacturingGenealogy(
          db,
          authz.user.orgId,
          authz.user.id,
          { kind, id, direction, maxDepth },
          authz.allowedSubsidiaryIds,
        )
      : null;
    return { seeds, trace };
  });

  const columns = {
    evidence: t("evidence"),
    depth: t("depth"),
    order: t("order"),
    component: t("component"),
    componentLot: `${t("component")} ${tMfg("lot")}`,
    componentSerial: `${t("component")} ${tMfg("serial")}`,
    issued: t("issued"),
    output: t("output"),
    outputLot: `${t("output")} ${tMfg("lot")}`,
    outputSerial: `${t("output")} ${tMfg("serial")}`,
    received: t("received"),
  };
  const data: GenealogyData = {
    edges:
      trace?.edges.map((edge) => ({
        ...edge,
        evidenceLabel: t(`basis.${edge.allocationBasis}`),
        issuedLabel: formatDecimal(locale, edge.componentQuantity, { maximumFractionDigits: 4 }),
        receivedLabel: formatDecimal(locale, edge.outputQuantity, { maximumFractionDigits: 4 }),
        orderHref: `/manufacturing/work-orders?record=${encodeURIComponent(edge.orderId)}`,
        componentLotHref: edge.componentLotId
          ? traceHref("lot", edge.componentLotId, "backward", maxDepth)
          : null,
        componentSerialHref: edge.componentSerialId
          ? traceHref("serial", edge.componentSerialId, "backward", maxDepth)
          : null,
        outputLotHref: edge.outputLotId
          ? traceHref("lot", edge.outputLotId, "forward", maxDepth)
          : null,
        outputSerialHref: edge.outputSerialId
          ? traceHref("serial", edge.outputSerialId, "forward", maxDepth)
          : null,
      })) ?? [],
    columns,
    emptyTitle: trace ? t("empty") : t("choose"),
    emptyDescription: trace ? t("emptyNote") : t("chooseNote"),
  };
  const tabs: ModuleHomeTab[] = [
    { href: "/manufacturing", label: tNav("manufacturing") },
    { href: "/manufacturing/work-orders", label: tNav("manufacturing-work-orders") },
    { href: "/manufacturing/work-centers", label: tNav("manufacturing-work-centers") },
    { href: "/manufacturing/routings", label: tNav("manufacturing-routings") },
    ...(mrpEnabled ? [{ href: "/manufacturing/mrp", label: tNav("manufacturing-mrp") }] : []),
    { href: "/manufacturing/quality", label: tNav("manufacturing-quality") },
    { href: "/manufacturing/genealogy", label: t("title"), active: true },
    ...([...productionTimeGrants.all, ...productionTimeGrants.own].some((permission) =>
      can(authz, permission),
    )
      ? [{ href: "/manufacturing/time", label: tNav("manufacturing-time") }]
      : []),
  ];
  return {
    ...data,
    title: t("title"),
    traceDescription: trace ? `${trace.seed.itemName} · ${trace.seed.label}` : undefined,
    associationLabel: t("association"),
    scopedLabel: t("scoped"),
    truncatedLabel: t("truncated"),
    kind,
    id,
    direction,
    maxDepth,
    initialSeeds: seeds,
    trace,
    tabs,
  };
}

const f = ref<GenealogyData>();
const row = ref<GenealogyRow>();

export function genealogySpec(_data: GenealogyData): PageSpec {
  return page({
    route: "/manufacturing/genealogy",
    layout: "bare",
    body: [
      registeredListTable("manufacturing_genealogy", {
        variant: "app",
        rows: f("edges"),
        rowKey: row("id"),
        empty: { title: f("emptyTitle"), description: f("emptyDescription") },
        columns: [
          column(f("columns.evidence"), text(row("evidenceLabel"))),
          column(f("columns.depth"), text(row("depth"))),
          column(f("columns.order"), link(row("orderNumber"), row("orderHref"))),
          column(f("columns.component"), text(row("componentItem"))),
          column(
            f("columns.componentLot"),
            link(row("componentLotNumber"), row("componentLotHref")),
          ),
          column(
            f("columns.componentSerial"),
            link(row("componentSerialNumber"), row("componentSerialHref")),
          ),
          column(f("columns.issued"), text(row("issuedLabel"))),
          column(f("columns.output"), text(row("outputItem"))),
          column(f("columns.outputLot"), link(row("outputLotNumber"), row("outputLotHref"))),
          column(
            f("columns.outputSerial"),
            link(row("outputSerialNumber"), row("outputSerialHref")),
          ),
          column(f("columns.received"), text(row("receivedLabel"))),
        ],
      }),
    ],
  });
}
