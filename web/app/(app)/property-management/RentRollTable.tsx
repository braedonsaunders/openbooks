"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Badge, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { Empty, Field, Status } from "./workspace-ui";

export function RentRollTable({ data, money, onOpenUnit, onOpenLease }: any) {
  const [query, setQuery] = useState("");
  const [propertyId, setPropertyId] = useState("all");
  const [status, setStatus] = useState("all");
  const today = useBusinessToday();
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
