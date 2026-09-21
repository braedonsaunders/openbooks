import {
  TAX_BASIS_FIELDS,
  attachTaxBasisSource,
  parseConsolidatedGroupMembership,
  taxBasisFieldVisible,
  taxBasisSideApplies,
  validateTaxRegimeBasis,
  type TaxBasisDraft,
  type TaxAssetBasisSourceChoice,
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
  source?: TaxAssetBasisSourceChoice,
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
  if (draft.regime === "us_macrs" && context.sourceOperation === "intercompany_transfer") {
    const membership = parseConsolidatedGroupMembership(draft.consolidatedGroupMembership);
    if (membership) {
      if (!source || source.sourceOperation !== "intercompany_transfer" ||
          !source.sellerSubsidiaryId || !source.buyerSubsidiaryId) {
        throw new Error("Reload the posted transfer to identify the seller and buyer before declaring consolidated group membership.");
      }
      if (membership.sellerSubsidiaryId !== source.sellerSubsidiaryId ||
          membership.buyerSubsidiaryId !== source.buyerSubsidiaryId) {
        throw new Error("Consolidated group membership must name the selected transfer's seller and buyer. Reselect the posted source and enter its membership evidence.");
      }
      // Structured declared evidence, unlike the derived matching result, must
      // survive the scalar field filter. The service checks identity again.
      Object.assign(supplied, { consolidatedGroupMembership: membership });
    }
  }
  const validated = validateTaxRegimeBasis(supplied, {
    ...context,
    sellerSubsidiaryId: source?.sellerSubsidiaryId ?? context.sellerSubsidiaryId,
    buyerSubsidiaryId: source !== undefined ? source.buyerSubsidiaryId : context.buyerSubsidiaryId,
  });
  // Validation also derives frozen receiver schedules and checkpoints. They
  // are server-owned results, not new operator declarations. Sending the
  // enriched object back would either fail the API's input schema or create
  // a competing source of financial facts. Preserve only the input keys;
  // the service reconstructs the derived values under its transaction locks.
  const declared = validated as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(supplied).map((key) => [key, declared[key]]),
  ) as unknown as TaxRegimeBasis;
}
