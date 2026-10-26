import "server-only";

import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import { listStockCounts } from "@openbooks/engine/inventory/stock-count-queries";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { isFeatureEnabled } from "../../../lib/features";
import { parseListParams, pickString } from "../../../lib/list-params";
import type { BomAssembly } from "./BomWorkspace";
import { listReceivablePurchaseOrders } from "../../../lib/receivable-purchase-orders";
import type { InventoryWorkspaceData } from "./InventoryWorkspace";
import { canPostInventoryMovement } from "./movement-permissions";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import type { InventoryPageData } from "./view";

type InventoryView =
  "onhand" | "movements" | "counts" | "locations" | "bom" | "holds" | "consignment" | "cycles";

function selectedView(sp: Record<string, string | string[] | undefined>): InventoryView {
  const candidate = pickString(sp.inventoryView) ?? pickString(sp.view);
  return candidate === "movements" ||
    candidate === "counts" ||
    candidate === "locations" ||
    candidate === "bom" ||
    candidate === "holds" ||
    candidate === "consignment" ||
    candidate === "cycles"
    ? candidate
    : "onhand";
}

export async function loadInventory(
  sp: Record<string, string | string[] | undefined>,
): Promise<InventoryPageData> {
  const [t, tSetup] = await Promise.all([
    getTranslations("inventory"),
    getTranslations("admin.setup"),
  ]);
  const authz = await requirePermission("items.read");
  await requireFeatureEnabled(authz.user.orgId, "inventory");
  const barcodeScanningEnabled = await isFeatureEnabled(authz.user.orgId, "barcodeScanning");

  const orgId = authz.user.orgId;
  const consignmentOn = await isFeatureEnabled(orgId, "consignment");
  const requestedView = selectedView(sp);
  const canManage = can(authz, "items.manage");
  const canPostMovement = canPostInventoryMovement(authz);
  // Standalone goods-receipt entry: receiving through the native receive
  // path takes the receiving grant on top of items.post — the same
  // authority the receive route enforces.
  const canReceive = can(authz, "goods_receipts.create") && can(authz, "items.post");
  const showReceivePicker = pickString(sp.receive) === "new" && canReceive;
  const canPost = can(authz, "items.post");
  const canReverse = can(authz, "items.reverse");
  const canSetup = can(authz, "admin.setup.manage");
  const view = requestedView;
  if (view === "consignment") await requireFeatureEnabled(orgId, "consignment");
  const showMovementDrawer = pickString(sp.movement) === "new" && canPostMovement;

  const tabs = [
    {
      href: "/inventory?inventoryView=onhand",
      label: t("view.onhand"),
      active: view === "onhand",
    },
    {
      href: "/inventory?inventoryView=movements",
      label: t("view.movements"),
      active: view === "movements",
    },
    {
      href: "/inventory?inventoryView=counts",
      label: t("view.counts"),
      active: view === "counts",
    },
    {
      href: "/inventory?inventoryView=holds",
      label: t("controls.holds"),
      active: view === "holds",
    },
    {
      href: "/inventory?inventoryView=cycles",
      label: t("controls.cycles"),
      active: view === "cycles",
    },
    ...(consignmentOn
      ? [
          {
            href: "/inventory?inventoryView=consignment",
            label: t("controls.consignment"),
            active: view === "consignment",
          },
        ]
      : []),
    {
      href: "/inventory?inventoryView=locations",
      label: t("view.locations"),
      active: view === "locations",
    },
    {
      href: "/inventory?inventoryView=bom",
      label: t("view.bom"),
      active: view === "bom",
    },
  ];

  const movementPickers =
    showMovementDrawer || (view === "consignment" && canPost)
      ? await Promise.all([
          db.execute<{
            id: string;
            code: string | null;
            name: string | null;
          }>(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active order by it.name`),
          db.execute<{ id: string; code: string | null }>(sql`
          select id, code from stock_locations where org_id = ${orgId} and is_active order by code`),
          db.execute<{
            id: string;
            number: string | null;
            name: string | null;
          }>(sql`
          select id, number, name from accounts
           where org_id = ${orgId} and is_active and not is_summary
           order by number nulls last`),
          db.execute<{ id: string; name: string }>(sql`
          select s.id, s.name from subsidiaries s
           where s.org_id = ${orgId} and s.is_active and not s.is_elimination
             ${subsidiaryVisibleFilter(sql`s.id`, authz.allowedSubsidiaryIds)}
           order by s.name`),
        ])
      : null;

  // Offer the same stocked, non-direct-shipment orders as the receipt flow.
  const receivablePos = showReceivePicker
    ? await listReceivablePurchaseOrders(orgId, authz.allowedSubsidiaryIds)
    : null;

  const countParams = parseListParams(sp, {
    sort: "date",
    dir: "desc",
    perPage: 25,
    allowedSorts: ["date"] as const,
  });
  const countData =
    view === "counts"
      ? await Promise.all([
          // The shared list query scopes subsidiaries server-side, exactly as
          // the counts API does — a restricted reader never receives another
          // entity's counts to filter client-side.
          listStockCounts(orgId, {
            subsidiaryIds: authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null,
            page: countParams.page,
            limit: countParams.perPage,
            search: countParams.q,
          }),
          db.execute<{ id: string; name: string | null }>(sql`
          select id, name from locations where org_id = ${orgId} and is_active order by name`),
          db.execute<{ id: string; name: string | null }>(sql`
          select id, name from subsidiaries where org_id = ${orgId} order by created_at, id`),
          db.execute<{
            id: string;
            code: string | null;
            name: string | null;
          }>(sql`
          select it.id, it.code, it.name from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active order by it.name`),
          db.execute<{
            id: string;
            code: string | null;
            locationId: string;
          }>(sql`
          select id, code, location_id as "locationId" from stock_locations where org_id = ${orgId} and is_active order by code`),
          db.execute<{ id: string; item_id: string; lot_number: string }>(sql`
          select id, item_id, lot_number from lots where org_id = ${orgId} order by lot_number`),
          // Active items the count picker cannot offer: without an Item
          // Costing profile they are excluded from every item list on this
          // page, so the picker names the prerequisite instead of "No matches".
          db.execute<{ excluded: number }>(sql`
          select count(*)::int as "excluded" from items it
           where it.org_id = ${orgId} and it.is_active
             and not exists (
               select 1 from item_inventory_profiles p
                where p.item_id = it.id and p.org_id = it.org_id
             )`),
        ])
      : null;

  const bomData =
    view === "bom"
      ? await Promise.all([
          db.execute<BomAssembly>(sql`
          select b.assembly_item_id as "assemblyItemId",
                 assembly.code as "assemblyCode",
                 assembly.name as "assemblyName",
                 count(*)::int as "componentCount",
                 md5(string_agg(
                   b.id::text || ':' || b.updated_at::text || ':' || b.component_item_id::text || ':' ||
                   b.quantity_per::text || ':' || b.sort_order::text,
                   ',' order by b.sort_order, b.component_item_id
                 )) as version,
                 json_agg(json_build_object(
                   'id', b.id,
                   'componentItemId', b.component_item_id,
                   'quantityPer', b.quantity_per::text,
                   'sortOrder', b.sort_order
                 ) order by b.sort_order, b.component_item_id) as components
            from bom_components b
            join items assembly on assembly.org_id = b.org_id and assembly.id = b.assembly_item_id
           where b.org_id = ${orgId}
           group by b.assembly_item_id, assembly.code, assembly.name
           order by assembly.name nulls last, assembly.code nulls last, b.assembly_item_id`),
          db.execute<{
            id: string;
            code: string | null;
            name: string | null;
            kind: string;
          }>(sql`
          select it.id, it.code, it.name, it.kind from items it
            join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
           where it.org_id = ${orgId} and it.is_active
           order by it.name nulls last, it.code nulls last, it.id`),
        ])
      : null;

  const movementHref = `/inventory?inventoryView=${view}&movement=new`;
  const closeMovementHref = `/inventory?inventoryView=${view}`;
  const receiveHref = `/inventory?inventoryView=${view}&receive=new`;
  const workspace: InventoryWorkspaceData = {
    view,
    sp,
    tabs,
    receiveLabel: t("receive.action"),
    canManage,
    canPostMovement,
    canReceive,
    canPost,
    canReverse,
    canSetup,
    barcodeScanningEnabled,
    showMovementDrawer,
    showReceivePicker,
    movementHref,
    closeMovementHref,
    receiveHref,
    movementPickers: movementPickers
      ? {
          items: movementPickers[0].rows,
          stockLocations: movementPickers[1].rows,
          accounts: movementPickers[2].rows,
          subsidiaries: movementPickers[3].rows,
        }
      : null,
    receivablePos: receivablePos?.rows ?? null,
    counts: countData?.[0].counts ?? [],
    totalCount: countData?.[0].totalCount ?? 0,
    countPage: countParams.page,
    countPerPage: countParams.perPage,
    locations: countData?.[1].rows ?? [],
    countSubsidiaries: (countData?.[2].rows ?? []).filter(
      (subsidiary) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(subsidiary.id),
    ),
    items: countData?.[3].rows ?? [],
    stockLocations: countData?.[4].rows ?? [],
    lots: countData?.[5].rows ?? [],
    itemsExcludedCount: countData?.[6].rows[0]?.excluded ?? 0,
    bomAssemblies: bomData?.[0].rows ?? [],
    bomItems: bomData?.[1].rows ?? [],
  };
  const data: InventoryPageData = {
    title: t("list.title"),
    description: t("list.description"),
    newCountLabel: t("counts.newButton"),
    setupNewLabel: tSetup("new"),
    workspace,
  };
  return data;
}
