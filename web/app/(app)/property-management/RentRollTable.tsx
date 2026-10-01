"use client";

import { useState } from "react";
import { Badge, Select, cn } from "@openbooks/ui";
import { PagedTable } from "../../../components/paged-table";
import { useBusinessToday } from "@/components/business-date-provider";
import { decimalCmp, decimalSum } from "../../../lib/statement-format";
import { Empty, Field, Status } from "./workspace-ui";
import type { LeaseRow, Money, PropertyRow, PropertyWorkspace, UnitRow } from "./types";

type RentRollRow = {
  key: string;
  property: PropertyRow | undefined;
  unit: UnitRow | null;
  lease: LeaseRow | null;
};

export function monthlyCharges(data: Pick<PropertyWorkspace, "charges">, lease: LeaseRow | null, today: string): string {
  if (!lease) return "0";
  const current = data.charges.filter((charge) =>
    charge.leaseId === lease.id && charge.frequency === "monthly" &&
    charge.effectiveFrom <= today && (!charge.effectiveTo || charge.effectiveTo >= today),
  );
  if (current.length) return decimalSum(current.map((charge) => charge.amount));
  return lease.status === "draft" ? lease.baseRent ?? "0" : "0";
}

export function pastDue(
  data: Pick<PropertyWorkspace, "schedules"> & Partial<Pick<PropertyWorkspace, "overdueByLease">>,
  lease: LeaseRow | null,
  today: string,
): string {
  if (!lease) return "0";
  // The server aggregates past-due balances over the complete set of posted
  // documents. The capped schedule preview below is only a fallback for
  // partial data: it drops older lines once the portfolio passes the preview
  // limit, so it must never be the source of a financial total.
  const aggregated = data.overdueByLease?.find((row) => row.leaseId === lease.id);
  if (aggregated) return aggregated.balance;
  if (data.overdueByLease) return "0";
  const invoices = new Map<string, string>();
  for (const line of data.schedules) {
    if (line.leaseId === lease.id && line.invoiceDocumentId &&
        line.invoiceStatus === "posted" && line.invoiceDueOn && line.invoiceDueOn < today) {
      invoices.set(line.invoiceDocumentId, line.invoiceOpenBalance ?? "0");
    }
  }
  return decimalSum([...invoices.values()]);
}

