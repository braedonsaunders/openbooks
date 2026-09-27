import { mulDecimalFactors, toUnits } from "../money/money.ts";

const FACTOR_SCALE = 10_000_000_000n;
const EXACT_SCALE = 100_000_000n * FACTOR_SCALE;

export interface BomRequiredQuantity {
  quantity: string;
  exactQuantity: string;
}

/** Exact factor applied to a BOM line to account for planned scrap. */
export function scrapFactor(scrapPct: string | null): string {
  const extra = scrapPct === null ? 0n : (toUnits(scrapPct) * FACTOR_SCALE) / 1_000_000n;
  const units = FACTOR_SCALE + extra;
  const padded = units.toString().padStart(11, "0");
  return `${padded.slice(0, -10)}.${padded.slice(-10)}`;
}

/** Round a BOM requirement to inventory precision and retain its exact evidence. */
export function bomRequiredQuantity(
  quantity: string,
  quantityPer: string,
  scrapPct: string | null,
): BomRequiredQuantity {
  const factor = scrapFactor(scrapPct);
  const quantityUnits = toUnits(quantity);
  const quantityPerUnits = toUnits(quantityPer);
  const factorUnits = BigInt(factor.replace(".", ""));
  const product = quantityUnits * quantityPerUnits * factorUnits;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const whole = absolute / EXACT_SCALE;
  const fraction = (absolute % EXACT_SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  const exactQuantity = fraction ? `${whole}.${fraction}` : `${whole}`;

  return {
    quantity: mulDecimalFactors(quantity, [quantityPer, factor]),
    exactQuantity: negative ? `-${exactQuantity}` : exactQuantity,
  };
}
