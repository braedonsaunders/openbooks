import { toUnits } from "../money/money.ts";

/**
 * Native governed lifecycle (a posted financial change, or a partial /
 * transfer event) needs an approved tax workpaper. Legacy ordinary
 * `disposed` / `written_off` rows with financial_change_id NULL do not —
 * they keep the historical lesser-of-proceeds-and-capital-cost path.
 */
export function taxEventRequiresTaxWorkpaper(
  kind: string,
  financialChangeId: string | null | undefined,
): boolean {
  if (kind === "partially_disposed" || kind === "transferred") return true;
  return (kind === "disposed" || kind === "written_off") && financialChangeId != null;
}

/** Legacy pool reduction: lesser of recorded proceeds and the class ceiling. */
export function legacyPoolDisposition(proceeds: string | null | undefined, capitalCost: string): string {
  const amount = proceeds ?? "0";
  return toUnits(amount) <= toUnits(capitalCost) ? amount : capitalCost;
}
