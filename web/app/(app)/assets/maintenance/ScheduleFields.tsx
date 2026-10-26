"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input, Label, Select } from "@openbooks/ui";
import type { MaintenanceData } from "./_data";
import { DateField } from "../../../../components/date-field";

export interface ScheduleFormValues {
  name: string;
  intervalMonths: string;
  intervalUsage: string;
  usageUnit: string;
  startsOn: string;
  leadDays: string;
  vendorPartyId: string;
  estimatedCost: string;
}

/** The schedule terms body both create and edit send. */
export function scheduleBody(values: ScheduleFormValues) {
  return {
    name: values.name,
    intervalMonths: values.intervalMonths.trim()
      ? Number.parseInt(values.intervalMonths, 10)
      : null,
    intervalUsage: values.intervalUsage.trim() || null,
    usageUnit: values.usageUnit.trim() || null,
    startsOn: values.startsOn,
    leadDays: values.leadDays.trim() ? Number.parseInt(values.leadDays, 10) : null,
    vendorPartyId: values.vendorPartyId || null,
    estimatedCost: values.estimatedCost.trim() || null,
  };
}

/** The schedule terms fields, shared by the new-schedule form and the schedule drawer. */
export function ScheduleFields({
  values,
  onChange,
  vendors,
  idPrefix,
}: {
  values: ScheduleFormValues;
  onChange: (patch: Partial<ScheduleFormValues>) => void;
  vendors: MaintenanceData["vendors"];
  idPrefix: string;
}) {
  const t = useTranslations("assets");
  const field = (key: keyof ScheduleFormValues, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-${key}`}>{label}</Label>
      {control}
    </div>
  );
  const input = (
    key: keyof ScheduleFormValues,
    props: { inputMode?: "numeric" | "decimal"; placeholder?: string } = {},
  ) => (
    <Input
      id={`${idPrefix}-${key}`}
      {...props}
      value={values[key]}
      onChange={(event) => onChange({ [key]: event.target.value })}
    />
  );
  const date = (key: keyof ScheduleFormValues) => (
    <DateField
      id={`${idPrefix}-${key}`}
      value={values[key]}
      onChange={(value) => onChange({ [key]: value })}
    />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field("name", t("maintenance.fields.name"), input("name"))}
      {field("startsOn", t("maintenance.fields.startsOn"), date("startsOn"))}
      {field(
        "intervalMonths",
        t("maintenance.fields.intervalMonths"),
        input("intervalMonths", { inputMode: "numeric" }),
      )}
      {field(
        "leadDays",
        t("maintenance.fields.leadDays"),
        input("leadDays", { inputMode: "numeric" }),
      )}
      {field(
        "intervalUsage",
        t("maintenance.fields.intervalUsage"),
        input("intervalUsage", { inputMode: "decimal" }),
      )}
      {field(
        "usageUnit",
        t("maintenance.fields.usageUnit"),
        input("usageUnit", { placeholder: t("maintenance.fields.usageUnitPlaceholder") }),
      )}
      {field(
        "vendorPartyId",
        t("maintenance.fields.vendor"),
        <Select
          id={`${idPrefix}-vendorPartyId`}
          value={values.vendorPartyId}
          onChange={(event) => onChange({ vendorPartyId: event.target.value })}
        >
          <option value="">{t("maintenance.fields.none")}</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </Select>,
      )}
      {field(
        "estimatedCost",
        t("maintenance.fields.estimatedCost"),
        input("estimatedCost", { inputMode: "decimal" }),
      )}
    </div>
  );
}
