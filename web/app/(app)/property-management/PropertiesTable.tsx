"use client";

import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { Empty, Status } from "./workspace-ui";

export function PropertiesTable({ data, view, fieldDefs, onOpen }: any) {
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
