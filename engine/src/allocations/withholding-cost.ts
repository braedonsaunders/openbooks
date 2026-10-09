import { apportion, fromUnits, sum, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";

export class WithholdingMaterialsCostError extends Error {}
interface WithholdingCostLine {
  amount: string;
  withholdingTreatment?: "labour" | "materials" | "excluded" | null;
  withholdingMaterialsCost?: string | null;
}

/** Direct costs follow the actual child net amounts, preserving all four decimal places. */
export function apportionWithholdingMaterialsCost(cost: string | null | undefined, amounts: readonly string[]): (string | null | undefined)[] {
  if (cost == null) return amounts.map(() => cost);
  const exact = canonicalDecimal(cost, 4);
  if (exact === null) throw new WithholdingMaterialsCostError("Direct materials cost must be an exact decimal with at most four decimal places");
  const units = toUnits(exact);
  const weights = amounts.map(toUnits);
  const total = weights.reduce((a, b) => a + b, 0n);
  if (units < 0n || weights.some(w => w < 0n) || units > total) throw new WithholdingMaterialsCostError("Direct materials cost must be nonnegative and no greater than the net line amount; correct the cost before splitting the line",
  );
  if (total === 0n) return amounts.map(() => "0.0000");
  return apportion(units, weights).map(fromUnits);
}

/** Collapse is only defined for one treatment and a complete direct-cost allocation. */
export function collapseWithholdingLineMetadata(lines: readonly WithholdingCostLine[]): Pick<WithholdingCostLine, "withholdingTreatment" | "withholdingMaterialsCost"> {
  const treatment = lines[0]?.withholdingTreatment;
  if (lines.some(line => (line.withholdingTreatment ?? null) !== (treatment ?? null))) throw new WithholdingMaterialsCostError("Lines with different withholding treatments cannot be merged; keep the separate lines",
  );
  const costs = lines.map(line => line.withholdingMaterialsCost);
  if (costs.every(cost => cost == null)) return { withholdingTreatment: treatment, withholdingMaterialsCost: costs[0] };
  if (costs.some(cost => cost == null)) throw new WithholdingMaterialsCostError("Enter a direct materials cost on every split child before merging or regenerating this distribution",
  );
  costs.forEach((cost, index) => apportionWithholdingMaterialsCost(cost, [lines[index]!.amount]));
  return { withholdingTreatment: treatment, withholdingMaterialsCost: sum(costs as string[]) };
}

