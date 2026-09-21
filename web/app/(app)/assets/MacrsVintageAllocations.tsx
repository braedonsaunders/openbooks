"use client";

import { useId } from "react";
import { Input, Label } from "@openbooks/ui";
import { MACRS_VINTAGE_SOURCE_LABELS } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import {
  prepareMacrsVintageAllocations,
  type MacrsAllocationAmounts,
  type MacrsAllocationEdits,
  type OpenMacrsVintage,
} from "./macrs-vintage-allocation-draft";

/** The same native allocation controls as GroupValuationButton's dated plan,
 * inside TaxBasisButton's existing workpaper drawer. Sources are not editable. */
export function MacrsVintageAllocations({
  vintages,
  edits,
  disabled,
  onChange,
}: {
  vintages: readonly OpenMacrsVintage[];
  edits: MacrsAllocationEdits;
  disabled?: boolean;
  onChange: (
    key: string,
    field: keyof MacrsAllocationAmounts,
    value: string,
  ) => void;
}) {
  const prefix = useId();
  let totals: ReturnType<typeof prepareMacrsVintageAllocations> | undefined;
  let explanation =
    "Enter disposed and retained basis for every vintage to calculate the totals.";
  try {
    totals = prepareMacrsVintageAllocations(vintages, edits);
  } catch (error) {
    explanation = error instanceof Error ? error.message : explanation;
  }
  return (
    <fieldset className="space-y-4">
      <legend className="font-semibold">
        Allocate US tax depreciation vintages
      </legend>
      <p className="text-sm text-muted-foreground">
        Allocate each vintage between the disposed and retained portions. Enter
        0 for a portion with no basis. The totals below are calculated from
        these rows.
      </p>
      {vintages.map((vintage, index) => {
        const id = `${prefix}-${index}`;
        return (
          <fieldset
            key={vintage.key}
            className="space-y-3 rounded border p-3"
            disabled={disabled}
          >
            <legend className="px-1 text-sm font-medium">
              {MACRS_VINTAGE_SOURCE_LABELS[vintage.source]}
            </legend>
            <p className="text-sm">
              Placed in service {vintage.placedInServiceOn}
              {vintage.transferOn ? ` · Transferred ${vintage.transferOn}` : ""}
              {` · ${vintage.recoveryPeriodYears}-year ${vintage.method} / ${vintage.convention}`}
            </p>
            <p className="text-sm">
              Open unadjusted tax basis: {vintage.unadjustedBasis}
            </p>
            <p className="text-xs text-muted-foreground">
              Section 179: {vintage.section179} · Prior depreciation:{" "}
              {vintage.priorDepreciation ?? "Not supplied"} · Adjusted carryover
              checkpoint: {vintage.adjustedCarryover ?? "Not supplied"}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["disposedUnadjustedBasis", "Disposed unadjusted tax basis"],
                  ["remainingUnadjustedBasis", "Retained unadjusted tax basis"],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`${id}-${field}`}>{label} (required)</Label>
                  <Input
                    id={`${id}-${field}`}
                    inputMode="decimal"
                    required
                    disabled={disabled}
                    value={edits[vintage.key]?.[field] ?? ""}
                    onChange={(event) =>
                      onChange(vintage.key, field, event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}
      <div aria-live="polite" className="space-y-1 text-sm">
        {totals ? (
          <>
            <p>
              Total disposed unadjusted basis:{" "}
              <output>{totals.disposedUnadjustedBasis}</output>
            </p>
            <p>
              Total retained unadjusted basis:{" "}
              <output>{totals.remainingUnadjustedBasis}</output>
            </p>
          </>
        ) : (
          <p>{explanation}</p>
        )}
      </div>
    </fieldset>
  );
}
