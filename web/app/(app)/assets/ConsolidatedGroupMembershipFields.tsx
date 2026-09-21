"use client";

import { useId } from "react";
import { Input, Label, Select } from "@openbooks/ui";
import type {
  ConsolidatedGroupMembershipInput,
  TaxAssetBasisSourceChoice,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";

/** Same nested native controls as MacrsVintageAllocations, inside the existing
 * approval workpaper. Entity identity is supplied by the posted transfer. */
export function ConsolidatedGroupMembershipFields({
  source,
  value,
  disabled,
  onChange,
}: {
  source: TaxAssetBasisSourceChoice;
  value?: ConsolidatedGroupMembershipInput;
  disabled?: boolean;
  onChange: (value: ConsolidatedGroupMembershipInput | undefined) => void;
}) {
  const prefix = useId();
  if (source.sourceOperation !== "intercompany_transfer") return null;
  const missingEntities = !source.sellerSubsidiaryId || !source.buyerSubsidiaryId;
  return (
    <fieldset className="space-y-3 rounded border p-3" disabled={disabled}>
      <legend className="px-1 font-semibold">
        Consolidated income-tax group membership
      </legend>
      <p className="text-sm text-muted-foreground">
        Record the group and dates supported by your membership evidence.
        Membership, the intercompany gain or loss, and depreciation treatment
        are separate facts. This declaration does not extend beyond its end date.
      </p>
      <p className="text-sm">Seller: {source.subsidiaryLabel}</p>
      <p className="text-sm">
        Buyer: {source.receivingSubsidiaryLabel ?? "Unavailable — reload the posted source"}
      </p>
      {missingEntities ? (
        <p role="alert">
          The posted transfer has no complete legal-entity identity. Reload the
          source before declaring consolidated group membership.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-supplied`}>Membership evidence</Label>
        <Select
          id={`${prefix}-supplied`}
          value={value ? "record" : ""}
          disabled={disabled || missingEntities}
          onChange={(event) => onChange(event.target.value === "record" ? {
            groupKey: "",
            sellerSubsidiaryId: source.sellerSubsidiaryId,
            buyerSubsidiaryId: source.buyerSubsidiaryId!,
            effectiveOn: "",
            throughOn: "",
          } : undefined)}
        >
          <option value="">Not supplied</option>
          <option value="record">Record membership for these legal entities</option>
        </Select>
      </div>
      {value ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${prefix}-group`}>Income-tax consolidated group (required)</Label>
            <Input
              id={`${prefix}-group`}
              required
              value={value.groupKey}
              onChange={(event) => onChange({ ...value, groupKey: event.target.value })}
              aria-describedby={`${prefix}-group-help`}
            />
            <p id={`${prefix}-group-help`} className="text-xs text-muted-foreground">
              Use the group identity recorded in the supporting income-tax evidence.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-from`}>Membership starts (required)</Label>
            <Input
              id={`${prefix}-from`}
              type="date"
              required
              value={value.effectiveOn}
              onChange={(event) => onChange({ ...value, effectiveOn: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-through`}>Membership through (required)</Label>
            <Input
              id={`${prefix}-through`}
              type="date"
              required
              min={value.effectiveOn || undefined}
              value={value.throughOn}
              onChange={(event) => onChange({ ...value, throughOn: event.target.value })}
            />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No membership has been declared. Related-party status and a depreciation
          election do not supply this evidence.
        </p>
      )}
    </fieldset>
  );
}
