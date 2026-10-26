import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@openbooks/ui";
import { requirePermission, can } from "../../../lib/authz";
import { EntityListView } from "../../../components/entity-list-view";
import { SetupEntitySection } from "../admin/setup/[entity]/SetupEntitySection";
import { SETUP_ENTITY_BY_KEY } from "../../../lib/setup/registry";
import { ModuleHomeTabs } from "../../../components/module-home/ui";
import { StockControls } from "./StockControls";
import { LayerInquiry } from "./LayerInquiry";
import { BomWorkspace, NewBomButton, type BomAssembly } from "./BomWorkspace";
import { CountsList, NewCountButton } from "./counts/CountsList";
import { InventoryActionDrawer } from "./InventoryActionDrawer";
import { NewMovementButton } from "./NewMovementButton";
import { ReceiveAgainstPoDrawer, type ReceivablePurchaseOrder } from "./ReceiveAgainstPoDrawer";
import { ReverseLandedVoucherAction } from "./ReverseLandedVoucherAction";
import { INVENTORY_ACTION_PERMISSIONS } from "@openbooks/engine/inventory/contracts";
import type { StockCountSummary } from "@openbooks/engine/inventory/stock-count-queries";

type MovementPickers = {
  items: { id: string; code: string | null; name: string | null }[];
  stockLocations: { id: string; code: string | null }[];
  accounts: { id: string; number: string | null; name: string | null }[];
  subsidiaries: { id: string; name: string }[];
};

export interface InventoryWorkspaceData {
  view:
    "onhand" | "movements" | "counts" | "locations" | "bom" | "holds" | "consignment" | "cycles";
  sp: Record<string, string | string[] | undefined>;
  receiveLabel: string;
  tabs: { href: string; label: string; active: boolean }[];
  canManage: boolean;
  canPostMovement: boolean;
  canReceive: boolean;
  canPost: boolean;
  canReverse: boolean;
  canSetup: boolean;
  barcodeScanningEnabled: boolean;
  showMovementDrawer: boolean;
  showReceivePicker: boolean;
  movementHref: string;
  closeMovementHref: string;
  receiveHref: string;
  movementPickers: MovementPickers | null;
  receivablePos: ReceivablePurchaseOrder[] | null;
  counts: StockCountSummary[];
  totalCount: number;
  countPage: number;
  countPerPage: number;
  locations: { id: string; name: string | null }[];
  countSubsidiaries: { id: string; name: string | null }[];
  items: { id: string; code: string | null; name: string | null }[];
  stockLocations: { id: string; code: string | null; locationId: string }[];
  lots: { id: string; item_id: string; lot_number: string }[];
  itemsExcludedCount: number;
  bomAssemblies: BomAssembly[];
  bomItems: {
    id: string;
    code: string | null;
    name: string | null;
    kind: string;
  }[];
}

export function InventoryPageHeaderActions({
  workspace,
  newCountLabel,
  setupNewLabel,
}: {
  workspace: InventoryWorkspaceData;
  newCountLabel: string;
  setupNewLabel: string;
}) {
  const { view } = workspace;
  const action =
    view === "onhand" || view === "movements" ? (
      <>
        {workspace.canPostMovement ? <NewMovementButton href={workspace.movementHref} /> : null}
        {workspace.canReceive ? (
          <Button asChild variant="outline">
            <Link href={workspace.receiveHref}>
              <Plus size={15} /> {workspace.receiveLabel}
            </Link>
          </Button>
        ) : null}
        {workspace.canReverse ? <ReverseLandedVoucherAction /> : null}
      </>
    ) : view === "counts" ? (
      workspace.canPost ? (
        <NewCountButton label={newCountLabel} currentParams={workspace.sp} />
      ) : null
    ) : view === "locations" ? (
      workspace.canSetup ? (
        <Button asChild>
          <Link href="/inventory?inventoryView=locations&row=new">
            <Plus size={15} /> {setupNewLabel}
          </Link>
        </Button>
      ) : null
    ) : view === "bom" && workspace.canSetup ? (
      <NewBomButton label={setupNewLabel} />
    ) : null;

  return (
    <>
      {action}
      <ModuleHomeTabs tabs={workspace.tabs} />
    </>
  );
}

