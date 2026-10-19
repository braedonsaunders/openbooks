import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getLocale, getTranslations } from "next-intl/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { searchManufacturingGenealogySeeds, traceManufacturingGenealogy } from "@openbooks/engine/manufacturing/genealogy";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { timeCommandGrants } from "@/lib/time-workspace";
import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { ModuleView } from "@/components/viewspec/module-view";
import { formatDecimal } from "@/lib/money-format";
import { GenealogySeedPicker } from "./GenealogySeedPicker";
import { genealogySpec, type GenealogyData } from "./view";

export const dynamic = "force-dynamic";

const Kind = z.enum(["lot", "serial"]);
const Direction = z.enum(["forward", "backward"]);
const Id = uuidString();
const MaxDepth = z.coerce.number().int().min(1).max(32);

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function traceHref(kind: "lot" | "serial", id: string, direction: "forward" | "backward", maxDepth: number) {
  const params = new URLSearchParams({ kind, id, direction, maxDepth: String(maxDepth) });
  return `/manufacturing/genealogy?${params.toString()}`;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("manufacturing.read");
  await requirePermission("items.read");
  await requireFeatureEnabled(authz.user.orgId, "manufacturing");
  const [t, tMfg, tNav, locale, raw] = await Promise.all([
    getTranslations("manufacturing.genealogy"),
    getTranslations("manufacturing"),
    getTranslations("nav"),
    getLocale(),
    searchParams,
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
    edges: trace?.edges.map((edge) => ({
      ...edge,
      evidenceLabel: t(`basis.${edge.allocationBasis}`),
      issuedLabel: formatDecimal(locale, edge.componentQuantity, { maximumFractionDigits: 4 }),
      receivedLabel: formatDecimal(locale, edge.outputQuantity, { maximumFractionDigits: 4 }),
      orderHref: `/manufacturing/work-orders?record=${encodeURIComponent(edge.orderId)}`,
      componentLotHref: edge.componentLotId ? traceHref("lot", edge.componentLotId, "backward", maxDepth) : null,
      componentSerialHref: edge.componentSerialId ? traceHref("serial", edge.componentSerialId, "backward", maxDepth) : null,
      outputLotHref: edge.outputLotId ? traceHref("lot", edge.outputLotId, "forward", maxDepth) : null,
      outputSerialHref: edge.outputSerialId ? traceHref("serial", edge.outputSerialId, "forward", maxDepth) : null,
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
    ...([...productionTimeGrants.all, ...productionTimeGrants.own].some((permission) => can(authz, permission))
      ? [{ href: "/manufacturing/time", label: tNav("manufacturing-time") }]
      : []),
  ];

  return (
    <ListPageLayout
      header={<PageHeader title={t("title")} description={trace ? `${trace.seed.itemName} · ${trace.seed.label}` : undefined} actions={<ModuleHomeTabs tabs={tabs} />} />}
      className="space-y-4"
    >
      <GenealogySeedPicker
        kind={kind}
        id={id}
        direction={direction}
        maxDepth={maxDepth}
        initialSeeds={seeds}
      />
      {trace ? (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("association")}{trace.visibility === "authorized_entities" ? ` ${t("scoped")}` : ""}
          </p>
          {trace.truncated ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{t("truncated")}</p> : null}
        </>
      ) : null}
      <ModuleView spec={genealogySpec(data)} data={data} searchParams={raw} trusted />
    </ListPageLayout>
  );
}
