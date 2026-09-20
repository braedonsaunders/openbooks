import {
  TAX_BASIS_FIELDS,
  attachTaxBasisSource,
  taxBasisFieldVisible,
  taxBasisSideApplies,
  validateTaxRegimeBasis,
  type TaxBasisDraft,
  type TaxBasisSourceContext,
  type TaxRegimeBasis,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import type { prepareMacrsVintageAllocations } from "./macrs-vintage-allocation-draft";

/** Build the POST using the current source and visible statutory fields.
 * Explicit false and zero survive; old election inputs and UI context do not. */
export function prepareTaxBasisRegime(
  input: TaxBasisDraft,
  context: TaxBasisSourceContext,
  allocations?: ReturnType<typeof prepareMacrsVintageAllocations>,
): TaxRegimeBasis {
  const draft = attachTaxBasisSource(input, context);
  const supplied = Object.fromEntries(
    TAX_BASIS_FIELDS.filter(
      (field) =>
        taxBasisFieldVisible(field, draft) &&
        draft[field.name] !== "" &&
        draft[field.name] != null,
    ).map((field) => [field.name, draft[field.name]]),
  );
  if (allocations) {
    if (
      draft.regime !== "us_macrs" ||
      !taxBasisSideApplies(context.applicable, "seller")
    ) {
      throw new Error(
        "Vintage allocations belong to the seller's US tax depreciation. Reselect the posted source to load the applicable workpaper.",
      );
    }
    // Nested allocations are not scalar metadata fields. Preserve them and
    // their exact sums; do not let an earlier editable header override them.
    Object.assign(supplied, allocations);
  }
  return validateTaxRegimeBasis(supplied, context);
}