export async function InventoryWorkspace({ workspace }: { workspace: InventoryWorkspaceData }) {
  const authz = await requirePermission("items.read");
  return <InventoryWorkspaceBody authz={authz} workspace={workspace} />;
}

async function InventoryWorkspaceBody({
  authz,
  workspace,
}: {
  authz: Awaited<ReturnType<typeof requirePermission>>;
  workspace: InventoryWorkspaceData;
}) {
  const orgId = authz.user.orgId;
  const { view, sp } = workspace;
  const allowedActions = (
    Object.keys(INVENTORY_ACTION_PERMISSIONS) as (keyof typeof INVENTORY_ACTION_PERMISSIONS)[]
  ).filter((action) => can(authz, INVENTORY_ACTION_PERMISSIONS[action]));

  return (
    <>
      {view === "onhand" || view === "movements" ? (
        <EntityListView
          recordType={view === "onhand" ? "inventory_onhand" : "inventory_movement"}
          orgId={orgId}
          userId={authz.user.id}
          canManage={workspace.canManage}
          sp={sp}
          drawer={
            workspace.showMovementDrawer && workspace.movementPickers ? (
              <InventoryActionDrawer
                items={workspace.movementPickers.items}
                stockLocations={workspace.movementPickers.stockLocations}
                accounts={workspace.movementPickers.accounts}
                subsidiaries={workspace.movementPickers.subsidiaries}
                canManageTracking={workspace.canManage}
                allowedActions={allowedActions}
                closeHref={workspace.closeMovementHref}
              />
            ) : undefined
          }
        />
      ) : null}

      {view === "holds" || view === "consignment" || view === "cycles" ? (
        <StockControls
          key={view}
          view={view === "cycles" ? "cycle_due" : view}
          canManage={workspace.canManage}
          canPost={workspace.canPost}
          pickers={workspace.movementPickers ?? undefined}
        />
      ) : null}

      {workspace.showReceivePicker && workspace.receivablePos ? (
        <ReceiveAgainstPoDrawer
          orders={workspace.receivablePos}
          closeHref={workspace.closeMovementHref}
        />
      ) : null}
      {pickString(sp.layerItem) ? (
        <LayerInquiry
          itemId={pickString(sp.layerItem)!}
          stockLocationId={pickString(sp.layerLocation)}
        />
      ) : null}

      {view === "counts" ? (
        <CountsList
          key={pickString(sp.countId) ?? (pickString(sp.count) === "new" ? "new" : "list")}
          counts={workspace.counts}
          totalCount={workspace.totalCount}
          page={workspace.countPage}
          perPage={workspace.countPerPage}
          locations={workspace.locations}
          subsidiaries={workspace.countSubsidiaries}
          items={workspace.items}
          stockLocations={workspace.stockLocations}
          lots={workspace.lots}
          canPost={workspace.canPost}
          canManageStockLocations={workspace.canSetup}
          canManageItems={workspace.canManage}
          barcodeScanningEnabled={workspace.barcodeScanningEnabled}
          itemsExcludedCount={workspace.itemsExcludedCount}
          createRequested={pickString(sp.count) === "new"}
          selectedCountId={pickString(sp.countId)}
          currentParams={sp}
        />
      ) : null}

      {view === "locations" ? (
        <SetupEntitySection
          entity={SETUP_ENTITY_BY_KEY.get("stock-locations")!}
          orgId={orgId}
          searchParams={sp}
          basePath="/inventory"
          canManage={workspace.canSetup}
          canViewDetails
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
          hideHeader
        />
      ) : null}

      {view === "bom" ? (
        <BomWorkspace
          key={pickString(sp.bom) ?? "list"}
          assemblies={workspace.bomAssemblies}
          items={workspace.bomItems}
          selected={pickString(sp.bom)}
          canManage={workspace.canSetup}
        />
      ) : null}
    </>
  );
}

function pickString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
