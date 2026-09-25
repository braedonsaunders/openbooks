"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Card, CardContent, cn } from "@openbooks/ui";
import type { FormLayoutConfig, ListViewConfig } from "@openbooks/customization";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import { decimalCmp } from "../../../lib/statement-format";
import { readApiErrorMessage } from "../../../lib/api-error";
import { Metric, formatGroupedMoney, sumByCurrency, type Option } from "./workspace-ui";
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
type LeaseCreateContext = { propertyId: string; unitId?: string | null };
type CamCreateContext = { propertyId?: string; poolId?: string };
type ActionPayload = Record<string, unknown>;
const mainTabs: Array<{ key: Tab }> = [
  { key: "properties" },
  { key: "rentRoll" },
  { key: "cam" },
  { key: "depositReconciliation" },
];
const empty: PropertyWorkspace = {
  properties: [],
  units: [],
  leases: [],
  charges: [],
  escalations: [],
  schedules: [],
  scheduleTotal: 0,
  schedulesTruncated: false,
  scheduleCountsByLease: [],
  overdueAsOf: "",
  overdueTotal: "0",
  overdueByLease: [],
  overdueInvoices: [],
  deposits: [],
  camPools: [],
  camAllocations: [],
};

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
}) {
  const { money } = useMoney();
  const t = useTranslations("entities.propertyManagement.workspace");
  const tCommon = useTranslations("common");
  const [data, setData] = useState<PropertyWorkspace>(empty);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. The loading reset lives
  // with the triggers (the mount initializer above, and the mutation reload)
  // instead of a mount effect.
  const load = useCallback(() => {
    return fetch("/api/property-management", {
      cache: "no-store",
    })
      .then(async (response) => {
        // The status is checked before the body parses: a non-JSON 502 page
        // must name the translated failure, and a refusal without a body
        // must never become new Error(undefined) with an empty toast.
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("toasts.couldNotLoad")));
        setData(await response.json());
        // A later success clears the failure: the panel below only stands
        // for the current load, never a recovered one.
        setLoadError(null);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error && error.message ? error.message : t("toasts.couldNotLoad");
        toast.error(message);
        // Remember the failure beside the toast: an initial load that never
        // delivered must render as a failure, never a healthy zero
        // portfolio. (A refetch over already-loaded data keeps rendering
        // that data; the toast carries the failure there.)
        setLoadError(message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
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
      setLoading(true);
      await load();
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

  const activeLeases = data.leases.filter((lease) =>
    ["active", "notice"].includes(lease.status),
  );
  const today = useBusinessToday();
  const occupied = data.units.filter(
    (unit) => unit.status === "occupied",
  ).length;
  // Portfolio money is grouped by currency, never summed across it: each
  // lease carries its property's currency, so the metric is one exact total
  // per currency (CamTable's per-pool formatting, portfolio-wide).
  const monthlyRent = sumByCurrency(
    activeLeases.flatMap((lease) =>
      data.charges
        .filter(
          (charge) =>
            charge.leaseId === lease.id &&
            charge.chargeType === "base_rent" &&
            charge.effectiveFrom <= today &&
            (!charge.effectiveTo || charge.effectiveTo >= today),
        )
        .map((charge) => ({ currency: lease.currency, amount: charge.amount })),
    ),
  );
  // Past-due money stays a server-side aggregate over the complete set of
  // posted documents — never the capped schedule preview, which drops older
  // lines once the portfolio passes the preview limit — grouped here by the
  // invoiced lease's currency instead of summed across currencies.
  const leaseCurrency = new Map(data.leases.map((lease) => [lease.id, lease.currency]));
  const overdue = sumByCurrency(
    data.overdueByLease.map((row) => ({
      currency: leaseCurrency.get(row.leaseId) ?? "",
      amount: row.balance,
    })),
  );
  const depositsHeld = sumByCurrency(
    data.leases.map((lease) => ({ currency: lease.currency, amount: lease.depositBalance ?? "0" })),
  );
  const selectedLease =
    data.leases.find((lease) => lease.id === selectedLeaseId) ?? null;
  const selectedProperty =
    data.properties.find((property) => property.id === selectedPropertyId) ??
    null;
  const selectedUnit =
    data.units.find((unit) => unit.id === selectedUnitId) ?? null;

  // An initial load that never delivered renders as the failure it was —
  // with a retry — never as a healthy zero portfolio. Stale-but-loaded data
  // keeps rendering under the failure toast instead (see load() above).
  const hasWorkspace =
    data.properties.length > 0 || data.units.length > 0 || data.leases.length > 0;
  if (!loading && loadError && !hasWorkspace) {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-red-300 bg-red-50 p-6 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        <p className="font-medium">{loadError}</p>
        <Button
          variant="outline"
          onClick={() => {
            setLoadError(null);
            setLoading(true);
            void load();
          }}
        >
          {tCommon("actions.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section
        aria-label={t("healthAria")}
        className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Metric
          label={t("metrics.occupiedUnits")}
          value={`${occupied} / ${data.units.length}`}
          hint={t("metrics.activeLeasesHint", { count: activeLeases.length })}
          icon="building"
          accent="teal"
        />
        <Metric
          label={t("metrics.monthlyBaseRent")}
          value={monthlyRent.length ? formatGroupedMoney(monthlyRent, money) : money("0")}
          hint={t("metrics.currentChargesHint")}
          icon="badge-dollar"
          accent="emerald"
        />
        <Metric
          label={t("metrics.rentPastDue")}
          value={overdue.length ? formatGroupedMoney(overdue, money) : money("0")}
          hint={t("metrics.agingHint")}
          tone={overdue.some((part) => decimalCmp(part.total, "0") > 0) ? "danger" : undefined}
          icon="circle-alert"
          accent="red"
        />
        <Metric
          label={t("metrics.depositsHeld")}
          value={depositsHeld.length ? formatGroupedMoney(depositsHeld, money) : money("0")}
          hint={t("metrics.depositLiabilityHint")}
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
              aria-label={t("sectionsAria")}
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
                  {t(`tabs.${item.key}`)}
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap gap-2 py-3 sm:justify-end">
              {tab === "properties" && permissions.manage ? (
                <Button onClick={() => setCreateProperty(true)}>
                  {t("newProperty")}
                </Button>
              ) : null}
              {tab === "cam" && permissions.manage ? (
                <Button onClick={() => setCreateCam({})}>{t("newCamPool")}</Button>
              ) : null}
              {tab === "rentRoll" && permissions.bill && permissions.bulk ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "assessLateFees" },
                        t("toasts.lateFeesAssessed"),
                      )
                    }
                  >
                    {t("assessLateFees")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act({ action: "billRent" }, t("toasts.rentBilled"))
                    }
                  >
                    {t("billDueRent")}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          {loading ? (
            <div className="p-12 text-center text-sm text-slate-500">
              {t("loading")}
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
              onEdit={(pool: CamPool) =>
                setCreateCam({ propertyId: pool.propertyId, poolId: pool.id })
              }
              onReopen={(pool: CamPool) => setReopenCamPoolId(pool.id)}
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
        fieldDefs={customization.fieldDefs}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createProperty", ...payload },
            t("toasts.propertyCreated"),
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
        onEditCam={(pool: CamPool) =>
          setCreateCam({ propertyId: pool.propertyId, poolId: pool.id })
        }
        onReopenCam={(pool: CamPool) => setReopenCamPoolId(pool.id)}
        onSave={(payload: ActionPayload) =>
          act({ action: "updateProperty", ...payload }, t("toasts.propertyUpdated"))
        }
        onDelete={async () => {
          if (!selectedProperty) return null;
          const result = await act(
            { action: "deleteProperty", propertyId: selectedProperty.id },
            t("toasts.propertyDeleted"),
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
            t("toasts.unitAdded"),
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
          act({ action: "updateUnit", ...payload }, t("toasts.unitUpdated"))
        }
        onDelete={async () => {
          if (!selectedUnit) return null;
          const result = await act(
            { action: "deleteUnit", unitId: selectedUnit.id },
            t("toasts.unitDeleted"),
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
            t("toasts.leaseCreated"),
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
            createCam?.poolId ? t("toasts.camPoolUpdated") : t("toasts.camPoolCreated"),
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
            t("toasts.camPoolReopened"),
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
          act({ action: "updateLease", ...payload }, t("toasts.leaseUpdated"))
        }
      />
    </div>
  );
}
