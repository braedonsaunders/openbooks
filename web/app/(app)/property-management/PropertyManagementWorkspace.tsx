"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  Input,
  Label,
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
import { useMoney } from "@/components/money-provider";

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
type Tab = "properties" | "leases" | "rent" | "deposits" | "cam";
type LeaseTab = "overview" | "charges" | "escalations" | "deposits";
type ActionPayload = Record<string, unknown>;
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
  };
}) {
  const { money } = useMoney();
  const [data, setData] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("properties");
  const [createProperty, setCreateProperty] = useState(false);
  const [unitPropertyId, setUnitPropertyId] = useState<string | null>(null);
  const [createLease, setCreateLease] = useState(false);
  const [selectedLeaseId, setSelectedLeaseId] = useState<string | null>(null);
  const [leaseTab, setLeaseTab] = useState<LeaseTab>("overview");
  const [createCam, setCreateCam] = useState(false);

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
        />
        <Metric
          label="Monthly base rent"
          value={money(monthlyRent)}
          hint="Current active charges"
        />
        <Metric
          label="Rent billed past due"
          value={money(overdue)}
          hint="Invoice schedule aging"
          tone={overdue > 0 ? "danger" : undefined}
        />
        <Metric
          label="Security deposits held"
          value={money(depositsHeld)}
          hint="Tenant deposit liability"
        />
      </section>

      <Card className="min-w-0 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col items-stretch justify-between gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center dark:border-slate-800">
            <nav
              className="flex min-w-0 overflow-x-auto"
              role="tablist"
              aria-label="Property management sections"
            >
              {(
                ["properties", "leases", "rent", "deposits", "cam"] as Tab[]
              ).map((key) => (
                <button
                  type="button"
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium capitalize",
                    tab === key
                      ? "bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200"
                      : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900",
                  )}
                >
                  {key}
                </button>
              ))}
            </nav>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {tab === "properties" && permissions.manage ? (
                <Button onClick={() => setCreateProperty(true)}>
                  New property
                </Button>
              ) : null}
              {tab === "leases" && permissions.manage ? (
                <Button onClick={() => setCreateLease(true)}>New lease</Button>
              ) : null}
              {tab === "rent" && permissions.bill && permissions.bulk ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act({ action: "assessLateFees" }, "Late fees assessed")
                    }
                  >
                    Assess late fees
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act({ action: "billRent" }, "Due rent billed")
                    }
                  >
                    Bill due rent
                  </Button>
                </>
              ) : null}
              {tab === "cam" && permissions.manage ? (
                <Button onClick={() => setCreateCam(true)}>New CAM pool</Button>
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
              money={money}
              canManage={permissions.manage}
              onAddUnit={setUnitPropertyId}
            />
          ) : tab === "leases" ? (
            <LeasesTable
              leases={data.leases}
              money={money}
              onOpen={(id: string) => {
                setSelectedLeaseId(id);
                setLeaseTab("overview");
              }}
            />
          ) : tab === "rent" ? (
            <RentTable
              schedules={data.schedules}
              leases={data.leases}
              money={money}
            />
          ) : tab === "deposits" ? (
            <DepositTable
              deposits={data.deposits}
              leases={data.leases}
              money={money}
            />
          ) : (
            <CamTable
              data={data}
              money={money}
              busy={busy}
              permissions={permissions}
              act={act}
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
      <LeaseDrawer
        open={createLease}
        onClose={() => setCreateLease(false)}
        data={data}
        tenants={options.tenants}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createLease", ...payload },
            "Lease created",
          );
          if (result?.id) {
            setCreateLease(false);
            setSelectedLeaseId(result.id);
          }
        }}
      />
      <CamDrawer
        open={createCam}
        onClose={() => setCreateCam(false)}
        data={data}
        expenseAccounts={options.expenseAccounts}
        busy={busy}
        onSave={async (payload: ActionPayload) => {
          const result = await act(
            { action: "createCamPool", ...payload },
            "CAM pool created",
          );
          if (result) setCreateCam(false);
        }}
      />
      <Drawer
        open={!!selectedLease}
        onClose={() => setSelectedLeaseId(null)}
        size="2xl"
        title={selectedLease ? `Lease ${selectedLease.leaseNumber}` : "Lease"}
        description={
          selectedLease
            ? `${selectedLease.propertyName}${selectedLease.unitCode ? ` · ${selectedLease.unitCode}` : ""} · ${selectedLease.tenantName}`
            : ""
        }
      >
        {selectedLease ? (
          <LeaseDetail
            lease={selectedLease}
            data={data}
            options={options}
            permissions={permissions}
            busy={busy}
            tab={leaseTab}
            setTab={setLeaseTab}
            act={act}
            money={money}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "danger";
}) {
  return (
    <Card
      className={cn(
        "min-w-0 overflow-hidden",
        tone === "danger" && "border-red-200 dark:border-red-900",
      )}
    >
      <CardContent className="min-w-0 p-4">
        <div className="truncate text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </div>
        <div
          title={value}
          className={cn(
            "mt-1 truncate text-xl font-semibold tabular-nums",
            tone === "danger" && "text-red-600 dark:text-red-400",
          )}
        >
          {value}
        </div>
        <div className="mt-1 truncate text-xs text-slate-500">{hint}</div>
      </CardContent>
    </Card>
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

function PropertiesTable({ data, money, canManage, onAddUnit }: any) {
  if (!data.properties.length)
    return (
      <Empty
        title="No properties yet"
        detail="Create the first property, connect its accounting dimensions, then add rentable units."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Property</TableHead>
          <TableHead>Entity</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Occupancy</TableHead>
          <TableHead>Status</TableHead>
          {canManage ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.properties.map((property: any) => (
          <TableRow key={property.id}>
            <TableCell>
              <div className="font-medium">
                {property.code} · {property.name}
              </div>
              <div className="text-xs text-slate-500">{property.currency}</div>
            </TableCell>
            <TableCell>{property.subsidiaryName}</TableCell>
            <TableCell>{property.locationName || "Not mapped"}</TableCell>
            <TableCell className="capitalize">
              {property.propertyType.replaceAll("_", " ")}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {property.occupiedUnits} / {property.unitCount}
            </TableCell>
            <TableCell>
              <Status value={property.status} />
            </TableCell>
            {canManage ? (
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAddUnit(property.id)}
                >
                  Add unit
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
function DepositTable({ deposits, leases, money }: any) {
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
                <Status value={row.kind} />
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
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
function CamTable({ data, money, busy, permissions, act }: any) {
  if (!data.camPools.length)
    return (
      <Empty
        title="No CAM pools yet"
        detail="Create an annual operating-expense pool, allocate actual GL costs, and invoice tenant true-ups."
      />
    );
  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {data.camPools.map((pool: any) => {
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

function LeaseDrawer({ open, onClose, data, tenants, busy, onSave }: any) {
  const today = new Date().toISOString().slice(0, 10);
  const initial = {
    propertyId: data.properties[0]?.id ?? "",
    unitId: "",
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
    if (open) setForm({ ...initial, propertyId: data.properties[0]?.id ?? "" });
  }, [open, data.properties.length]);
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

function LeaseDetail({
  lease,
  data,
  options,
  permissions,
  busy,
  tab,
  setTab,
  act,
  money,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status value={lease.status} />
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
      <nav
        className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
        role="tablist"
        aria-label="Lease details"
      >
        {(["overview", "charges", "escalations", "deposits"] as LeaseTab[]).map(
          (key) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
                tab === key
                  ? "border-teal-600 text-teal-700"
                  : "border-transparent text-slate-500",
              )}
            >
              {key}
            </button>
          ),
        )}
      </nav>
      {tab === "overview" ? (
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
      {rows.length ? (
        <DepositTable deposits={rows} leases={[lease]} money={money} />
      ) : (
        <Empty
          title="No deposit activity"
          detail="Record the receipt to establish the tenant deposit liability."
        />
      )}
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
  onClose,
  data,
  expenseAccounts,
  busy,
  onSave,
}: any) {
  const year = new Date().getUTCFullYear();
  const initial = {
    propertyId: data.properties[0]?.id ?? "",
    name: "Operating expenses",
    fiscalYear: String(year),
    periodStartsOn: `${year}-01-01`,
    periodEndsOn: `${year}-12-31`,
    allocationBasis: "rentable_area",
    budgetAmount: "",
    expenseAccountIds: [] as string[],
  };
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm({ ...initial, propertyId: data.properties[0]?.id ?? "" });
  }, [open, data.properties.length]);
  const submit = () => onSave({ ...form, fiscalYear: Number(form.fiscalYear) });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New CAM pool"
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
            {busy ? "Creating…" : "Create CAM pool"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Property">
            <Select
              value={form.propertyId}
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