export function RentRollTable({ data, money, onOpenUnit, onOpenLease }: {
  data: PropertyWorkspace;
  money: Money;
  onOpenUnit: (id: string) => void;
  onOpenLease: (id: string) => void;
}) {
  const today = useBusinessToday();
  const operatingLeases = data.leases.filter((lease) =>
    ["active", "notice"].includes(lease.status),
  );
  const occupiedUnitIds = new Set(
    operatingLeases
      .map((lease) => lease.unitId)
      .filter((id: unknown): id is string => typeof id === "string"),
  );
  const draftByUnit = new Map<string, LeaseRow>();
  for (const lease of data.leases) {
    if (lease.status === "draft" && lease.unitId && !draftByUnit.has(lease.unitId))
      draftByUnit.set(lease.unitId, lease);
  }
  const rows: RentRollRow[] = [
    ...operatingLeases.filter((lease) => lease.unitId).map((lease) => ({
      key: `lease:${lease.id}`,
      property: data.properties.find((item) => item.id === lease.propertyId),
      unit: data.units.find((item) => item.id === lease.unitId) ?? null,
      lease,
    })),
    ...data.units
      .filter((unit) => !occupiedUnitIds.has(unit.id))
      .map((unit) => ({
        key: `unit:${unit.id}`,
        property: data.properties.find((item) => item.id === unit.propertyId),
        unit,
        lease: draftByUnit.get(unit.id) ?? null,
      })),
    ...data.leases
      .filter((lease) =>
        !lease.unitId && ["active", "notice", "draft"].includes(lease.status),
      )
      .map((lease) => ({
        key: `lease:${lease.id}`,
        property: data.properties.find((item) => item.id === lease.propertyId),
        unit: null,
        lease,
      })),
  ].sort((a, b) =>
    `${a.property?.name ?? ""}:${a.unit?.code ?? ""}:${a.lease?.leaseNumber ?? ""}`.localeCompare(
      `${b.property?.name ?? ""}:${b.unit?.code ?? ""}:${b.lease?.leaseNumber ?? ""}`,
    ),
  );
  const rowStatus = (row: RentRollRow) => row.lease?.status ?? row.unit?.status ?? "vacant";
  // The shared table owns text search and paging; the property/status facets
  // stay as toolbar selects narrowing the collection before it reaches the
  // table, exactly as the previous hand-rolled filter did.
  const [propertyId, setPropertyId] = useState("all");
  const [status, setStatus] = useState("all");
  const scoped = rows.filter((row) => {
    if (propertyId !== "all" && row.property?.id !== propertyId) return false;
    if (status !== "all" && rowStatus(row) !== status) return false;
    return true;
  });
  const searchText = (row: RentRollRow) =>
    [row.property?.name, row.property?.code, row.unit?.code, row.unit?.name,
      row.lease?.leaseNumber, row.lease?.tenantName]
      .map((value) => String(value ?? ""))
      .join(" ");
  const open = (row: RentRollRow) => {
    if (row.lease) onOpenLease(row.lease.id);
    else if (row.unit) onOpenUnit(row.unit.id);
  };
  return (
    <div className="min-w-0">
      <PagedTable
        source="property_rent_roll"
        rows={scoped}
        rowKey={(row) => row.key}
        searchable
        onRowClick={open}
        rowRole="button"
        empty={<Empty title="No rent-roll rows match" detail="Adjust the search, property, or status filters." />}
        toolbarAfter={(
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Property">
              <Select className="sm:w-56" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
                <option value="all">All properties</option>
                {data.properties.map((property) => (
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
            <p className="pb-2 text-xs text-slate-500">
              Historical leases stay on each property
            </p>
          </div>
        )}
        columns={[
          {
            key: "property",
            header: "Property / unit",
            cell: (row) => (
              <>
                <div className="font-medium">{row.property?.name ?? "—"}</div>
                <div className="text-xs text-slate-500">
                  {row.unit?.code ?? "Whole property"}{row.unit?.name ? ` · ${row.unit.name}` : ""}
                </div>
              </>
            ),
            search: searchText,
          },
          {
            key: "tenant",
            header: "Tenant / lease",
            cell: (row) => (
              <>
                <div>{row.lease?.tenantName ?? "No tenant"}</div>
                <div className="font-mono text-xs text-slate-500">{row.lease?.leaseNumber ?? "Available"}</div>
              </>
            ),
            search: searchText,
          },
          {
            key: "term",
            header: "Term",
            cell: (row) => (
              <span className="whitespace-nowrap text-xs">
                {row.lease ? `${row.lease.startsOn} – ${row.lease.endsOn || "Open"}` : "—"}
              </span>
            ),
          },
          { key: "status", header: "Status", cell: (row) => <Status value={rowStatus(row)} /> },
          {
            key: "charges",
            header: "Monthly charges",
            align: "right",
            cell: (row) => row.lease ? money(monthlyCharges(data, row.lease, today), { currency: row.lease.currency }) : "—",
          },
          {
            key: "deposit",
            header: "Deposit held",
            align: "right",
            cell: (row) => row.lease ? money(row.lease.depositBalance ?? 0, { currency: row.lease.currency }) : "—",
          },
          {
            key: "pastDue",
            header: "Past due",
            align: "right",
            cell: (row) => {
              const overdueAmount = pastDue(data, row.lease, today);
              return (
                <span className={cn(decimalCmp(overdueAmount, "0") > 0 && "font-medium text-red-600")}>
                  {row.lease ? money(overdueAmount, { currency: row.lease.currency }) : "—"}
                </span>
              );
            },
          },
          {
            key: "billing",
            header: "Billing",
            cell: (row) => row.lease ? (
              <Badge variant={row.lease.autoInvoice ? "success" : "secondary"}>
                {row.lease.autoInvoice ? "Automatic" : "Manual"}
              </Badge>
            ) : "—",
          },
        ]}
      />
    </div>
  );
}
