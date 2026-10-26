"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { FormLayoutConfig, ListViewConfig } from "@openbooks/customization";
import { useMoney } from "@/components/money-provider";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import { readApiErrorMessage } from "../../../lib/api-error";
import type { Option } from "./workspace-ui";
import { PropertiesTable } from "./PropertiesTable";
import { RentRollTable } from "./RentRollTable";
import { CamTable } from "./CamTable";
import { DepositReconciliationWorkspace } from "./DepositReconciliationWorkspace";
import { PropertyDrawer } from "./PropertyDrawer";
import { PropertyDetailDrawer } from "./PropertyDetailDrawer";
import { UnitDrawer } from "./UnitDrawer";
import { UnitRecordDrawer } from "./UnitRecordDrawer";
import { LeaseDrawer } from "./LeaseDrawer";
import { LeaseRecordDrawer } from "./LeaseRecordDrawer";
import { CamCorrectionDrawer, CamDrawer } from "./CamDrawers";
import type { CamPool, PropertyWorkspace } from "./types";

type Tab = "properties" | "rentRoll" | "cam" | "depositReconciliation";
type ActionPayload = Record<string, unknown>;
const TABS: readonly Tab[] = ["properties", "rentRoll", "cam", "depositReconciliation"];

async function api(payload: Record<string, unknown>, fallback: string) {
  const response = await fetch("/api/property-management", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // The status is checked before the body parses, and the translated
  // fallback (never a hard-coded English string) carries the status when
  // the server names no refusal.
  if (!response.ok) throw new Error(await readApiErrorMessage(response, fallback));
  return response.json().catch(() => ({}));
}

export function PropertyManagementWorkspace({
  workspace: data,
  options,
  permissions,
  customization,
  fixedAssetsEnabled = false,
  multiCurrency = false,
  initialTab,
}: {
  workspace: PropertyWorkspace;
  options: {
    subsidiaries: Option[];
    locations: Option[];
    tenants: Option[];
    incomeAccounts: Option[];
    expenseAccounts: Option[];
    liabilityAccounts: Option[];
    bankAccounts: Option[];
    assets: Option[];
    openInvoices: Option[];
    taxCodes: Option[];
  };
  permissions: {
    manage: boolean;
    bill: boolean;
    account: boolean;
    bulk: boolean;
    customize: boolean;
  };
  customization: {
    layout: FormLayoutConfig;
    forms: Array<{ id: string; name: string }>;
    currentFormId: string | null;
    fieldDefs: CustomFieldDefClient[];
    listView: ListViewConfig;
  };
  fixedAssetsEnabled?: boolean;
  multiCurrency?: boolean;
  initialTab: Tab;
}) {
  const { money } = useMoney();
  const t = useTranslations("entities.propertyManagement.workspace");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const query = searchParams.toString();
  const hrefFor = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const suffix = next.toString();
    return suffix ? `${pathname}?${suffix}` : pathname;
  };
  const setUrlState = (
    updates: Record<string, string | null>,
    history: "push" | "replace" = "push",
  ) => {
    const href = hrefFor(updates);
    if (history === "replace") window.history.replaceState(window.history.state, "", href);
    else window.history.pushState(window.history.state, "", href);
  };
  const tabParam = searchParams.get("tab");
  const tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : initialTab;
  const propertyParam = searchParams.get("property");
  const unitParam = searchParams.get("unit");
  const leaseParam = searchParams.get("lease");
  const camParam = searchParams.get("cam");
  const camAction = searchParams.get("camAction");
  const selectedUnitId = unitParam && unitParam !== "new" ? unitParam : null;
  const selectedLeaseId = leaseParam && leaseParam !== "new" ? leaseParam : null;
  const selectedUnit = data.units.find((unit) => unit.id === selectedUnitId) ?? null;
  const selectedLease = data.leases.find((lease) => lease.id === selectedLeaseId) ?? null;
  const selectedPool = data.camPools.find((pool) => pool.id === camParam) ?? null;
  const selectedPropertyId =
    propertyParam && propertyParam !== "new"
      ? propertyParam
      : (selectedUnit?.propertyId ?? selectedLease?.propertyId ?? null);
  const selectedProperty =
    data.properties.find((property) => property.id === selectedPropertyId) ?? null;
  const createProperty = propertyParam === "new" && permissions.manage;
  const unitPropertyId = unitParam === "new" && permissions.manage ? selectedPropertyId : null;
  const createLease = leaseParam === "new" && permissions.manage;
  const createCam =
    permissions.manage && (camParam === "new" || (!!selectedPool && camAction !== "reopen"));
  const camEditorPool = createCam && camParam !== "new" ? (selectedPool ?? undefined) : undefined;
  const camPropertyId =
    camParam === "new" ? (selectedPropertyId ?? undefined) : camEditorPool?.propertyId;
  const reopenCamPoolId =
    permissions.account && camAction === "reopen" && selectedPool ? selectedPool.id : null;
  const propertyInitialTab = searchParams.get("propertyTab") ?? "overview";
  const closePropertyHref = hrefFor({
    property: null,
    propertyTab: null,
    unit: null,
    lease: null,
    cam: null,
    camAction: null,
  });
  const closeUnitHref = hrefFor({ unit: null });
  const closeLeaseHref = hrefFor({ lease: null });
  const closeCamHref = hrefFor({ cam: null, camAction: null });
  const closePropertyCreate = () => setUrlState({ property: null }, "replace");
  const closeUnitCreate = () => setUrlState({ unit: null }, "replace");
  const closeLeaseDrawer = () => setUrlState({ lease: null }, "replace");
  const closeCamDrawer = () => setUrlState({ cam: null, camAction: null }, "replace");
  const openProperty = (id: string) =>
    setUrlState({
      property: id,
      propertyTab: "overview",
      unit: null,
      lease: null,
      cam: null,
      camAction: null,
    });
  const openUnit = (id: string) => {
    const unit = data.units.find((row) => row.id === id);
    if (!unit) return;
    setUrlState({ property: unit.propertyId, unit: id, lease: null, cam: null, camAction: null });
  };
  const openLease = (id: string) => {
    const lease = data.leases.find((row) => row.id === id);
    if (!lease) return;
    setUrlState({
      property: lease.propertyId,
      unit: lease.unitId ?? null,
      lease: id,
      cam: null,
      camAction: null,
    });
  };
  const addUnit = () =>
    selectedProperty && setUrlState({ unit: "new", lease: null, cam: null, camAction: null });
  const addLease = (unitId?: string | null) =>
    selectedProperty &&
    setUrlState({
      unit: unitId ?? null,
      lease: "new",
      cam: null,
      camAction: null,
    });
  const addCam = () => setUrlState({ cam: "new", camAction: null });
  const editCam = (pool: CamPool) => setUrlState({ cam: pool.id, camAction: null });
  const reopenCam = (pool: CamPool) => setUrlState({ cam: pool.id, camAction: "reopen" });
  const act = async (
    payload: Record<string, unknown>,
    success: string,
    onError?: (message: string) => void,
  ) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await api(payload, t("toasts.actionFailed"));
      toast.success(success);
      router.refresh();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toasts.actionFailed");
      toast.error(message);
      onError?.(message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      {tab === "properties" ? (
        <PropertiesTable
          data={data}
          view={customization.listView}
          fieldDefs={customization.fieldDefs}
          onOpen={openProperty}
        />
      ) : tab === "rentRoll" ? (
        <RentRollTable data={data} money={money} onOpenUnit={openUnit} onOpenLease={openLease} />
      ) : tab === "cam" ? (
        <CamTable
          data={data}
          money={money}
          busy={busy}
          permissions={permissions}
          act={act}
          onEdit={editCam}
          onReopen={reopenCam}
        />
      ) : (
        <DepositReconciliationWorkspace
          money={money}
          onOpenProperty={(propertyId: string) =>
            setUrlState({
              property: propertyId,
              propertyTab: "deposits",
              unit: null,
              lease: null,
              cam: null,
              camAction: null,
            })
          }
        />
      )}

      <PropertyDrawer
        open={createProperty}
        closeHref={closePropertyHref}
        onClose={closePropertyCreate}
        options={options}
        busy={busy}
        fixedAssetsEnabled={fixedAssetsEnabled}
        multiCurrency={multiCurrency}
        fieldDefs={customization.fieldDefs}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createProperty", ...payload },
            t("toasts.propertyCreated"),
          );
          if (result) closePropertyCreate();
        }}
      />
      <PropertyDetailDrawer
        key={`${selectedProperty?.id ?? "property-detail"}:${propertyInitialTab}`}
        property={selectedProperty}
        units={data.units.filter((unit) => unit.propertyId === selectedProperty?.id)}
        leases={data.leases.filter((lease) => lease.propertyId === selectedProperty?.id)}
        options={options}
        permissions={permissions}
        customization={customization}
        fixedAssetsEnabled={fixedAssetsEnabled}
        multiCurrency={multiCurrency}
        data={data}
        money={money}
        act={act}
        busy={busy}
        initialTab={propertyInitialTab}
        closeHref={closePropertyHref}
        onAddUnit={addUnit}
        onOpenUnit={openUnit}
        onAddLease={addLease}
        onAddCam={addCam}
        onOpenLease={openLease}
        onEditCam={editCam}
        onReopenCam={reopenCam}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateProperty", ...payload }, t("toasts.propertyUpdated"))
        }
        onDelete={async () => {
          if (!selectedProperty) return null;
          const result = await act(
            { action: "deleteProperty", propertyId: selectedProperty.id },
            t("toasts.propertyDeleted"),
          );
          if (result)
            setUrlState(
              {
                property: null,
                propertyTab: null,
                unit: null,
                lease: null,
                cam: null,
                camAction: null,
              },
              "replace",
            );
          return result;
        }}
      />
      <UnitDrawer
        propertyId={unitPropertyId}
        closeHref={closeUnitHref}
        onClose={closeUnitCreate}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act({ action: "createUnit", ...payload }, t("toasts.unitAdded"));
          if (result) closeUnitCreate();
        }}
      />
      <UnitRecordDrawer
        key={selectedUnit?.id ?? "unit-detail"}
        unit={selectedUnit}
        property={selectedProperty}
        leases={data.leases.filter((lease) => lease.unitId === selectedUnit?.id)}
        permissions={permissions}
        busy={busy}
        closeHref={closeUnitHref}
        onOpenLease={openLease}
        onAddLease={() => selectedUnit && addLease(selectedUnit.id)}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateUnit", ...payload }, t("toasts.unitUpdated"))
        }
        onDelete={async () => {
          if (!selectedUnit) return null;
          const result = await act(
            { action: "deleteUnit", unitId: selectedUnit.id },
            t("toasts.unitDeleted"),
          );
          if (result) closeUnitCreate();
          return result;
        }}
      />
      <LeaseDrawer
        open={createLease}
        closeHref={closeLeaseHref}
        stacked={!!selectedProperty || !!selectedUnit}
        initialPropertyId={selectedPropertyId ?? undefined}
        initialUnitId={selectedUnitId}
        onClose={closeLeaseDrawer}
        data={data}
        tenants={options.tenants}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act({ action: "createLease", ...payload }, t("toasts.leaseCreated"));
          if (result?.id) {
            setUrlState({ lease: result.id }, "replace");
          }
        }}
      />
      <CamDrawer
        open={createCam}
        closeHref={closeCamHref}
        stacked={!!selectedProperty}
        initialPropertyId={camPropertyId}
        pool={camEditorPool}
        onClose={closeCamDrawer}
        data={data}
        expenseAccounts={options.expenseAccounts}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            camEditorPool
              ? { action: "updateCamPool", poolId: camEditorPool.id, ...payload }
              : { action: "createCamPool", ...payload },
            camEditorPool ? t("toasts.camPoolUpdated") : t("toasts.camPoolCreated"),
          );
          if (result) closeCamDrawer();
        }}
      />
      <CamCorrectionDrawer
        open={!!reopenCamPoolId}
        closeHref={closeCamHref}
        stacked={!!selectedProperty}
        pool={data.camPools.find((pool) => pool.id === reopenCamPoolId)}
        busy={busy}
        onClose={closeCamDrawer}
        onSave={async (reason: string) => {
          const result = await act(
            { action: "reopenCamPool", poolId: reopenCamPoolId, reason },
            t("toasts.camPoolReopened"),
          );
          if (result) closeCamDrawer();
        }}
      />
      <LeaseRecordDrawer
        key={selectedLease?.id ?? "lease-detail"}
        lease={selectedLease}
        data={data}
        options={options}
        permissions={permissions}
        busy={busy}
        stacked={!!selectedProperty || !!selectedUnit}
        closeHref={closeLeaseHref}
        act={act}
        money={money}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateLease", ...payload }, t("toasts.leaseUpdated"))
        }
      />
    </div>
  );
}
