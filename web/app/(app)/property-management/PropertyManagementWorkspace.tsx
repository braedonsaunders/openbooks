"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  Input,
  Label,
  Popover,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@openbooks/ui";
import {
  defaultFormLayout,
  isCustomTabKey,
  resolveFormTabs,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type ListViewConfig,
} from "@openbooks/customization";
import { useMoney } from "@/components/money-provider";
import { CustomFieldInput } from "../../../components/custom-field-input";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import { HeaderFields } from "../../../components/transaction-form/header-fields";
import { HomeStatTile } from "../../../components/module-home/client";
import type { Accent } from "../../../components/cockpit/ui";

type Option = {
  id: string;
  name: string;
  currency?: string;
  partyId?: string;
  openBalance?: string;
};
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
  const today = new Date().toISOString().slice(0, 10);
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

function Metric({
  label,
  value,
  hint,
  tone,
  icon,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "danger";
  icon: string;
  accent: Accent;
}) {
  return (
    <HomeStatTile
      label={label}
      value={value}
      sub={hint}
      icon={icon}
      accent={accent}
      tone={tone === "danger" ? "negative" : "neutral"}
    />
  );
}
function Status({ value }: { value: string }) {
  const variant = ["active", "occupied", "invoiced", "finalized"].includes(
    value,
  )
    ? "success"
    : ["notice", "open", "scheduled"].includes(value)
      ? "warning"
      : "secondary";
  return <Badge variant={variant as any}>{value.replaceAll("_", " ")}</Badge>;
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="p-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-sm text-slate-500">{detail}</div>
    </div>
  );
}

