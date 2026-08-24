"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button, Card, CardContent, Drawer, Input, Popover, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openbooks/ui";
import { Empty, Field, Read, RecordTabs, Status } from "./workspace-ui";
import type { LeaseRow, PropertyRow, SaveAction, UnitRow } from "./types";

export function UnitRecordDrawer({
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
}: {
  unit: UnitRow | null;
  property: PropertyRow | null;
  leases: LeaseRow[];
  permissions: { manage: boolean };
  busy: boolean;
  onClose: () => void;
  onOpenLease: (id: string) => void;
  onAddLease: () => void;
  onSave: SaveAction;
  onDelete: () => void | Promise<void>;
}) {
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
  const activeLease = leases.some((lease) =>
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
                {leases.map((lease) => (
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

function unitForm(unit: Partial<UnitRow>) {
  return {
    code: unit.code ?? "",
    name: unit.name ?? "",
    unitType: unit.unitType ?? "",
    rentableArea: unit.rentableArea ?? "",
    bedrooms: unit.bedrooms == null ? "" : String(unit.bedrooms),
    status: unit.status ?? "vacant",
  };
}
