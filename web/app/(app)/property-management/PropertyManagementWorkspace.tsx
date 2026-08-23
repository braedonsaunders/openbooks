"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardContent, cn } from "@openbooks/ui";
import type { FormLayoutConfig, ListViewConfig } from "@openbooks/customization";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import { Metric, type Option } from "./workspace-ui";
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

type Workspace = {
  properties: any[];
  units: any[];
  leases: any[];
  charges: any[];
  escalations: any[];
  schedules: any[];
  deposits: any[];
  camPools: any[];
  camAllocations: any[];
};
type Tab = "properties" | "rentRoll" | "cam" | "depositReconciliation";
type LeaseTab = "overview" | "charges" | "escalations" | "deposits";
type LeaseCreateContext = { propertyId: string; unitId?: string | null };
type CamCreateContext = { propertyId?: string; poolId?: string };
type ActionPayload = Record<string, unknown>;
const mainTabs: Array<{ key: Tab; label: string }> = [
  { key: "properties", label: "Properties" },
  { key: "rentRoll", label: "Rent Roll" },
  { key: "cam", label: "CAM" },
  { key: "depositReconciliation", label: "Deposit Reconciliation" },
];
const empty: Workspace = {
  properties: [],
  units: [],
  leases: [],
  charges: [],
  escalations: [],
  schedules: [],
  deposits: [],
  camPools: [],
  camAllocations: [],
};