function RecordTabs({
  label,
  active,
  tabs,
  onChange,
}: {
  label: string;
  active: string;
  tabs: Array<{ key: string; label: string }>;
  onChange: (key: string) => void;
}) {
  return (
    <nav
      className="-mb-px flex gap-1 overflow-x-auto"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          onClick={() => onChange(item.key)}
          className={cn(
            "border-b-2 px-3 py-3 text-sm font-medium transition-colors",
            active === item.key
              ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function PropertyDetailDrawer({
  property,
  units,
  leases,
  options,
  permissions,
  customization,
  data,
  money,
  act,
  busy,
  onClose,
  onAddUnit,
  onOpenUnit,
  onAddLease,
  onAddCam,
  onEditCam,
  onReopenCam,
  onOpenLease,
  onSave,
  onDelete,
  initialTab,
}: any) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [tab, setTab] = useState(initialTab ?? "overview");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [form, setForm] = useState(() =>
    propertyForm(property ?? {}, customization.fieldDefs),
  );
  const effectiveLayout: FormLayoutConfig =
    customization.layout ?? defaultFormLayout("property");
  const customByKey = useMemo(
    () =>
      new Map<string, CustomFieldDefClient>(
        customization.fieldDefs.map((def: CustomFieldDefClient) => [
          def.key,
          def,
        ]),
      ),
    [customization.fieldDefs],
  );
  const tabs = resolveFormTabs(effectiveLayout).filter((item) => item.visible);
  const customGroupIds = new Set(
    tabs
      .filter((item) => isCustomTabKey(item.key))
      .flatMap((item) => item.groupIds ?? []),
  );
  const overviewLayout: FormLayoutConfig = {
    ...effectiveLayout,
    header: {
      groups: effectiveLayout.header.groups.filter(
        (group: FormLayoutConfig["header"]["groups"][number]) =>
          !customGroupIds.has(group.id),
      ),
    },
  };
  if (!property) return null;

  const editable = mode === "edit" && permissions.manage;
  const reset = () => {
    setForm(propertyForm(property, customization.fieldDefs));
    setMode("view");
  };
  const optionName = (items: Option[], value: string) =>
    items.find((item) => item.id === value)?.name ?? "—";
  const labelFor = (placement: HeaderFieldPlacement, fallback: string) =>
    placement.labelOverride?.trim() || fallback;
  const requiredFor = (placement: HeaderFieldPlacement, required = false) =>
    required || placement.required === true;
  const field = (
    placement: HeaderFieldPlacement,
    label: string,
    content: React.ReactNode,
    required = false,
  ) => (
    <>
      <Label>
        {labelFor(placement, label)}
        {editable && requiredFor(placement, required) ? (
          <span className="text-red-500"> *</span>
        ) : null}
      </Label>
      {content}
    </>
  );
  const read = (value: unknown, className = "") => (
    <p className={cn("text-sm", className)}>
      {value == null || value === "" ? "—" : String(value)}
    </p>
  );
  const select = (
    value: string,
    onChange: (value: string) => void,
    items: Option[],
    empty = "Not mapped",
  ) =>
    editable ? (
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    ) : (
      read(optionName(items, value))
    );

  function renderPropertyField(placement: HeaderFieldPlacement) {
    const key = placement.key;
    if (key.startsWith("cf_")) {
      const def = customByKey.get(key.slice(3));
      if (!def) return null;
      return (
        <CustomFieldInput
          def={{
            ...def,
            label: labelFor(placement, def.label),
            isRequired: requiredFor(placement, def.isRequired),
          }}
          value={form.custom[def.key]}
          onChange={(value) =>
            setForm({ ...form, custom: { ...form.custom, [def.key]: value } })
          }
          readOnly={!editable}
        />
      );
    }
    switch (key) {
      case "name":
        return field(
          placement,
          "Name",
          editable ? (
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          ) : (
            read(form.name)
          ),
          true,
        );
      case "code":
        return field(
          placement,
          "Property code",
          editable ? (
            <Input
              className="font-mono"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          ) : (
            read(form.code, "font-mono")
          ),
          true,
        );
      case "property_type":
        return field(
          placement,
          "Property type",
          editable ? (
            <Select
              value={form.propertyType}
              onChange={(e) =>
                setForm({ ...form, propertyType: e.target.value })
              }
            >
              {[
                "residential",
                "commercial",
                "mixed_use",
                "industrial",
                "other",
              ].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          ) : (
            read(form.propertyType.replaceAll("_", " "), "capitalize")
          ),
          true,
        );
      case "status":
        return field(
          placement,
          "Status",
          editable ? (
            <Select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {["active", "inactive", "sold"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          ) : (
            <Status value={form.status} />
          ),
        );
      case "subsidiary_id":
        return field(
          placement,
          "Subsidiary",
          select(
            form.subsidiaryId,
            (value) => setForm({ ...form, subsidiaryId: value }),
            options.subsidiaries,
            "Select subsidiary",
          ),
          true,
        );
      case "location_id":
        return field(
          placement,
          "Location",
          select(
            form.locationId,
            (value) => setForm({ ...form, locationId: value }),
            options.locations,
          ),
        );
      case "fixed_asset_id":
        return field(
          placement,
          "Fixed asset",
          select(
            form.fixedAssetId,
            (value) => setForm({ ...form, fixedAssetId: value }),
            options.assets,
          ),
        );
      case "currency":
        return field(
          placement,
          "Currency",
          editable ? (
            <Input
              className="font-mono uppercase"
              maxLength={3}
              value={form.currency}
              onChange={(e) =>
                setForm({ ...form, currency: e.target.value.toUpperCase() })
              }
            />
          ) : (
            read(form.currency, "font-mono")
          ),
          true,
        );
      case "street":
        return field(
          placement,
          "Street",
          editable ? (
            <Input
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          ) : (
            read(form.street)
          ),
        );
      case "city":
        return field(
          placement,
          "City",
          editable ? (
            <Input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          ) : (
            read(form.city)
          ),
        );
      case "region":
        return field(
          placement,
          "State / province",
          editable ? (
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          ) : (
            read(form.region)
          ),
        );
      case "postal_code":
        return field(
          placement,
          "Postal code",
          editable ? (
            <Input
              value={form.postalCode}
              onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            />
          ) : (
            read(form.postalCode)
          ),
        );
      case "rent_income_account_id":
        return field(
          placement,
          "Rent income account",
          select(
            form.rentIncomeAccountId,
            (value) => setForm({ ...form, rentIncomeAccountId: value }),
            options.incomeAccounts,
          ),
        );
      case "cam_income_account_id":
        return field(
          placement,
          "CAM income account",
          select(
            form.camIncomeAccountId,
            (value) => setForm({ ...form, camIncomeAccountId: value }),
            options.incomeAccounts,
          ),
        );
      case "deposit_liability_account_id":
        return field(
          placement,
          "Deposit liability account",
          select(
            form.depositLiabilityAccountId,
            (value) => setForm({ ...form, depositLiabilityAccountId: value }),
            options.liabilityAccounts,
          ),
        );
      case "default_bank_account_id":
        return field(
          placement,
          "Default bank account",
          select(
            form.defaultBankAccountId,
            (value) => setForm({ ...form, defaultBankAccountId: value }),
            options.bankAccounts,
          ),
        );
      default:
        return null;
    }
  }

  const tabLabel = (item: { key: string; labelOverride?: string | null }) =>
    item.labelOverride?.trim() ||
    ({
      overview: "Overview",
      units: "Units",
      leases: "Leases",
      rent: "Rent",
      deposits: "Deposits",
      cam: "CAM",
    }[item.key] ??
      item.key.replace(/^tab_/, "").replaceAll("_", " "));
  const propertyPayload = (status = form.status) => ({
      propertyId: property.id,
      name: form.name,
      code: form.code,
      propertyType: form.propertyType,
      status,
      subsidiaryId: form.subsidiaryId,
      locationId: form.locationId || null,
      fixedAssetId: form.fixedAssetId || null,
      currency: form.currency,
      address: {
        street: form.street,
        city: form.city,
        region: form.region,
        postalCode: form.postalCode,
      },
      rentIncomeAccountId: form.rentIncomeAccountId || null,
      camIncomeAccountId: form.camIncomeAccountId || null,
      depositLiabilityAccountId: form.depositLiabilityAccountId || null,
      defaultBankAccountId: form.defaultBankAccountId || null,
      custom: form.custom,
  });
  const save = async () => {
    const result = await onSave(propertyPayload());
    if (result) setMode("view");
  };
  const changeStatus = async (status: string) => {
    const result = await onSave(propertyPayload(status));
    if (result) {
      setForm({ ...form, status });
      setActionsOpen(false);
    }
  };
  const selectForm = (formId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (formId) next.set("form", formId);
    else next.delete("form");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    setActionsOpen(false);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500">{form.code}</span>
          <span>{form.name}</span>
          <Status value={form.status} />
        </span>
      }
      description={`${property.subsidiaryName} · ${property.locationName || "No location"}`}
      subtabs={
        <RecordTabs
          label="Property details"
          active={tab}
          tabs={tabs.map((item) => ({ key: item.key, label: tabLabel(item) }))}
          onChange={setTab}
        />
      }
      headerActions={
        mode === "edit" ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !form.name.trim() || !form.code.trim()}
              onClick={save}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : permissions.manage || permissions.customize ? (
          <div className="flex items-center gap-1.5">
            {permissions.manage ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2.5 text-xs"
                onClick={() => setMode("edit")}
              >
                Edit
              </Button>
            ) : null}
            <Popover
              open={actionsOpen}
              onOpenChange={setActionsOpen}
              align="end"
              className="w-64 p-1.5"
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setActionsOpen((open) => !open)}
                >
                  Actions{" "}
                  <ChevronDown
                    className={cn("h-3.5 w-3.5", actionsOpen && "rotate-180")}
                  />
                </Button>
              }
            >
              {customization.forms.length ? (
                <div className="mb-1 border-b border-slate-200 p-2 dark:border-slate-800">
                  <Label className="mb-1 block text-xs">Custom form</Label>
                  <Select
                    value={customization.currentFormId ?? ""}
                    onChange={(e) => selectForm(e.target.value)}
                  >
                    {customization.forms.map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {permissions.customize ? (
                <Button
                  asChild
                  variant="ghost"
                  className="h-8 w-full justify-start rounded px-2 text-xs"
                >
                  <Link href="/admin/customization?recordType=property&tab=forms">
                    Customize form
                  </Link>
                </Button>
              ) : null}
              {permissions.manage ? (
                <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-800">
                  {form.status === "active" ? (
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start rounded px-2 text-xs"
                      disabled={busy}
                      onClick={() => changeStatus("inactive")}
                    >
                      Deactivate property
                    </Button>
                  ) : form.status === "inactive" ? (
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start rounded px-2 text-xs"
                      disabled={busy}
                      onClick={() => changeStatus("active")}
                    >
                      Reactivate property
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${property.name}? Only unused properties can be permanently deleted.`,
                        )
                      )
                        void onDelete();
                    }}
                  >
                    Delete property
                  </Button>
                </div>
              ) : null}
            </Popover>
          </div>
        ) : undefined
      }
    >
      {tab === "overview" ? (
        <div className="p-1">
          <HeaderFields
            layout={overviewLayout}
            editable={editable}
            renderField={renderPropertyField}
          />
        </div>
      ) : null}
      {tab === "units" ? (
        <div className="space-y-3 p-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Rentable units</h3>
              <p className="text-xs text-slate-500">
                Occupancy, rentable area, and unit-level lease capacity.
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={onAddUnit}>
                Add unit
              </Button>
            ) : null}
          </div>
          {units.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Rentable area</TableHead>
                  <TableHead className="text-right">Bedrooms</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((unit: any) => (
                  <TableRow
                    key={unit.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                    onClick={() => onOpenUnit(unit.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenUnit(unit.id);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="font-medium">{unit.code}</div>
                      <div className="text-xs text-slate-500">
                        {unit.name || "—"}
                      </div>
                    </TableCell>
                    <TableCell>{unit.unitType || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unit.rentableArea || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unit.bedrooms ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Status value={unit.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty
              title="No units yet"
              detail="Add the first rentable unit from this property record."
            />
          )}
        </div>
      ) : null}
      {tab === "leases" ? (
        <div className="space-y-3 p-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Property leases</h3>
              <p className="text-xs text-slate-500">
                Current and historical tenant agreements for this property.
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={() => onAddLease(null)}>
                New lease
              </Button>
            ) : null}
          </div>
          {leases.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lease</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leases.map((lease: any) => (
                  <TableRow
                    key={lease.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer"
                    onClick={() => onOpenLease(lease.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenLease(lease.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium text-teal-700">
                      {lease.leaseNumber}
                    </TableCell>
                    <TableCell>{lease.unitCode || "Whole property"}</TableCell>
                    <TableCell>{lease.tenantName}</TableCell>
                    <TableCell>
                      {lease.startsOn} – {lease.endsOn || "Open"}
                    </TableCell>
                    <TableCell>
                      <Status value={lease.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty
              title="No leases yet"
              detail="Create a lease from the Leases workspace tab."
            />
          )}
        </div>
      ) : null}
      {tab === "rent" ? (
        <div className="space-y-3 p-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Rent schedule</h3>
              <p className="text-xs text-slate-500">
                Scheduled and invoiced rent for this property’s leases.
              </p>
            </div>
            {permissions.bill ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: "assessLateFees", propertyId: property.id },
                      "Property late fees assessed",
                    )
                  }
                >
                  Assess late fees
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: "billRent", propertyId: property.id },
                      "Property rent billed",
                    )
                  }
                >
                  Bill due rent
                </Button>
              </div>
            ) : null}
          </div>
          <RentTable
            schedules={data.schedules.filter((row: any) =>
              leases.some((lease: any) => lease.id === row.leaseId),
            )}
            leases={leases}
            money={money}
          />
        </div>
      ) : null}
      {tab === "deposits" ? (
        <div className="space-y-3 p-1">
          <div>
            <h3 className="text-sm font-semibold">Security deposits</h3>
            <p className="text-xs text-slate-500">
              Append-only tenant deposit activity across this property.
            </p>
          </div>
          <DepositTable
            deposits={data.deposits.filter((row: any) =>
              leases.some((lease: any) => lease.id === row.leaseId),
            )}
            leases={leases}
            money={money}
          />
        </div>
      ) : null}
      {tab === "cam" ? (
        <div className="space-y-3 p-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">CAM reconciliations</h3>
              <p className="text-xs text-slate-500">
                Operating-expense pools, allocations, and tenant true-ups for
                this property.
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={onAddCam}>
                New CAM pool
              </Button>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
            <CamTable
              data={data}
              propertyId={property.id}
              money={money}
              busy={busy}
              permissions={permissions}
              act={act}
              onEdit={onEditCam}
              onReopen={onReopenCam}
            />
          </div>
        </div>
      ) : null}
      {tabs.some((item) => item.key === tab && isCustomTabKey(item.key)) ? (
        <div className="p-1">
          <HeaderFields
            layout={{
              ...effectiveLayout,
              header: {
                groups: effectiveLayout.header.groups.filter(
                  (group: FormLayoutConfig["header"]["groups"][number]) =>
                    (
                      tabs.find((item) => item.key === tab)?.groupIds ?? []
                    ).includes(group.id),
                ),
              },
            }}
            editable={editable}
            renderField={renderPropertyField}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function propertyForm(property: any, defs: CustomFieldDefClient[]) {
  return {
    name: property.name ?? "",
    code: property.code ?? "",
    propertyType: property.propertyType ?? "other",
    status: property.status ?? "active",
    subsidiaryId: property.subsidiaryId ?? "",
    locationId: property.locationId ?? "",
    fixedAssetId: property.fixedAssetId ?? "",
    currency: property.currency ?? "",
    street: property.address?.street ?? "",
    city: property.address?.city ?? "",
    region: property.address?.region ?? "",
    postalCode: property.address?.postalCode ?? "",
    rentIncomeAccountId: property.rentIncomeAccountId ?? "",
    camIncomeAccountId: property.camIncomeAccountId ?? "",
    depositLiabilityAccountId: property.depositLiabilityAccountId ?? "",
    defaultBankAccountId: property.defaultBankAccountId ?? "",
    custom: Object.fromEntries(
      defs.map((def) => [def.key, property.custom?.[def.key]]),
    ) as Record<string, unknown>,
  };
}

function PropertiesTable({ data, view, fieldDefs, onOpen }: any) {
  if (!data.properties.length)
    return (
      <Empty
        title="No properties yet"
        detail="Create the first property, connect its accounting dimensions, then add rentable units."
      />
    );
  const defs = new Map<string, CustomFieldDefClient>(
    fieldDefs.map((def: CustomFieldDefClient) => [def.key, def]),
  );
  const columns = view.columns.filter((column: any) => column.visible);
  const showsCodeColumn = columns.some((column: any) => column.key === "code");
  const labels: Record<string, string> = {
    name: "Property",
    code: "Code",
    subsidiary: "Entity",
    location: "Location",
    property_type: "Type",
    occupancy: "Occupancy",
    currency: "Currency",
    status: "Status",
  };
  const label = (column: any) =>
    column.labelOverride?.trim() ||
    (column.key.startsWith("cf_")
      ? defs.get(column.key.slice(3))?.label
      : labels[column.key]) ||
    column.key;
  const cell = (property: any, key: string) => {
    if (key.startsWith("cf_")) {
      const value = property.custom?.[key.slice(3)];
      return Array.isArray(value)
        ? value.join(", ")
        : value == null || value === ""
          ? "—"
          : String(value);
    }
    if (key === "name")
      return (
        <>
          <div className="font-medium text-teal-700">{property.name}</div>
          {showsCodeColumn ? null : (
            <div className="font-mono text-xs text-slate-500">
              {property.code}
            </div>
          )}
        </>
      );
    if (key === "code")
      return <span className="font-mono text-sm">{property.code}</span>;
    if (key === "subsidiary") return property.subsidiaryName;
    if (key === "location") return property.locationName || "Not mapped";
    if (key === "property_type")
      return (
        <span className="capitalize">
          {property.propertyType.replaceAll("_", " ")}
        </span>
      );
    if (key === "occupancy")
      return (
        <span className="tabular-nums">
          {property.occupiedUnits} / {property.unitCount}
        </span>
      );
    if (key === "currency")
      return <span className="font-mono text-xs">{property.currency}</span>;
    if (key === "status") return <Status value={property.status} />;
    return "—";
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column: any) => (
            <TableHead
              key={column.key}
              className={column.key === "occupancy" ? "text-right" : undefined}
            >
              {label(column)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.properties.map((property: any) => (
          <TableRow
            key={property.id}
            tabIndex={0}
            role="button"
            className="cursor-pointer"
            onClick={() => onOpen(property.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(property.id);
              }
            }}
          >
            {columns.map((column: any) => (
              <TableCell
                key={column.key}
                className={
                  column.key === "occupancy" ? "text-right" : undefined
                }
              >
                {cell(property, column.key)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function RentRollTable({ data, money, onOpenUnit, onOpenLease }: any) {
  const [query, setQuery] = useState("");
  const [propertyId, setPropertyId] = useState("all");
  const [status, setStatus] = useState("all");
  const today = new Date().toISOString().slice(0, 10);
  const operatingLeases = data.leases.filter((lease: any) =>
    ["active", "notice"].includes(lease.status),
  );
  const occupiedUnitIds = new Set(
    operatingLeases
      .map((lease: any) => lease.unitId)
      .filter((id: unknown): id is string => typeof id === "string"),
  );
  const draftByUnit = new Map<string, any>();
  for (const lease of data.leases) {
    if (lease.status === "draft" && lease.unitId && !draftByUnit.has(lease.unitId))
      draftByUnit.set(lease.unitId, lease);
  }
  const rows = [
    ...operatingLeases.filter((lease: any) => lease.unitId).map((lease: any) => ({
      key: `lease:${lease.id}`,
      property: data.properties.find((item: any) => item.id === lease.propertyId),
      unit: data.units.find((item: any) => item.id === lease.unitId) ?? null,
      lease,
    })),
    ...data.units
      .filter((unit: any) => !occupiedUnitIds.has(unit.id))
      .map((unit: any) => ({
        key: `unit:${unit.id}`,
        property: data.properties.find((item: any) => item.id === unit.propertyId),
        unit,
        lease: draftByUnit.get(unit.id) ?? null,
      })),
    ...data.leases
      .filter((lease: any) =>
        !lease.unitId && ["active", "notice", "draft"].includes(lease.status),
      )
      .map((lease: any) => ({
        key: `lease:${lease.id}`,
        property: data.properties.find((item: any) => item.id === lease.propertyId),
        unit: null,
        lease,
      })),
  ].sort((a, b) =>
    `${a.property?.name ?? ""}:${a.unit?.code ?? ""}:${a.lease?.leaseNumber ?? ""}`.localeCompare(
      `${b.property?.name ?? ""}:${b.unit?.code ?? ""}:${b.lease?.leaseNumber ?? ""}`,
    ),
  );
  const monthlyCharges = (lease: any) => {
    if (!lease) return 0;
    const current = data.charges.filter((charge: any) =>
      charge.leaseId === lease.id && charge.frequency === "monthly" &&
      charge.effectiveFrom <= today && (!charge.effectiveTo || charge.effectiveTo >= today),
    );
    if (current.length)
      return current.reduce((total: number, charge: any) => total + Number(charge.amount), 0);
    return lease.status === "draft" ? Number(lease.baseRent ?? 0) : 0;
  };
  const pastDue = (lease: any) => {
    if (!lease) return 0;
    const invoices = new Map<string, number>();
    for (const line of data.schedules) {
      if (line.leaseId === lease.id && line.invoiceDocumentId &&
          line.invoiceStatus === "posted" && line.invoiceDueOn && line.invoiceDueOn < today) {
        invoices.set(line.invoiceDocumentId, Number(line.invoiceOpenBalance ?? 0));
      }
    }
    return [...invoices.values()].reduce((total, amount) => total + amount, 0);
  };
  const rowStatus = (row: any) => row.lease?.status ?? row.unit?.status ?? "vacant";
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (propertyId !== "all" && row.property?.id !== propertyId) return false;
    if (status !== "all" && rowStatus(row) !== status) return false;
    if (!normalizedQuery) return true;
    return [row.property?.name, row.property?.code, row.unit?.code, row.unit?.name,
      row.lease?.leaseNumber, row.lease?.tenantName]
      .some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
  });
  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-3 sm:flex-row sm:items-end dark:border-slate-800">
        <Field label="Search rent roll">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Property, unit, tenant, or lease" />
          </div>
        </Field>
        <Field label="Property">
          <Select className="sm:w-56" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
            <option value="all">All properties</option>
            {data.properties.map((property: any) => (
              <option key={property.id} value={property.id}>{property.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select className="sm:w-44" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="notice">Notice</option>
            <option value="draft">Upcoming / draft</option>
            <option value="vacant">Vacant</option>
            <option value="offline">Offline</option>
          </Select>
        </Field>
        <p className="pb-2 text-xs text-slate-500 sm:ml-auto">
          {filtered.length} of {rows.length} rows · historical leases stay on each property
        </p>
      </div>
      {filtered.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property / unit</TableHead>
                <TableHead>Tenant / lease</TableHead>
                <TableHead>Term</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Monthly charges</TableHead>
                <TableHead className="text-right">Deposit held</TableHead>
                <TableHead className="text-right">Past due</TableHead>
                <TableHead>Billing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const overdueAmount = pastDue(row.lease);
                const open = () => row.lease ? onOpenLease(row.lease.id) :
                  row.unit ? onOpenUnit(row.unit.id) : undefined;
                return (
                  <TableRow key={row.key} role="button" tabIndex={0}
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault(); open();
                      }
                    }}>
                    <TableCell>
                      <div className="font-medium">{row.property?.name ?? "—"}</div>
                      <div className="text-xs text-slate-500">
                        {row.unit?.code ?? "Whole property"}{row.unit?.name ? ` · ${row.unit.name}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{row.lease?.tenantName ?? "No tenant"}</div>
                      <div className="font-mono text-xs text-slate-500">{row.lease?.leaseNumber ?? "Available"}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {row.lease ? `${row.lease.startsOn} – ${row.lease.endsOn || "Open"}` : "—"}
                    </TableCell>
                    <TableCell><Status value={rowStatus(row)} /></TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.lease ? money(monthlyCharges(row.lease), { currency: row.lease.currency }) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.lease ? money(row.lease.depositBalance ?? 0, { currency: row.lease.currency }) : "—"}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", overdueAmount > 0 && "font-medium text-red-600")}>
                      {row.lease ? money(overdueAmount, { currency: row.lease.currency }) : "—"}
                    </TableCell>
                    <TableCell>
                      {row.lease ? (
                        <Badge variant={row.lease.autoInvoice ? "success" : "secondary"}>
                          {row.lease.autoInvoice ? "Automatic" : "Manual"}
                        </Badge>
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Empty title="No rent-roll rows match" detail="Adjust the search, property, or status filters." />
      )}
    </div>
  );
}
function LeasesTable({ leases, money, onOpen }: any) {
  if (!leases.length)
    return (
      <Empty
        title="No leases yet"
        detail="Create a tenant lease to establish rent, CAM, deposit, and billing policy."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Lease</TableHead>
          <TableHead>Property / unit</TableHead>
          <TableHead>Tenant</TableHead>
          <TableHead>Term</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Deposit held</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leases.map((lease: any) => (
          <TableRow
            key={lease.id}
            role="button"
            tabIndex={0}
            className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
            onClick={() => onOpen(lease.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(lease.id);
              }
            }}
          >
            <TableCell className="font-medium">{lease.leaseNumber}</TableCell>
            <TableCell>
              {lease.propertyName}
              {lease.unitCode ? ` · ${lease.unitCode}` : ""}
            </TableCell>
            <TableCell>{lease.tenantName}</TableCell>
            <TableCell>
              {lease.startsOn} – {lease.endsOn || "Open"}
            </TableCell>
            <TableCell>
              <Status value={lease.status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(lease.depositBalance, { currency: lease.currency })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function RentTable({ schedules, leases, money }: any) {
  if (!schedules.length)
    return (
      <Empty
        title="No rent schedule yet"
        detail="Activate a lease to generate effective-dated rent and additional-charge periods."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Due</TableHead>
          <TableHead>Lease</TableHead>
          <TableHead>Charge</TableHead>
          <TableHead>Period</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Invoice</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.slice(0, 300).map((line: any) => {
          const lease = leases.find((item: any) => item.id === line.leaseId);
          return (
            <TableRow key={line.id}>
              <TableCell>{line.dueOn}</TableCell>
              <TableCell>{lease?.leaseNumber ?? "—"}</TableCell>
              <TableCell>{line.description}</TableCell>
              <TableCell>
                {line.periodStartsOn} – {line.periodEndsOn}
              </TableCell>
              <TableCell>
                <Status value={line.status} />
              </TableCell>
              <TableCell>{line.invoiceNumber || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(
                  line.amount,
                  lease?.currency ? { currency: lease.currency } : undefined,
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
function DepositTable({ deposits, leases, money, onReverse }: any) {
  if (!deposits.length)
    return (
      <Empty
        title="No security-deposit activity"
        detail="Deposit receipts, applications, interest, adjustments, and refunds appear here with journal evidence."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Lease</TableHead>
          <TableHead>Transaction</TableHead>
          <TableHead>Memo</TableHead>
          <TableHead>Journal</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          {onReverse ? <TableHead className="text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {deposits.map((row: any) => {
          const lease = leases.find((item: any) => item.id === row.leaseId);
          return (
            <TableRow key={row.id}>
              <TableCell>{row.occurredOn}</TableCell>
              <TableCell>{lease?.leaseNumber ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <Status value={row.kind} />
                  {row.reversalOfId ? <Badge variant="secondary">Reversal</Badge> : null}
                  {row.reversed ? <Badge variant="secondary">Reversed</Badge> : null}
                </div>
              </TableCell>
              <TableCell>{row.memo || "—"}</TableCell>
              <TableCell className="font-mono text-xs">
                {row.journalEntryId.slice(0, 8)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(
                  row.amount,
                  lease?.currency ? { currency: lease.currency } : undefined,
                )}
              </TableCell>
              {onReverse ? (
                <TableCell className="text-right">
                  {!row.reversalOfId && !row.reversed ? (
                    <Button size="sm" variant="outline" onClick={() => onReverse(row)}>
                      Reverse
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">Locked</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DepositReconciliationWorkspace({ money, onOpenProperty }: any) {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/property-management/deposit-reconciliation?asOf=${asOf}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Reconciliation failed");
        if (!cancelled) setResult(body);
      })
      .catch((error) => {
        if (!cancelled)
          toast.error(
            error instanceof Error ? error.message : "Reconciliation failed",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asOf]);
  if (loading && !result)
    return (
      <div className="p-12 text-center text-sm text-slate-500">
        Reconciling deposit subledger to the general ledger…
      </div>
    );
  const rows = result?.rows ?? [];
  const totals = result?.totals ?? {};
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Security deposit reconciliation</h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            Compare tenant deposit activity with posted deposit-liability entries
            and the property location control balance. Bank activity is supporting
            evidence and can differ after applications, interest, or adjustments.
          </p>
        </div>
        <div className="w-44">
          <Field label="As of">
            <Input
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Small label="Deposit subledger" value={money(totals.subledgerBalance ?? 0)} />
        <Small label="Linked posted GL" value={money(totals.linkedGlBalance ?? 0)} />
        <Small label="Deposit cash activity" value={money(totals.cashActivity ?? 0)} />
        <Small
          label="Exceptions"
          value={String(
            Number(totals.discrepancies ?? 0) +
              Number(totals.configurationRequired ?? 0),
          )}
        />
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>Deposit bank</TableHead>
              <TableHead className="text-right">Subledger</TableHead>
              <TableHead className="text-right">Linked GL</TableHead>
              <TableHead className="text-right">Location control</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: any) => {
              const difference = row.controlVariance ?? row.linkedVariance;
              return (
                <TableRow
                  key={row.propertyId}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                  onClick={() => onOpenProperty(row.propertyId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenProperty(row.propertyId);
                    }
                  }}
                >
                  <TableCell>
                    <div className="font-medium">{row.propertyName}</div>
                    <div className="font-mono text-xs text-slate-500">{row.propertyCode}</div>
                  </TableCell>
                  <TableCell>
                    {row.bankAccounts?.length
                      ? row.bankAccounts
                          .map((bank: any) => bank.bankAccountName)
                          .join(", ")
                      : row.defaultBankAccountName ?? "Not configured"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.subledgerBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.linkedGlBalance)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.locationControlBalance == null ? "—" : money(row.locationControlBalance)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", Number(difference) !== 0 && "font-medium text-red-600")}>
                    {money(difference ?? 0)}
                  </TableCell>
                  <TableCell>{row.lastActivityOn ?? "—"}</TableCell>
                  <TableCell><Status value={row.status} /></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!rows.length ? (
          <Empty title="No properties to reconcile" detail="Create a property and lease before running deposit reconciliation." />
        ) : null}
      </div>
    </div>
  );
}

function CamTable({
  data,
  propertyId,
  money,
  busy,
  permissions,
  act,
  onEdit,
  onReopen,
}: any) {
  const pools = propertyId
    ? data.camPools.filter((pool: any) => pool.propertyId === propertyId)
    : data.camPools;
  if (!pools.length)
    return (
      <Empty
        title="No CAM pools yet"
        detail={propertyId
          ? "Create this property's first operating-expense pool and tenant reconciliation."
          : "Create an annual operating-expense pool, allocate actual GL costs, and invoice tenant true-ups."}
      />
    );
  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {pools.map((pool: any) => {
        const property = data.properties.find(
          (item: any) => item.id === pool.propertyId,
        );
        const allocations = data.camAllocations.filter(
          (item: any) => item.poolId === pool.id,
        );
        return (
          <div key={pool.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">
                  {pool.name} · {pool.fiscalYear}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {property?.name} · {pool.periodStartsOn}–{pool.periodEndsOn} ·{" "}
                  {pool.allocationBasis.replaceAll("_", " ")}
                </div>
              </div>
              <div className="flex gap-2">
                <Status value={pool.status} />
                {permissions.manage &&
                ["draft", "open"].includes(pool.status) ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onEdit?.(pool)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Cancel ${pool.name}? The pool will remain in CAM history.`,
                          )
                        )
                          void act(
                            { action: "cancelCamPool", poolId: pool.id },
                            "CAM pool cancelled",
                          );
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : null}
                {permissions.account &&
                ["draft", "open"].includes(pool.status) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "finalizeCam", poolId: pool.id },
                        "CAM actuals finalized",
                      )
                    }
                  >
                    Finalize
                  </Button>
                ) : null}
                {permissions.account && pool.status === "finalized" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onReopen?.(pool)}
                  >
                    Reopen for correction
                  </Button>
                ) : null}
                {permissions.bill && pool.status === "finalized" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "billCam", poolId: pool.id },
                        "CAM reconciliations created",
                      )
                    }
                  >
                    Create true-ups
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Small
                label="Budget"
                value={money(
                  pool.budgetAmount,
                  property?.currency
                    ? { currency: property.currency }
                    : undefined,
                )}
              />
              <Small
                label="Actual"
                value={
                  pool.actualAmount == null
                    ? "—"
                    : money(
                        pool.actualAmount,
                        property?.currency
                          ? { currency: property.currency }
                          : undefined,
                      )
                }
              />
              <Small
                label="Lease allocations"
                value={String(allocations.length)}
              />
            </div>
            {allocations.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lease</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">
                        Previously billed
                      </TableHead>
                      <TableHead className="text-right">True-up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allocations.map((allocation: any) => (
                      <TableRow key={allocation.id}>
                        <TableCell>
                          {
                            data.leases.find(
                              (lease: any) => lease.id === allocation.leaseId,
                            )?.leaseNumber
                          }
                        </TableCell>
                        <TableCell className="text-right">
                          {allocation.sharePercent}%
                        </TableCell>
                        <TableCell className="text-right">
                          {money(allocation.actualAllocation ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(allocation.billedEstimate)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {money(allocation.reconciliationAmount ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const generatedId = useId();
  const labelable =
    isValidElement<{ id?: string }>(children) && children.type !== "div";
  const child = labelable
    ? cloneElement(children, { id: children.props.id ?? generatedId })
    : children;
  const controlId =
    labelable && isValidElement<{ id?: string }>(child)
      ? child.props.id
      : undefined;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={controlId}>{label}</Label>
      {child}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function PropertyDrawer({ open, onClose, options, busy, onSave }: any) {
  const initial = {
    code: "",
    name: "",
    propertyType: "residential",
    subsidiaryId: options.subsidiaries[0]?.id ?? "",
    currency: options.subsidiaries[0]?.currency ?? "CAD",
    locationId: "",
    fixedAssetId: "",
    rentIncomeAccountId: "",
    camIncomeAccountId: "",
    depositLiabilityAccountId: "",
    defaultBankAccountId: "",
    street: "",
    city: "",
    region: "",
    postalCode: "",
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open]);
  const submit = () =>
    onSave({
      ...form,
      locationId: form.locationId || null,
      fixedAssetId: form.fixedAssetId || null,
      camIncomeAccountId: form.camIncomeAccountId || null,
      depositLiabilityAccountId: form.depositLiabilityAccountId || null,
      defaultBankAccountId: form.defaultBankAccountId || null,
      address: {
        street: form.street,
        city: form.city,
        region: form.region,
        postalCode: form.postalCode,
      },
    });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New property"
      description="Connect the operational property to its legal entity, accounting dimension, and control accounts."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.code ||
              !form.name ||
              !form.subsidiaryId ||
              !form.rentIncomeAccountId
            }
            onClick={submit}
          >
            {busy ? "Creating…" : "Create property"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.propertyType}
              onChange={(e) =>
                setForm({ ...form, propertyType: e.target.value })
              }
            >
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="mixed_use">Mixed use</option>
              <option value="industrial">Industrial</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Legal entity">
            <Select
              value={form.subsidiaryId}
              onChange={(e) => {
                const sub = options.subsidiaries.find(
                  (item: Option) => item.id === e.target.value,
                );
                setForm({
                  ...form,
                  subsidiaryId: e.target.value,
                  currency: sub?.currency ?? form.currency,
                });
              }}
            >
              <option value="">Select entity</option>
              {options.subsidiaries.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Property location">
            <Select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            >
              <option value="">Not mapped</option>
              {options.locations.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fixed asset">
            <Select
              value={form.fixedAssetId}
              onChange={(e) =>
                setForm({ ...form, fixedAssetId: e.target.value })
              }
            >
              <option value="">Not owned / not linked</option>
              {options.assets.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rent income account">
            <Select
              value={form.rentIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, rentIncomeAccountId: e.target.value })
              }
            >
              <option value="">Select account</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="CAM income account">
            <Select
              value={form.camIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, camIncomeAccountId: e.target.value })
              }
            >
              <option value="">Select account</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deposit liability">
            <Select
              value={form.depositLiabilityAccountId}
              onChange={(e) =>
                setForm({ ...form, depositLiabilityAccountId: e.target.value })
              }
            >
              <option value="">Select liability</option>
              {options.liabilityAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default deposit bank">
            <Select
              value={form.defaultBankAccountId}
              onChange={(e) =>
                setForm({ ...form, defaultBankAccountId: e.target.value })
              }
            >
              <option value="">Select bank</option>
              {options.bankAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Street">
            <Input
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          </Field>
          <Field label="City">
            <Input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          </Field>
          <Field label="Province / state">
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </Field>
          <Field label="Postal code">
            <Input
              value={form.postalCode}
              onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

function UnitDrawer({ propertyId, onClose, busy, onSave }: any) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    unitType: "",
    rentableArea: "",
    bedrooms: "",
  });
  useEffect(() => {
    if (propertyId)
      setForm({
        code: "",
        name: "",
        unitType: "",
        rentableArea: "",
        bedrooms: "",
      });
  }, [propertyId]);
  const submit = () =>
    onSave({
      propertyId,
      ...form,
      rentableArea: form.rentableArea || null,
      bedrooms: form.bedrooms ? Number(form.bedrooms) : null,
    });
  return (
    <Drawer
      open={!!propertyId}
      onClose={onClose}
      stacked
      title="Add rentable unit"
      description="Units carry occupancy and rentable-area evidence for CAM allocation."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !form.code} onClick={submit}>
            {busy ? "Adding…" : "Add unit"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <Field label="Unit code">
          <Input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label="Display name">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Unit type">
            <Input
              value={form.unitType}
              onChange={(e) => setForm({ ...form, unitType: e.target.value })}
            />
          </Field>
          <Field label="Rentable area">
            <Input
              type="number"
              min="0"
              value={form.rentableArea}
              onChange={(e) =>
                setForm({ ...form, rentableArea: e.target.value })
              }
            />
          </Field>
          <Field label="Bedrooms">
            <Input
              type="number"
              min="0"
              value={form.bedrooms}
              onChange={(e) => setForm({ ...form, bedrooms: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

function UnitRecordDrawer({
  unit,
  property,
  leases,
  permissions,
  busy,
  onClose,
  onOpenLease,
  onAddLease,
  onSave,
  onDelete,
}: any) {
  const [tab, setTab] = useState("overview");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [form, setForm] = useState(() => unitForm(unit ?? {}));
  if (!unit) return null;
  const reset = () => {
    setForm(unitForm(unit));
    setMode("view");
  };
  const save = async () => {
    const result = await onSave({
      unitId: unit.id,
      code: form.code,
      name: form.name || null,
      unitType: form.unitType || null,
      rentableArea: form.rentableArea || null,
      bedrooms: form.bedrooms === "" ? null : Number(form.bedrooms),
      status: form.status,
    });
    if (result) setMode("view");
  };
  const activeLease = leases.some((lease: any) =>
    ["active", "notice"].includes(lease.status),
  );
  const setAvailability = async (status: "vacant" | "offline") => {
    const result = await onSave({
      unitId: unit.id,
      ...form,
      name: form.name || null,
      unitType: form.unitType || null,
      rentableArea: form.rentableArea || null,
      bedrooms: form.bedrooms === "" ? null : Number(form.bedrooms),
      status,
    });
    if (result) {
      setForm({ ...form, status });
      setActionsOpen(false);
    }
  };
  return (
    <Drawer
      open
      stacked
      size="xl"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500">{unit.code}</span>
          <span>{unit.name || "Rentable unit"}</span>
          <Status value={form.status} />
        </span>
      }
      description={`${property?.name ?? "Property"} · Occupancy is controlled by lease activation`}
      subtabs={
        <RecordTabs
          label="Unit details"
          active={tab}
          tabs={[
            { key: "overview", label: "Overview" },
            { key: "leases", label: "Leases" },
          ]}
          onChange={setTab}
        />
      }
      headerActions={
        mode === "edit" ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={reset}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !form.code.trim()} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : permissions.manage ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
              Edit
            </Button>
            <Popover
              open={actionsOpen}
              onOpenChange={setActionsOpen}
              align="end"
              className="w-56 p-1.5"
              trigger={
                <Button size="sm" variant="outline" onClick={() => setActionsOpen((open) => !open)}>
                  Actions <ChevronDown className={cn("h-3.5 w-3.5", actionsOpen && "rotate-180")} />
                </Button>
              }
            >
              {form.status === "offline" ? (
                <Button variant="ghost" className="h-8 w-full justify-start rounded px-2 text-xs" disabled={busy} onClick={() => setAvailability("vacant")}>
                  Return to service
                </Button>
              ) : (
                <Button variant="ghost" className="h-8 w-full justify-start rounded px-2 text-xs" disabled={busy || activeLease} onClick={() => setAvailability("offline")}>
                  {activeLease ? "End lease before taking offline" : "Take unit offline"}
                </Button>
              )}
              <Button
                variant="ghost"
                className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete unit ${unit.code}? Only units without lease history can be deleted.`)) void onDelete();
                }}
              >
                Delete unit
              </Button>
            </Popover>
          </div>
        ) : undefined
      }
    >
      {tab === "overview" ? (
        mode === "edit" ? (
          <div className="grid gap-4 p-1 sm:grid-cols-2">
            <Field label="Unit code">
              <Input className="font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Display name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Unit type">
              <Input value={form.unitType} onChange={(e) => setForm({ ...form, unitType: e.target.value })} />
            </Field>
            <Field label="Rentable area">
              <Input type="number" min="0" value={form.rentableArea} onChange={(e) => setForm({ ...form, rentableArea: e.target.value })} />
            </Field>
            <Field label="Bedrooms">
              <Input type="number" min="0" step="1" value={form.bedrooms} onChange={(e) => setForm({ ...form, bedrooms: e.target.value })} />
            </Field>
            <Field label="Occupancy status" hint="Status changes when a lease is activated or terminated.">
              <div className="pt-2"><Status value={form.status} /></div>
            </Field>
          </div>
        ) : (
          <Card>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              <Read label="Property" value={property?.name ?? "—"} />
              <Read label="Unit type" value={unit.unitType || "—"} />
              <Read label="Rentable area" value={unit.rentableArea || "—"} />
              <Read label="Bedrooms" value={unit.bedrooms == null ? "—" : String(unit.bedrooms)} />
              <Read label="Status" value={form.status} />
            </CardContent>
          </Card>
        )
      ) : null}
      {tab === "leases" ? (
        <div className="space-y-3 p-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Unit leases</h3>
              <p className="text-xs text-slate-500">Lease history and current occupancy for this unit.</p>
            </div>
            {permissions.manage && !activeLease && property?.status === "active" ? (
              <Button size="sm" onClick={onAddLease}>New lease</Button>
            ) : null}
          </div>
          {leases.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lease</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leases.map((lease: any) => (
                  <TableRow
                    key={lease.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                    onClick={() => onOpenLease(lease.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenLease(lease.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium text-teal-700">{lease.leaseNumber}</TableCell>
                    <TableCell>{lease.tenantName}</TableCell>
                    <TableCell>{lease.startsOn} – {lease.endsOn || "Open"}</TableCell>
                    <TableCell><Status value={lease.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty title="No unit leases" detail="Create a lease to assign this unit to a tenant." />
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function unitForm(unit: any) {
  return {
    code: unit.code ?? "",
    name: unit.name ?? "",
    unitType: unit.unitType ?? "",
    rentableArea: unit.rentableArea ?? "",
    bedrooms: unit.bedrooms == null ? "" : String(unit.bedrooms),
    status: unit.status ?? "vacant",
  };
}

function LeaseDrawer({ open, stacked, initialPropertyId, initialUnitId, onClose, data, tenants, busy, onSave }: any) {
  const today = new Date().toISOString().slice(0, 10);
  const initial = {
    propertyId: initialPropertyId ?? data.properties[0]?.id ?? "",
    unitId: initialUnitId ?? "",
    tenantId: "",
    leaseNumber: "",
    startsOn: today,
    endsOn: "",
    baseRent: "",
    billingDay: "1",
    paymentTermsDays: "0",
    securityDepositRequired: "0",
    camMethod: "none",
    camSharePercent: "",
    lateFeeType: "none",
    lateFeeValue: "0",
    graceDays: "0",
    autoInvoice: true,
    autoPost: false,
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open)
      setForm({
        ...initial,
        propertyId: initialPropertyId ?? data.properties[0]?.id ?? "",
        unitId: initialUnitId ?? "",
      });
  }, [open, initialPropertyId, initialUnitId, data.properties.length]);
  const units = data.units.filter(
    (u: any) => u.propertyId === form.propertyId && u.status === "vacant",
  );
  const submit = () =>
    onSave({
      ...form,
      unitId: form.unitId || null,
      endsOn: form.endsOn || null,
      billingDay: Number(form.billingDay),
      paymentTermsDays: Number(form.paymentTermsDays),
      graceDays: Number(form.graceDays),
      camSharePercent: form.camSharePercent || null,
    });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      stacked={stacked}
      title="New tenant lease"
      description="The draft freezes commercial policy before activation creates the rent schedule."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.leaseNumber ||
              !form.propertyId ||
              !form.tenantId ||
              !form.startsOn ||
              !form.baseRent
            }
            onClick={submit}
          >
            {busy ? "Creating…" : "Create draft lease"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lease number">
            <Input
              value={form.leaseNumber}
              onChange={(e) =>
                setForm({ ...form, leaseNumber: e.target.value })
              }
            />
          </Field>
          <Field label="Tenant">
            <Select
              value={form.tenantId}
              onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
            >
              <option value="">Select tenant</option>
              {tenants.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Property">
            <Select
              value={form.propertyId}
              onChange={(e) =>
                setForm({ ...form, propertyId: e.target.value, unitId: "" })
              }
            >
              <option value="">Select property</option>
              {data.properties.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unit">
            <Select
              value={form.unitId}
              onChange={(e) => setForm({ ...form, unitId: e.target.value })}
            >
              <option value="">Whole property / no unit</option>
              {units.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.code}
                  {o.name ? ` · ${o.name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starts">
            <Input
              type="date"
              value={form.startsOn}
              onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            />
          </Field>
          <Field label="Ends">
            <Input
              type="date"
              value={form.endsOn}
              onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
            />
          </Field>
          <Field label="Monthly base rent">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.baseRent}
              onChange={(e) => setForm({ ...form, baseRent: e.target.value })}
            />
          </Field>
          <Field label="Billing day">
            <Input
              type="number"
              min="1"
              max="31"
              value={form.billingDay}
              onChange={(e) => setForm({ ...form, billingDay: e.target.value })}
            />
          </Field>
          <Field label="Security deposit required">
            <Input
              type="number"
              min="0"
              value={form.securityDepositRequired}
              onChange={(e) =>
                setForm({ ...form, securityDepositRequired: e.target.value })
              }
            />
          </Field>
          <Field label="Payment terms days">
            <Input
              type="number"
              min="0"
              value={form.paymentTermsDays}
              onChange={(e) =>
                setForm({ ...form, paymentTermsDays: e.target.value })
              }
            />
          </Field>
          <Field label="CAM method">
            <Select
              value={form.camMethod}
              onChange={(e) => setForm({ ...form, camMethod: e.target.value })}
            >
              <option value="none">None</option>
              <option value="fixed">Fixed estimate</option>
              <option value="pro_rata">Pro rata reconciliation</option>
            </Select>
          </Field>
          <Field label="CAM share %">
            <Input
              type="number"
              min="0"
              max="100"
              value={form.camSharePercent}
              onChange={(e) =>
                setForm({ ...form, camSharePercent: e.target.value })
              }
            />
          </Field>
          <Field label="Late fee">
            <Select
              value={form.lateFeeType}
              onChange={(e) =>
                setForm({ ...form, lateFeeType: e.target.value })
              }
            >
              <option value="none">None</option>
              <option value="fixed">Fixed amount</option>
              <option value="percent">Percent of charge</option>
            </Select>
          </Field>
          <Field label="Late fee value">
            <Input
              type="number"
              min="0"
              value={form.lateFeeValue}
              onChange={(e) =>
                setForm({ ...form, lateFeeValue: e.target.value })
              }
            />
          </Field>
          <Field label="Grace days">
            <Input
              type="number"
              min="0"
              value={form.graceDays}
              onChange={(e) => setForm({ ...form, graceDays: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoInvoice}
              onChange={(e) =>
                setForm({ ...form, autoInvoice: e.target.checked })
              }
            />
            Automatically invoice due charges
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoPost}
              onChange={(e) => setForm({ ...form, autoPost: e.target.checked })}
            />
            Automatically post when ungated
          </label>
        </div>
      </div>
    </Drawer>
  );
}

function LeaseRecordDrawer({
  lease,
  data,
  options,
  permissions,
  busy,
  stacked,
  onClose,
  act,
  money,
  onSave,
}: any) {
  const [tab, setTab] = useState<LeaseTab>("overview");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [terminationOpen, setTerminationOpen] = useState(false);
  const [termination, setTermination] = useState({
    terminatedOn: new Date().toISOString().slice(0, 10),
    reason: "",
  });
  const [form, setForm] = useState(() => leaseForm(lease ?? {}));
  if (!lease) return null;
  const canEdit =
    permissions.manage && ["draft", "active", "notice"].includes(lease.status);
  const reset = () => {
    setForm(leaseForm(lease));
    setMode("view");
  };
  const save = async () => {
    const result = await onSave({
      leaseId: lease.id,
      ...form,
      unitId: form.unitId || null,
      endsOn: form.endsOn || null,
      billingDay: Number(form.billingDay),
      paymentTermsDays: Number(form.paymentTermsDays),
      graceDays: Number(form.graceDays),
      camSharePercent: form.camSharePercent || null,
    });
    if (result) setMode("view");
  };
  return (
    <Drawer
      open
      stacked={stacked}
      onClose={onClose}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{`Lease ${lease.leaseNumber}`}</span>
          <Status value={lease.status} />
        </span>
      }
      description={`${lease.propertyName}${lease.unitCode ? ` · ${lease.unitCode}` : ""} · ${lease.tenantName}`}
      subtabs={
        <RecordTabs
          label="Lease details"
          active={tab}
          tabs={[
            { key: "overview", label: "Overview" },
            { key: "charges", label: "Charges" },
            { key: "escalations", label: "Escalations" },
            { key: "deposits", label: "Deposits" },
          ]}
          onChange={(key) => {
            setTab(key as LeaseTab);
            if (key !== "overview" && mode === "edit") reset();
          }}
        />
      }
      headerActions={
        mode === "edit" ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                !form.leaseNumber.trim() ||
                !form.propertyId ||
                !form.tenantId ||
                !form.startsOn ||
                !form.baseRent
              }
              onClick={save}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            {canEdit && tab === "overview" ? (
              <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
                Edit
              </Button>
            ) : null}
            {permissions.manage ? (
              <Popover
                open={actionsOpen}
                onOpenChange={setActionsOpen}
                align="end"
                className="w-56 p-1.5"
                trigger={
                  <Button size="sm" variant="outline" onClick={() => setActionsOpen((open) => !open)}>
                    Actions <ChevronDown className={cn("h-3.5 w-3.5", actionsOpen && "rotate-180")} />
                  </Button>
                }
              >
                {lease.status === "draft" ? (
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Cancel lease ${lease.leaseNumber}? The record will remain in history.`)) {
                        void act({ action: "cancelLease", leaseId: lease.id }, "Lease cancelled");
                        setActionsOpen(false);
                      }
                    }}
                  >
                    Cancel lease
                  </Button>
                ) : ["active", "notice"].includes(lease.status) ? (
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      setTerminationOpen(true);
                      setActionsOpen(false);
                      setTab("overview");
                    }}
                  >
                    Terminate lease
                  </Button>
                ) : (
                  <div className="px-2 py-1.5 text-xs text-slate-500">This lease is read-only.</div>
                )}
              </Popover>
            ) : null}
          </div>
        )
      }
    >
      {terminationOpen ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="space-y-4 p-4">
            <div>
              <h3 className="font-medium text-red-700 dark:text-red-300">Terminate lease</h3>
              <p className="mt-1 text-xs text-slate-500">Future scheduled rent will be cancelled and the unit returned to vacant.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Termination date">
                <Input type="date" value={termination.terminatedOn} onChange={(e) => setTermination({ ...termination, terminatedOn: e.target.value })} />
              </Field>
              <Field label="Reason">
                <Input value={termination.reason} onChange={(e) => setTermination({ ...termination, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTerminationOpen(false)}>Cancel</Button>
              <Button
                disabled={busy || !termination.terminatedOn || !termination.reason.trim()}
                onClick={async () => {
                  const result = await act(
                    { action: "terminateLease", leaseId: lease.id, ...termination },
                    "Lease terminated",
                  );
                  if (result) setTerminationOpen(false);
                }}
              >
                Terminate lease
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <LeaseDetail
          lease={lease}
          data={data}
          options={options}
          permissions={permissions}
          busy={busy}
          tab={tab}
          act={act}
          money={money}
          editing={mode === "edit"}
          form={form}
          setForm={setForm}
        />
      )}
    </Drawer>
  );
}

function leaseForm(lease: any) {
  return {
    propertyId: lease.propertyId ?? "",
    unitId: lease.unitId ?? "",
    tenantId: lease.tenantId ?? "",
    leaseNumber: lease.leaseNumber ?? "",
    startsOn: lease.startsOn ?? "",
    endsOn: lease.endsOn ?? "",
    baseRent: lease.baseRent ?? "",
    billingDay: String(lease.billingDay ?? 1),
    paymentTermsDays: String(lease.paymentTermsDays ?? 0),
    securityDepositRequired: lease.securityDepositRequired ?? "0",
    camMethod: lease.camMethod ?? "none",
    camSharePercent: lease.camSharePercent ?? "",
    lateFeeType: lease.lateFeeType ?? "none",
    lateFeeValue: lease.lateFeeValue ?? "0",
    graceDays: String(lease.graceDays ?? 0),
    autoInvoice: lease.autoInvoice ?? true,
    autoPost: lease.autoPost ?? false,
  };
}

function LeaseEditFields({ lease, data, options, form, setForm }: any) {
  const draft = lease.status === "draft";
  const units = data.units.filter(
    (unit: any) =>
      unit.propertyId === form.propertyId &&
      (unit.status === "vacant" || unit.id === form.unitId),
  );
  return (
    <div className="space-y-4">
      {!draft ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Activated leases keep their property, unit, tenant, start date, billing day, and rent evidence. Use an escalation for a rent change.
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Lease number">
          <Input value={form.leaseNumber} onChange={(e) => setForm({ ...form, leaseNumber: e.target.value })} />
        </Field>
        <Field label="Tenant">
          <Select disabled={!draft} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
            <option value="">Select tenant</option>
            {options.tenants.map((option: Option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </Select>
        </Field>
        <Field label="Property">
          <Select disabled={!draft} value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value, unitId: "" })}>
            {data.properties.map((property: any) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </Select>
        </Field>
        <Field label="Unit">
          <Select disabled={!draft} value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
            <option value="">Whole property / no unit</option>
            {units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.code}{unit.name ? ` · ${unit.name}` : ""}</option>)}
          </Select>
        </Field>
        <Field label="Starts">
          <Input disabled={!draft} type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} />
        </Field>
        <Field label="Ends">
          <Input disabled={!draft && !lease.endsOn} type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
        </Field>
        <Field label="Monthly base rent" hint={draft ? undefined : "Use an escalation to change active rent."}>
          <Input disabled={!draft} type="number" min="0" step="0.01" value={form.baseRent} onChange={(e) => setForm({ ...form, baseRent: e.target.value })} />
        </Field>
        <Field label="Billing day">
          <Input disabled={!draft} type="number" min="1" max="31" value={form.billingDay} onChange={(e) => setForm({ ...form, billingDay: e.target.value })} />
        </Field>
        <Field label="Security deposit required">
          <Input type="number" min="0" step="0.01" value={form.securityDepositRequired} onChange={(e) => setForm({ ...form, securityDepositRequired: e.target.value })} />
        </Field>
        <Field label="Payment terms days">
          <Input type="number" min="0" step="1" value={form.paymentTermsDays} onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })} />
        </Field>
        <Field label="CAM method">
          <Select value={form.camMethod} onChange={(e) => setForm({ ...form, camMethod: e.target.value })}>
            <option value="none">None</option>
            <option value="fixed">Fixed estimate</option>
            <option value="pro_rata">Pro rata reconciliation</option>
          </Select>
        </Field>
        <Field label="CAM share %">
          <Input disabled={form.camMethod === "none"} type="number" min="0" max="100" value={form.camSharePercent} onChange={(e) => setForm({ ...form, camSharePercent: e.target.value })} />
        </Field>
        <Field label="Late fee">
          <Select value={form.lateFeeType} onChange={(e) => setForm({ ...form, lateFeeType: e.target.value, lateFeeValue: e.target.value === "none" ? "0" : form.lateFeeValue })}>
            <option value="none">None</option>
            <option value="fixed">Fixed amount</option>
            <option value="percent">Percent of open charge</option>
          </Select>
        </Field>
        <Field label="Late fee value">
          <Input disabled={form.lateFeeType === "none"} type="number" min="0" value={form.lateFeeValue} onChange={(e) => setForm({ ...form, lateFeeValue: e.target.value })} />
        </Field>
        <Field label="Grace days">
          <Input type="number" min="0" step="1" value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-5 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.autoInvoice} onChange={(e) => setForm({ ...form, autoInvoice: e.target.checked })} /> Auto-create invoices</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.autoPost} onChange={(e) => setForm({ ...form, autoPost: e.target.checked })} /> Auto-post invoices</label>
      </div>
    </div>
  );
}

function LeaseDetail({
  lease,
  data,
  options,
  permissions,
  busy,
  tab,
  act,
  money,
  editing,
  form,
  setForm,
}: any) {
  const charges = data.charges.filter((row: any) => row.leaseId === lease.id);
  const escalations = data.escalations.filter(
    (row: any) => row.leaseId === lease.id,
  );
  const deposits = data.deposits.filter((row: any) => row.leaseId === lease.id);
  const schedules = data.schedules.filter(
    (row: any) => row.leaseId === lease.id,
  );
  return (
    <div className="space-y-5 p-1">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex flex-wrap gap-2">
          {lease.status === "draft" && permissions.manage ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                act(
                  { action: "activateLease", leaseId: lease.id },
                  "Lease activated and scheduled",
                )
              }
            >
              Activate lease
            </Button>
          ) : null}
          {["active", "notice"].includes(lease.status) && permissions.bill ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(
                    { action: "scheduleLease", leaseId: lease.id },
                    "Rent schedule extended",
                  )
                }
              >
                Extend schedule
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    { action: "billRent", leaseId: lease.id },
                    "Due rent billed",
                  )
                }
              >
                Bill due rent
              </Button>
            </>
          ) : null}
          </div>
        </div>
      ) : null}
      {tab === "overview" ? (
        editing ? (
          <LeaseEditFields
            lease={lease}
            data={data}
            options={options}
            form={form}
            setForm={setForm}
          />
        ) : (
          <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Small
              label="Term"
              value={`${lease.startsOn} – ${lease.endsOn || "Open"}`}
            />
            <Small
              label="Deposit required"
              value={money(lease.securityDepositRequired, {
                currency: lease.currency,
              })}
            />
            <Small
              label="Deposit held"
              value={money(lease.depositBalance, { currency: lease.currency })}
            />
          </div>
          <Card>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
              <Read label="Property" value={lease.propertyName} />
              <Read label="Unit" value={lease.unitCode || "Whole property"} />
              <Read label="Tenant" value={lease.tenantName} />
              <Read
                label="CAM"
                value={`${lease.camMethod.replaceAll("_", " ")}${lease.camSharePercent ? ` · ${lease.camSharePercent}%` : ""}`}
              />
              <Read
                label="Late fee"
                value={
                  lease.lateFeeType === "none"
                    ? "None"
                    : `${lease.lateFeeValue} ${lease.lateFeeType}`
                }
              />
              <Read
                label="Scheduled periods"
                value={String(schedules.length)}
              />
            </CardContent>
          </Card>
          </div>
        )
      ) : null}
      {tab === "charges" ? (
        <ChargesSection
          lease={lease}
          charges={charges}
          permissions={permissions}
          busy={busy}
          act={act}
          money={money}
          options={options}
        />
      ) : null}
      {tab === "escalations" ? (
        <EscalationsSection
          lease={lease}
          rows={escalations}
          permissions={permissions}
          busy={busy}
          act={act}
        />
      ) : null}
      {tab === "deposits" ? (
        <DepositSection
          lease={lease}
          rows={deposits}
          options={options}
          permissions={permissions}
          busy={busy}
          act={act}
          money={money}
        />
      ) : null}
    </div>
  );
}
function Read({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}
function ChargesSection({
  lease,
  charges,
  permissions,
  busy,
  act,
  money,
  options,
}: any) {
  const [form, setForm] = useState({
    chargeType: "cam",
    description: "CAM estimate",
    amount: "",
    frequency: "monthly",
    effectiveFrom: lease.startsOn,
    effectiveTo: lease.endsOn || "",
    incomeAccountId: "",
    itemId: "",
    taxCodeId: "",
  });
  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Charge</TableHead>
            <TableHead>Frequency</TableHead>
            <TableHead>Effective</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.map((row: any) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-medium">{row.description}</div>
                <div className="text-xs capitalize text-slate-500">
                  {row.chargeType.replaceAll("_", " ")}
                </div>
              </TableCell>
              <TableCell className="capitalize">{row.frequency}</TableCell>
              <TableCell>
                {row.effectiveFrom} – {row.effectiveTo || "Open"}
              </TableCell>
              <TableCell className="text-right">
                {money(row.amount, { currency: lease.currency })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {permissions.manage &&
      ["draft", "active", "notice"].includes(lease.status) ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">Add recurring charge</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type">
                <Select
                  value={form.chargeType}
                  onChange={(e) =>
                    setForm({ ...form, chargeType: e.target.value })
                  }
                >
                  <option value="cam">CAM</option>
                  <option value="parking">Parking</option>
                  <option value="storage">Storage</option>
                  <option value="utility">Utility</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Description">
                <Input
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </Field>
              <Field label="Amount">
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              <Field label="Frequency">
                <Select
                  value={form.frequency}
                  onChange={(e) =>
                    setForm({ ...form, frequency: e.target.value })
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                  <option value="one_time">One time</option>
                </Select>
              </Field>
              <Field label="Effective from">
                <Input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    setForm({ ...form, effectiveFrom: e.target.value })
                  }
                />
              </Field>
              <Field label="Effective to">
                <Input
                  type="date"
                  value={form.effectiveTo}
                  onChange={(e) =>
                    setForm({ ...form, effectiveTo: e.target.value })
                  }
                />
              </Field>
              <Field label="Income account">
                <Select
                  value={form.incomeAccountId}
                  onChange={(e) =>
                    setForm({ ...form, incomeAccountId: e.target.value })
                  }
                >
                  <option value="">Property default</option>
                  {options.incomeAccounts.map((o: Option) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              size="sm"
              disabled={busy || !form.amount || !form.description}
              onClick={() =>
                act(
                  {
                    action: "addCharge",
                    leaseId: lease.id,
                    ...form,
                    effectiveTo: form.effectiveTo || null,
                    incomeAccountId: form.incomeAccountId || null,
                  },
                  "Lease charge added",
                )
              }
            >
              Add charge
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
function EscalationsSection({ lease, rows, permissions, busy, act }: any) {
  const [form, setForm] = useState({
    effectiveOn: lease.endsOn || lease.startsOn,
    method: "percent",
    value: "",
  });
  return (
    <div className="space-y-4">
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Effective</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: any) => (
              <TableRow key={row.id}>
                <TableCell>{row.effectiveOn}</TableCell>
                <TableCell className="capitalize">
                  {row.method.replaceAll("_", " ")}
                </TableCell>
                <TableCell>{row.value}</TableCell>
                <TableCell>{row.newAmount || "—"}</TableCell>
                <TableCell>
                  <Status value={row.status} />
                </TableCell>
                <TableCell>
                  {row.status === "scheduled" && permissions.manage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(
                          { action: "applyEscalation", escalationId: row.id },
                          "Rent escalation applied",
                        )
                      }
                    >
                      Apply
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty
          title="No rent escalations"
          detail="Schedule contractual percent, fixed-dollar, or replacement-rent changes."
        />
      )}
      {permissions.manage ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">Schedule escalation</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Effective on">
                <Input
                  type="date"
                  value={form.effectiveOn}
                  onChange={(e) =>
                    setForm({ ...form, effectiveOn: e.target.value })
                  }
                />
              </Field>
              <Field label="Method">
                <Select
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                >
                  <option value="percent">Percent increase</option>
                  <option value="fixed">Fixed increase</option>
                  <option value="new_amount">New monthly amount</option>
                </Select>
              </Field>
              <Field label="Value">
                <Input
                  type="number"
                  min="0"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              </Field>
            </div>
            <Button
              size="sm"
              disabled={busy || !form.effectiveOn || !form.value}
              onClick={() =>
                act(
                  { action: "addEscalation", leaseId: lease.id, ...form },
                  "Escalation scheduled",
                )
              }
            >
              Schedule
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
function DepositSection({
  lease,
  rows,
  options,
  permissions,
  busy,
  act,
  money,
}: any) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    kind: "received",
    occurredOn: today,
    amount: "",
    bankAccountId: "",
    offsetAccountId: "",
    appliedDocumentId: "",
    memo: "",
  });
  const [reverseRow, setReverseRow] = useState<any>(null);
  const [reversal, setReversal] = useState({
    occurredOn: today,
    reason: "",
  });
  const invoices = options.openInvoices.filter(
    (o: Option) => o.partyId === lease.tenantId,
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Small
          label="Required"
          value={money(lease.securityDepositRequired, {
            currency: lease.currency,
          })}
        />
        <Small
          label="Held"
          value={money(lease.depositBalance, { currency: lease.currency })}
        />
      </div>
      <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        Deposit entries post immediately and cannot be edited or deleted. Reverse an incorrect entry, then post its corrected replacement below.
      </div>
      {rows.length ? (
        <DepositTable
          deposits={rows}
          leases={[lease]}
          money={money}
          onReverse={permissions.account ? setReverseRow : undefined}
        />
      ) : (
        <Empty
          title="No deposit activity"
          detail="Record the receipt to establish the tenant deposit liability."
        />
      )}
      {reverseRow ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="space-y-3 p-4">
            <div>
              <div className="font-medium text-red-700 dark:text-red-300">Reverse deposit transaction</div>
              <p className="mt-1 text-xs text-slate-500">
                {reverseRow.occurredOn} · {reverseRow.kind.replaceAll("_", " ")} · {money(reverseRow.amount, { currency: lease.currency })}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reversal date">
                <Input type="date" value={reversal.occurredOn} onChange={(e) => setReversal({ ...reversal, occurredOn: e.target.value })} />
              </Field>
              <Field label="Reason">
                <Input value={reversal.reason} onChange={(e) => setReversal({ ...reversal, reason: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setReverseRow(null)}>Cancel</Button>
              <Button
                disabled={busy || !reversal.occurredOn || !reversal.reason.trim()}
                onClick={async () => {
                  const result = await act(
                    { action: "reverseDeposit", transactionId: reverseRow.id, ...reversal },
                    "Deposit transaction reversed",
                  );
                  if (result) {
                    setForm({
                      kind: reverseRow.kind,
                      occurredOn: reversal.occurredOn,
                      amount: reverseRow.amount,
                      bankAccountId: reverseRow.bankAccountId ?? "",
                      offsetAccountId: reverseRow.offsetAccountId ?? "",
                      appliedDocumentId: "",
                      memo: `Correction for ${reverseRow.occurredOn}`,
                    });
                    setReverseRow(null);
                    setReversal({ occurredOn: today, reason: "" });
                  }
                }}
              >
                Post reversal
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {permissions.account ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">Record deposit transaction</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Transaction">
                <Select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  <option value="received">Received</option>
                  <option value="interest">Interest credited</option>
                  <option value="applied">Apply to tenant invoice</option>
                  <option value="refunded">Refunded</option>
                  <option value="adjustment_increase">
                    Adjustment increase
                  </option>
                  <option value="adjustment_decrease">
                    Adjustment decrease
                  </option>
                </Select>
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={form.occurredOn}
                  onChange={(e) =>
                    setForm({ ...form, occurredOn: e.target.value })
                  }
                />
              </Field>
              <Field label="Amount">
                <Input
                  type="number"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              {["received", "refunded"].includes(form.kind) ? (
                <Field label="Bank account">
                  <Select
                    value={form.bankAccountId}
                    onChange={(e) =>
                      setForm({ ...form, bankAccountId: e.target.value })
                    }
                  >
                    <option value="">Property default</option>
                    {options.bankAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {form.kind === "applied" ? (
                <Field label="Tenant invoice">
                  <Select
                    value={form.appliedDocumentId}
                    onChange={(e) =>
                      setForm({ ...form, appliedDocumentId: e.target.value })
                    }
                  >
                    <option value="">Select posted invoice</option>
                    {invoices.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ·{" "}
                        {money(o.openBalance, { currency: lease.currency })}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {[
                "interest",
                "adjustment_increase",
                "adjustment_decrease",
              ].includes(form.kind) ? (
                <Field label="Offset account">
                  <Select
                    value={form.offsetAccountId}
                    onChange={(e) =>
                      setForm({ ...form, offsetAccountId: e.target.value })
                    }
                  >
                    <option value="">Select account</option>
                    {options.expenseAccounts.map((o: Option) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <div className="sm:col-span-2">
                <Field label="Memo">
                  <Input
                    value={form.memo}
                    onChange={(e) => setForm({ ...form, memo: e.target.value })}
                  />
                </Field>
              </div>
            </div>
            <Button
              size="sm"
              disabled={
                busy ||
                !form.amount ||
                (form.kind === "applied" && !form.appliedDocumentId)
              }
              onClick={() =>
                act(
                  {
                    action: "recordDeposit",
                    leaseId: lease.id,
                    ...form,
                    bankAccountId: form.bankAccountId || null,
                    offsetAccountId: form.offsetAccountId || null,
                    appliedDocumentId: form.appliedDocumentId || null,
                  },
                  "Deposit transaction posted",
                )
              }
            >
              Post transaction
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CamDrawer({
  open,
  stacked,
  initialPropertyId,
  pool,
  onClose,
  data,
  expenseAccounts,
  busy,
  onSave,
}: any) {
  const year = new Date().getUTCFullYear();
  const initial = {
    propertyId:
      pool?.propertyId ?? initialPropertyId ?? data.properties[0]?.id ?? "",
    name: pool?.name ?? "Operating expenses",
    fiscalYear: String(pool?.fiscalYear ?? year),
    periodStartsOn: pool?.periodStartsOn ?? `${year}-01-01`,
    periodEndsOn: pool?.periodEndsOn ?? `${year}-12-31`,
    allocationBasis: pool?.allocationBasis ?? "rentable_area",
    budgetAmount: pool?.budgetAmount ?? "",
    expenseAccountIds: (pool?.expenseAccountIds ?? []) as string[],
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, pool?.id, initialPropertyId, data.properties.length]);
  const submit = () => onSave({ ...form, fiscalYear: Number(form.fiscalYear) });
  return (
    <Drawer
      open={open}
      stacked={stacked}
      onClose={onClose}
      title={pool ? "Edit CAM pool" : "New CAM pool"}
      description="CAM actuals are read from posted GL lines on the property's location and selected expense accounts."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !form.propertyId ||
              !form.name ||
              !form.budgetAmount ||
              !form.expenseAccountIds.length
            }
            onClick={submit}
          >
            {busy ? "Saving…" : pool ? "Save CAM pool" : "Create CAM pool"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Property">
            <Select
              value={form.propertyId}
              disabled={!!initialPropertyId || !!pool}
              onChange={(e) => setForm({ ...form, propertyId: e.target.value })}
            >
              <option value="">Select property</option>
              {data.properties.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pool name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Fiscal year">
            <Input
              type="number"
              value={form.fiscalYear}
              onChange={(e) => setForm({ ...form, fiscalYear: e.target.value })}
            />
          </Field>
          <Field label="Allocation basis">
            <Select
              value={form.allocationBasis}
              onChange={(e) =>
                setForm({ ...form, allocationBasis: e.target.value })
              }
            >
              <option value="rentable_area">Rentable area</option>
              <option value="equal">Equal</option>
              <option value="custom">Lease CAM share</option>
            </Select>
          </Field>
          <Field label="Period starts">
            <Input
              type="date"
              value={form.periodStartsOn}
              onChange={(e) =>
                setForm({ ...form, periodStartsOn: e.target.value })
              }
            />
          </Field>
          <Field label="Period ends">
            <Input
              type="date"
              value={form.periodEndsOn}
              onChange={(e) =>
                setForm({ ...form, periodEndsOn: e.target.value })
              }
            />
          </Field>
          <Field label="Budget">
            <Input
              type="number"
              min="0"
              value={form.budgetAmount}
              onChange={(e) =>
                setForm({ ...form, budgetAmount: e.target.value })
              }
            />
          </Field>
        </div>
        <Field
          label="Recoverable expense accounts"
          hint="Only posted activity on these accounts and the property's location is included."
        >
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
            {expenseAccounts.map((o: Option) => (
              <label
                key={o.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <input
                  type="checkbox"
                  checked={form.expenseAccountIds.includes(o.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      expenseAccountIds: e.target.checked
                        ? [...form.expenseAccountIds, o.id]
                        : form.expenseAccountIds.filter((id) => id !== o.id),
                    })
                  }
                />
                {o.name}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Drawer>
  );
}

function CamCorrectionDrawer({
  open,
  stacked,
  pool,
  busy,
  onClose,
  onSave,
}: any) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open, pool?.id]);
  return (
    <Drawer
      open={open}
      stacked={stacked}
      onClose={onClose}
      title="Reopen CAM for correction"
      description={`${pool?.name ?? "CAM pool"} will return to open status and its calculated allocations will be removed.`}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !reason.trim()}
            onClick={() => onSave(reason)}
          >
            {busy ? "Reopening…" : "Reopen pool"}
          </Button>
        </>
      }
    >
      <div className="p-1">
        <Field
          label="Correction reason"
          hint="This explanation is written to the audit trail. Invoiced CAM pools cannot be reopened."
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why the finalized allocation needs to be recalculated"
          />
        </Field>
      </div>
    </Drawer>
  );
}
