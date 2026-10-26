"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input, Label, Select } from "@openbooks/ui";
import { DateField } from "../../../../components/date-field";

export interface PolicyFormValues {
  insurerPartyId: string;
  policyNumber: string;
  description: string;
  coverageStartsOn: string;
  coverageEndsOn: string;
  premium: string;
  deductible: string;
  renewalLeadDays: string;
}

/** The policy terms body both create and edit send. */
export function policyBody(values: PolicyFormValues) {
  return {
    insurerPartyId: values.insurerPartyId,
    policyNumber: values.policyNumber,
    description: values.description.trim() || null,
    coverageStartsOn: values.coverageStartsOn,
    coverageEndsOn: values.coverageEndsOn,
    premium: values.premium.trim() || null,
    deductible: values.deductible.trim() || null,
    renewalLeadDays: values.renewalLeadDays.trim()
      ? Number.parseInt(values.renewalLeadDays, 10)
      : null,
  };
}

/** Policy terms fields shared by the new-policy form and the policy drawer. */
export function PolicyFields({
  values,
  onChange,
  insurers,
  idPrefix,
}: {
  values: PolicyFormValues;
  onChange: (patch: Partial<PolicyFormValues>) => void;
  insurers: { id: string; name: string }[];
  idPrefix: string;
}) {
  const t = useTranslations("assets");
  const field = (key: keyof PolicyFormValues, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-${key}`}>{label}</Label>
      {control}
    </div>
  );
  const input = (
    key: keyof PolicyFormValues,
    props: { inputMode?: "numeric" | "decimal" } = {},
  ) => (
    <Input
      id={`${idPrefix}-${key}`}
      {...props}
      value={values[key]}
      onChange={(event) => onChange({ [key]: event.target.value })}
    />
  );
  const date = (key: keyof PolicyFormValues) => (
    <DateField
      id={`${idPrefix}-${key}`}
      value={values[key]}
      onChange={(value) => onChange({ [key]: value })}
    />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field(
        "insurerPartyId",
        t("insurance.fields.insurer"),
        <Select
          id={`${idPrefix}-insurerPartyId`}
          value={values.insurerPartyId}
          onChange={(event) => onChange({ insurerPartyId: event.target.value })}
        >
          <option value="">{t("insurance.fields.choose")}</option>
          {insurers.map((insurer) => (
            <option key={insurer.id} value={insurer.id}>
              {insurer.name}
            </option>
          ))}
        </Select>,
      )}
      {field("policyNumber", t("insurance.fields.policyNumber"), input("policyNumber"))}
      {field("coverageStartsOn", t("insurance.fields.coverageStartsOn"), date("coverageStartsOn"))}
      {field("coverageEndsOn", t("insurance.fields.coverageEndsOn"), date("coverageEndsOn"))}
      {field("premium", t("insurance.fields.premium"), input("premium", { inputMode: "decimal" }))}
      {field(
        "deductible",
        t("insurance.fields.deductible"),
        input("deductible", { inputMode: "decimal" }),
      )}
      {field(
        "renewalLeadDays",
        t("insurance.fields.renewalLeadDays"),
        input("renewalLeadDays", { inputMode: "numeric" }),
      )}
      {field("description", t("insurance.fields.description"), input("description"))}
    </div>
  );
}
