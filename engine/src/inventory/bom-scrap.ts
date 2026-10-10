import { fitsLedgerRange, fromUnits, mulDecimalFactors, roundDiv, toUnits } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";

const FACTOR_SCALE = 10_000_000_000n;
const EXACT_SCALE = 100_000_000n * FACTOR_SCALE;

export interface BomRequiredQuantity {
  quantity: string;
  exactQuantity: string;
  /** Formula ratios may repeat in decimal; this retains their exact, unrounded fraction. */
  fraction?: {numerator:string;denominator:string};
}
export type BomQuantityBasis="per_unit"|"per_batch"|"per_formula";
export interface BomQuantityPolicy {quantityBasis?:BomQuantityBasis;formulaOutputQuantity?:string}
export function bomQuantityPolicy(input:BomQuantityPolicy):Required<BomQuantityPolicy> {
  const quantityBasis=input.quantityBasis??'per_unit',formulaOutputQuantity=input.formulaOutputQuantity??'1';
  if (!['per_unit','per_batch','per_formula'].includes(quantityBasis) || typeof formulaOutputQuantity!=='string' || !/^\d+(?:\.\d{1,4})?$/.test(formulaOutputQuantity) || !fitsLedgerRange(formulaOutputQuantity) || toUnits(formulaOutputQuantity)<=0n) throw new InventoryError("Choose a recipe quantity basis and a positive exact formula output quantity.");
  if(quantityBasis!=='per_formula'&&toUnits(formulaOutputQuantity)!==10_000n) throw new InventoryError("Only formula quantities use an output denominator; use one for unit and batch quantities.");
  return {quantityBasis,formulaOutputQuantity};
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
  policy:BomQuantityPolicy = {},
): BomRequiredQuantity {
  const {quantityBasis,formulaOutputQuantity}=bomQuantityPolicy(policy);
  if(quantityBasis!=='per_unit') {
    const factorUnits=BigInt(scrapFactor(scrapPct).replace('.',''));
    const quantityUnits=toUnits(quantity),perUnits=toUnits(quantityPer);
    if(quantityUnits<0n||perUnits<0n) throw new InventoryError("Recipe requirements cannot be negative.");
    const numerator=quantityBasis==='per_batch' ? (quantityUnits===0n?0n:perUnits)*factorUnits : quantityUnits*perUnits*factorUnits;
    const denominator=quantityBasis==='per_batch' ? FACTOR_SCALE : toUnits(formulaOutputQuantity)*FACTOR_SCALE;
    const rounded=fromUnits(roundDiv(numerator,denominator));
    if(!fitsLedgerRange(rounded)) throw new InventoryError("The recipe requirement exceeds inventory quantity precision.");
    // Forty places bound the smallest positive supported input ratio; the exact fraction remains authoritative.
    const display=numerator*10n**40n/(denominator*10_000n),padded=display.toString().padStart(41,'0');
    const exactQuantity=padded.slice(0,-40)+'.'+padded.slice(-40).replace(/0+$/,'');
    return {quantity:rounded,exactQuantity:exactQuantity.endsWith('.')?exactQuantity.slice(0,-1):exactQuantity,fraction:{numerator:numerator.toString(),denominator:(denominator*10_000n).toString()}};
  }
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