async function api(payload: Record<string, unknown>) {
  const response = await fetch("/api/property-management", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Property action failed");
  return body;
}

export function PropertyManagementWorkspace({
  options,
  permissions,
  customization,
  fixedAssetsEnabled = false,
  multiCurrency = false,
}: {
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
}) {
  const { money } = useMoney();
  const [data, setData] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("properties");
  const [createProperty, setCreateProperty] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(
    null,
  );
  const [unitPropertyId, setUnitPropertyId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [createLease, setCreateLease] = useState<LeaseCreateContext | null>(
    null,
  );
  const [selectedLeaseId, setSelectedLeaseId] = useState<string | null>(null);
  const [createCam, setCreateCam] = useState<CamCreateContext | null>(null);
  const [reopenCamPoolId, setReopenCamPoolId] = useState<string | null>(null);
  const [propertyInitialTab, setPropertyInitialTab] = useState("overview");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/property-management", {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setData(body);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not load properties",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (payload: Record<string, unknown>, success: string) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await api(payload);
      toast.success(success);
      await load();
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const activeLeases = data.leases.filter((lease) =>
    ["active", "notice"].includes(lease.status),
  );
  const today = useBusinessToday();
  const occupied = data.units.filter(
    (unit) => unit.status === "occupied",
  ).length;
  const monthlyRent = activeLeases.reduce(
    (total, lease) =>
      total +
      data.charges
        .filter(
          (charge) =>
            charge.leaseId === lease.id &&
            charge.chargeType === "base_rent" &&
            charge.effectiveFrom <= today &&
            (!charge.effectiveTo || charge.effectiveTo >= today),
        )
        .reduce((n, charge) => n + Number(charge.amount), 0),
    0,
  );
  // One rent invoice can contain several schedule lines. Age the native posted
  // document's remaining balance once, rather than summing its original lines.
  const overdueInvoices = new Map<string, number>();
  for (const line of data.schedules) {
    if (
      line.invoiceDocumentId &&
      line.invoiceStatus === "posted" &&
      line.invoiceDueOn &&
      line.invoiceDueOn < today
    ) {
      overdueInvoices.set(
        line.invoiceDocumentId,
        Number(line.invoiceOpenBalance ?? 0),
      );
    }
  }
  const overdue = [...overdueInvoices.values()].reduce(
    (total, amount) => total + amount,
    0,
  );
  const depositsHeld = data.leases.reduce(
    (n, lease) => n + Number(lease.depositBalance ?? 0),
    0,
  );
  const selectedLease =
    data.leases.find((lease) => lease.id === selectedLeaseId) ?? null;
  const selectedProperty =
    data.properties.find((property) => property.id === selectedPropertyId) ??
    null;
  const selectedUnit =
    data.units.find((unit) => unit.id === selectedUnitId) ?? null;

  return (
    <div className="space-y-4">
      <section
        aria-label="Property health"
        className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Metric
          label="Occupied units"
          value={`${occupied} / ${data.units.length}`}
          hint={`${activeLeases.length} active leases`}
          icon="building"
          accent="teal"
        />
        <Metric
          label="Monthly base rent"
          value={money(monthlyRent)}
          hint="Current active charges"
          icon="badge-dollar"
          accent="emerald"
        />
        <Metric
          label="Rent billed past due"
          value={money(overdue)}
          hint="Invoice schedule aging"
          tone={overdue > 0 ? "danger" : undefined}
          icon="circle-alert"
          accent="red"
        />
        <Metric
          label="Security deposits held"
          value={money(depositsHeld)}
          hint="Tenant deposit liability"
          icon="shield-check"
          accent="violet"
        />
      </section>

      <Card className="min-w-0 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col items-stretch justify-between gap-3 border-b border-slate-200 px-4 sm:flex-row sm:items-center dark:border-slate-800">
            <nav
              className="-mb-px flex min-w-0 gap-1 overflow-x-auto"
              role="tablist"
              aria-label="Property management sections"
            >
              {mainTabs.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  role="tab"
                  aria-selected={tab === item.key}
                  onClick={() => setTab(item.key)}
                  className={cn(
                    "border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                    tab === item.key
                      ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
                      : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap gap-2 py-3 sm:justify-end">
              {tab === "properties" && permissions.manage ? (
                <Button onClick={() => setCreateProperty(true)}>
                  New property
                </Button>
              ) : null}
              {tab === "cam" && permissions.manage ? (
                <Button onClick={() => setCreateCam({})}>New CAM pool</Button>
              ) : null}
              {tab === "rentRoll" && permissions.bill && permissions.bulk ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "assessLateFees" },
                        "Portfolio late fees assessed",
                      )
                    }
                  >
                    Assess late fees
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act({ action: "billRent" }, "Portfolio rent billed")
                    }
                  >
                    Bill due rent
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          {loading ? (
            <div className="p-12 text-center text-sm text-slate-500">
              Loading property portfolio…
            </div>
          ) : tab === "properties" ? (
            <PropertiesTable
              data={data}
              view={customization.listView}
              fieldDefs={customization.fieldDefs}
              onOpen={setSelectedPropertyId}
            />
          ) : tab === "rentRoll" ? (
            <RentRollTable
              data={data}
              money={money}
              onOpenUnit={(unitId: string) => {
                const unit = data.units.find((row) => row.id === unitId);
                if (!unit) return;
                setSelectedPropertyId(unit.propertyId);
                setSelectedUnitId(unit.id);
              }}
              onOpenLease={(leaseId: string) => {
                const lease = data.leases.find((row) => row.id === leaseId);
                if (!lease) return;
                setSelectedPropertyId(lease.propertyId);
                setSelectedLeaseId(lease.id);
              }}
            />
          ) : tab === "cam" ? (
            <CamTable
              data={data}
              money={money}
              busy={busy}
              permissions={permissions}
              act={act}
              onEdit={(pool: any) =>
                setCreateCam({ propertyId: pool.propertyId, poolId: pool.id })
              }
              onReopen={(pool: any) => setReopenCamPoolId(pool.id)}
            />
          ) : (
            <DepositReconciliationWorkspace
              money={money}
              onOpenProperty={(propertyId: string) => {
                setPropertyInitialTab("deposits");
                setSelectedPropertyId(propertyId);
              }}
            />
          )}
        </CardContent>
      </Card>

      <PropertyDrawer
        open={createProperty}
        onClose={() => setCreateProperty(false)}
        options={options}
        busy={busy}
        fixedAssetsEnabled={fixedAssetsEnabled}
        multiCurrency={multiCurrency}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createProperty", ...payload },
            "Property created",
          );
          if (result) setCreateProperty(false);
        }}
      />
      <PropertyDetailDrawer
        key={`${selectedProperty?.id ?? "property-detail"}:${propertyInitialTab}`}
        property={selectedProperty}
        units={data.units.filter(
          (unit) => unit.propertyId === selectedProperty?.id,
        )}
        leases={data.leases.filter(
          (lease) => lease.propertyId === selectedProperty?.id,
        )}
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
        onClose={() => {
          setSelectedLeaseId(null);
          setSelectedUnitId(null);
          setSelectedPropertyId(null);
          setPropertyInitialTab("overview");
        }}
        onAddUnit={() =>
          selectedProperty && setUnitPropertyId(selectedProperty.id)
        }
        onOpenUnit={(unitId: string) => setSelectedUnitId(unitId)}
        onAddLease={(unitId?: string | null) =>
          selectedProperty &&
          setCreateLease({ propertyId: selectedProperty.id, unitId })
        }
        onAddCam={() =>
          selectedProperty &&
          setCreateCam({ propertyId: selectedProperty.id })
        }
        onOpenLease={(leaseId: string) => {
          setSelectedLeaseId(leaseId);
        }}
        onEditCam={(pool: any) =>
          setCreateCam({ propertyId: pool.propertyId, poolId: pool.id })
        }
        onReopenCam={(pool: any) => setReopenCamPoolId(pool.id)}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateProperty", ...payload }, "Property updated")
        }
        onDelete={async () => {
          if (!selectedProperty) return null;
          const result = await act(
            { action: "deleteProperty", propertyId: selectedProperty.id },
            "Property deleted",
          );
          if (result) setSelectedPropertyId(null);
          return result;
        }}
      />
      <UnitDrawer
        propertyId={unitPropertyId}
        onClose={() => setUnitPropertyId(null)}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createUnit", ...payload },
            "Unit added",
          );
          if (result) setUnitPropertyId(null);
        }}
      />
      <UnitRecordDrawer
        key={selectedUnit?.id ?? "unit-detail"}
        unit={selectedUnit}
        property={selectedProperty}
        leases={data.leases.filter((lease) => lease.unitId === selectedUnit?.id)}
        permissions={permissions}
        busy={busy}
        onClose={() => setSelectedUnitId(null)}
        onOpenLease={setSelectedLeaseId}
        onAddLease={() =>
          selectedUnit &&
          setCreateLease({
            propertyId: selectedUnit.propertyId,
            unitId: selectedUnit.id,
          })
        }
        onSave={(payload: ActionPayload) =>
          act({ action: "updateUnit", ...payload }, "Unit updated")
        }
        onDelete={async () => {
          if (!selectedUnit) return null;
          const result = await act(
            { action: "deleteUnit", unitId: selectedUnit.id },
            "Unit deleted",
          );
          if (result) setSelectedUnitId(null);
          return result;
        }}
      />
      <LeaseDrawer
        open={!!createLease}
        stacked={!!selectedProperty || !!selectedUnit}
        initialPropertyId={createLease?.propertyId}
        initialUnitId={createLease?.unitId}
        onClose={() => setCreateLease(null)}
        data={data}
        tenants={options.tenants}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createLease", ...payload },
            "Lease created",
          );
          if (result?.id) {
            setCreateLease(null);
            setSelectedLeaseId(result.id);
          }
        }}
      />
      <CamDrawer
        open={!!createCam}
        stacked={!!selectedProperty}
        initialPropertyId={createCam?.propertyId}
        pool={data.camPools.find((pool) => pool.id === createCam?.poolId)}
        onClose={() => setCreateCam(null)}
        data={data}
        expenseAccounts={options.expenseAccounts}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            createCam?.poolId
              ? { action: "updateCamPool", poolId: createCam.poolId, ...payload }
              : { action: "createCamPool", ...payload },
            createCam?.poolId ? "CAM pool updated" : "CAM pool created",
          );
          if (result) setCreateCam(null);
        }}
      />
      <CamCorrectionDrawer
        open={!!reopenCamPoolId}
        stacked={!!selectedProperty}
        pool={data.camPools.find((pool) => pool.id === reopenCamPoolId)}
        busy={busy}
        onClose={() => setReopenCamPoolId(null)}
        onSave={async (reason: string) => {
          const result = await act(
            { action: "reopenCamPool", poolId: reopenCamPoolId, reason },
            "CAM pool reopened for correction",
          );
          if (result) setReopenCamPoolId(null);
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
        onClose={() => setSelectedLeaseId(null)}
        act={act}
        money={money}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateLease", ...payload }, "Lease updated")
        }
      />
    </div>
  );
}
