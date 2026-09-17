"use client";

import { useTranslations } from "next-intl";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import type { ListViewConfig } from "@openbooks/customization";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { Empty, Status } from "./workspace-ui";
import type { PropertyRow, PropertyWorkspace } from "./types";

type ListColumn = ListViewConfig["columns"][number];

/** List column key to its translated header (F-t09-017). */
const COLUMN_LABEL_KEYS: Record<string, string> = {
  name: "list.columns.property",
  code: "list.columns.code",
  subsidiary: "list.columns.subsidiary",
  location: "list.columns.location",
  property_type: "list.columns.propertyType",
  occupancy: "list.columns.occupancy",
  currency: "list.columns.currency",
  status: "list.columns.status",
};

export function PropertiesTable({ data, view, fieldDefs, onOpen }: { data: PropertyWorkspace; view: ListViewConfig; fieldDefs: CustomFieldDefClient[]; onOpen: (id: string) => void }) {
  const t = useTranslations("entities.propertyManagement");
  const tc = useTranslations("customization");
  if (!data.properties.length)
    return (
      <Empty
        title={t("list.emptyTitle")}
        detail={t("list.emptyDetail")}
      />
    );
  const defs = new Map<string, CustomFieldDefClient>(
    fieldDefs.map((def: CustomFieldDefClient) => [def.key, def]),
  );
  const columns = view.columns.filter((column) => column.visible);
  const showsCodeColumn = columns.some((column) => column.key === "code");
  const label = (column: ListColumn) => {
    const override = column.labelOverride?.trim()
    if (override) return override
    if (column.key.startsWith("cf_")) {
      return defs.get(column.key.slice(3))?.label ?? column.key
    }
    const key = COLUMN_LABEL_KEYS[column.key]
    return (key ? t(key) : undefined) ?? column.key
  };
  // Enum cells resolve through the catalog with a raw fallback, so a future
  // enum value still renders instead of throwing on a missing key.
  const typeLabel = (value: string) => {
    const key = `property.types.${value}`;
    return tc.has(key) ? tc(key) : value.replaceAll("_", " ");
  };
  const statusLabel = (value: string) => {
    const key = `property.status.${value}`;
    return tc.has(key) ? tc(key) : undefined;
  };
  const cell = (property: PropertyRow, key: string) => {
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
    if (key === "location") return property.locationName || t("list.notMapped");
    if (key === "property_type")
      return <span>{typeLabel(property.propertyType)}</span>;
    if (key === "occupancy")
      return (
        <span className="tabular-nums">
          {property.occupiedUnits} / {property.unitCount}
        </span>
      );
    if (key === "currency")
      return <span className="font-mono text-xs">{property.currency}</span>;
    if (key === "status") return <Status value={property.status} label={statusLabel(property.status)} />;
    return "—";
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
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
        {data.properties.map((property) => (
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
            {columns.map((column) => (
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
