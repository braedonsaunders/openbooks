import {
  MACRS_VINTAGE_SOURCE_LABELS,
  parseMacrsVintageAllocations,
  type MacrsVintageAllocationInput,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import type { listOpenMacrsVintages } from "@openbooks/engine/src/tax-returns/macrs-vintages.ts";
import { canonicalDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";
import { add, cmp, sum } from "@openbooks/engine/src/money/money.ts";
import { decimalNullRefusal } from "@/lib/payroll-decimal-refusal";

export type OpenMacrsVintage = ReturnType<typeof listOpenMacrsVintages>[number];
export type MacrsAllocationAmounts = Pick<
  MacrsVintageAllocationInput,
  "disposedUnadjustedBasis" | "remainingUnadjustedBasis"
>;
export type MacrsAllocationEdits = Readonly<
  Record<string, MacrsAllocationAmounts>
>;

/** Identities come only from the selected server source. Do not copy an old
 * draft's identities into a newly selected source, or infer a split by value. */
export function prepareMacrsVintageAllocations(
  vintages: readonly OpenMacrsVintage[],
  edits: MacrsAllocationEdits,
): {
  vintageAllocations: MacrsVintageAllocationInput[];
  disposedUnadjustedBasis: string;
  remainingUnadjustedBasis: string;
} {
  if (vintages.length === 0) {
    throw new Error(
      "No open tax depreciation vintages were supplied. Reload the source before allocating its basis.",
    );
  }
  const keys = new Set(vintages.map((vintage) => vintage.key));
  if (
    keys.size !== vintages.length ||
    Object.keys(edits).some((key) => !keys.has(key))
  ) {
    throw new Error(
      "The allocation rows no longer match the selected source. Reload it and enter the allocation for its current vintages.",
    );
  }
  const vintageAllocations = parseMacrsVintageAllocations(
    vintages.map((vintage) => {
      const amounts = edits[vintage.key];
      const description = `${MACRS_VINTAGE_SOURCE_LABELS[vintage.source]} (${vintage.placedInServiceOn}${vintage.transferOn ? `, transferred ${vintage.transferOn}` : ""})`;
      for (const [field, label] of [
        ["disposedUnadjustedBasis", "Disposed unadjusted tax basis"],
        ["remainingUnadjustedBasis", "Retained unadjusted tax basis"],
      ] as const) {
        const value = amounts?.[field];
        if (value == null || value.trim() === "") {
          throw new Error(
            `${description}: enter ${label.toLowerCase()}; enter 0 if none belongs to this portion.`,
          );
        }
        if (canonicalDecimal(value, 4) == null) {
          throw new Error(
            decimalNullRefusal(
              `${description}: ${label}`,
              "an exact amount",
              value,
              4,
            ),
          );
        }
        if (cmp(value, "0") < 0) {
          throw new Error(
            `${description}: ${label} cannot be negative. Enter the nonnegative basis allocated to this portion.`,
          );
        }
      }
      if (
        cmp(
          add(
            amounts!.disposedUnadjustedBasis,
            amounts!.remainingUnadjustedBasis,
          ),
          vintage.unadjustedBasis,
        ) !== 0
      ) {
        throw new Error(
          `${description}: disposed and retained basis must add to the open unadjusted tax basis ${vintage.unadjustedBasis}. Correct this vintage's allocation.`,
        );
      }
      return {
        source: vintage.source,
        placedInServiceOn: vintage.placedInServiceOn,
        ...(vintage.transferOn ? { transferOn: vintage.transferOn } : {}),
        ...(vintage.parentKey ? { parentKey: vintage.parentKey } : {}),
        disposedUnadjustedBasis: amounts!.disposedUnadjustedBasis,
        remainingUnadjustedBasis: amounts!.remainingUnadjustedBasis,
      };
    }),
  );
  return {
    vintageAllocations,
    disposedUnadjustedBasis: sum(
      vintageAllocations.map((row) => row.disposedUnadjustedBasis),
    ),
    remainingUnadjustedBasis: sum(
      vintageAllocations.map((row) => row.remainingUnadjustedBasis),
    ),
  };
}
