import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { InventoryError } from "./contracts.ts";

/**
 * Inventory costing — the pure, exact math behind the subledger. Quantities and
 * costs are numeric(19,4) decimal strings; all arithmetic runs in BigInt units
 * (scale 1e4) so a receipt→issue round-trip never loses or invents a cent.
 *
 * Three methods, matching the item's costing profile:
 *  - FIFO: layered — an issue consumes the oldest layers first, at their cost.
 *  - Moving average: value-based — cost carries at Σvalue / Σqty, tracked as
 *    total value (not a rounded average) so it stays exact.
 *  - Standard: every movement is at the item's standard cost; the difference
 *    to actual on receipt is a purchase price variance.
 *
 * The DB engine (the operation modules in engine/src/inventory/) turns these
 * results into cost-layer rows and balanced journal entries through the kernel.
 */

const SCALE = 10_000n;

/** Round-half-up multiply of two numeric(19,4) values → numeric(19,4) units. */
function mulUnits(a: bigint, b: bigint): bigint {
  const product = a * b; // scaled 1e8
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + SCALE / 2n) / SCALE; // back to 1e4
  return negative ? -rounded : rounded;
}

/** Round-half-up divide numeric(19,4) value by a numeric(19,4) quantity. */
function divUnits(value: bigint, qty: bigint): bigint {
  if (qty === 0n) return 0n;
  const num = value * SCALE; // 1e8
  const negative = num < 0n !== qty < 0n;
  const absNum = num < 0n ? -num : num;
  const absQty = qty < 0n ? -qty : qty;
  const rounded = (absNum + absQty / 2n) / absQty;
  return negative ? -rounded : rounded;
}

/** Exact q × unitCost as a decimal string (both numeric(19,4)). */
export function extendCost(quantity: string, unitCost: string): string {
  return fromUnits(mulUnits(toUnits(quantity), toUnits(unitCost)));
}

/** Represent an exact carried value with at most two adjacent 4dp rates. */
export function exactCostFragments(quantity: string, value: string, sourceUnitCost?: string): { quantity: string; unitCost: string }[] {
  const q = toUnits(quantity);
  const v = toUnits(value);
  if (q <= 0n || v < 0n) throw new Error("exact inventory layers require positive quantity and non-negative value");
  if (sourceUnitCost !== undefined && toUnits(extendCost(quantity, sourceUnitCost)) === v) {
    return [{ quantity: fromUnits(q), unitCost: sourceUnitCost }];
  }
  const lowRate = (v * SCALE) / q;
  const lowValue = mulUnits(q, lowRate);
  if (lowValue === v) return [{ quantity: fromUnits(q), unitCost: fromUnits(lowRate) }];
  const highRate = lowRate + 1n;
  if (mulUnits(q, highRate) === v) return [{ quantity: fromUnits(q), unitCost: fromUnits(highRate) }];
  // One whole unit at the adjacent rate adds exactly one 4dp money unit.
  // The high-rate fragment has integral quantity, so splitting the low-rate
  // extension introduces no additional rounding. An unrepresentable single
  // rate implies 0 < highQuantity < q (fractions <= one unit need no split).
  const highQuantity = (v - lowValue) * SCALE;
  if (highQuantity <= 0n || highQuantity >= q) throw new Error("inventory value cannot be represented exactly");
  return [
    { quantity: fromUnits(q - highQuantity), unitCost: fromUnits(lowRate) },
    { quantity: fromUnits(highQuantity), unitCost: fromUnits(highRate) },
  ];
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/**
 * Convert a quantity in `unit` to base units using the item's conversion map
 * (base units per unit, e.g. { box: 12, pallet: 720 }). A line raised in the
 * base unit (or with no unit) needs no conversion. Anything else MUST name a
 * positive, exactly-representable factor: silently treating an unknown unit
 * as 1:1 received "2 box @ $240" as 2 each @ $120 instead of 24 each @ $10,
 * so the unknown case refuses with the remedy (raise the line in the base
 * unit, or configure the conversion on the item's costing profile).
 */
export function toBaseQuantity(
  quantity: string,
  unit: string | null | undefined,
  conversions: Record<string, number>,
  baseUnit: string,
  lineLabel = "inventory line",
): string {
  if (!unit || unit === baseUnit) return fromUnits(toUnits(quantity));
  const factor: unknown = conversions[unit];
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    throw new InventoryError(
      `${lineLabel} is raised in unit "${unit}" with no conversion to the item's base unit "${baseUnit}" — ` +
        `enter the quantity in ${baseUnit}, or configure a conversion for "${unit}" on the item's costing profile`,
    );
  }
  const exact = canonicalDecimal(String(factor), 4);
  if (exact === null) {
    throw new InventoryError(
      `${lineLabel} unit "${unit}" converts at ${factor} ${baseUnit} per ${unit}, which cannot be expressed exactly — ` +
        `configure an exact conversion on the item's costing profile`,
    );
  }
  return fromUnits(mulUnits(toUnits(quantity), toUnits(exact)));
}

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

export interface CostLayer {
  id: string;
  /** remaining quantity on the layer, numeric(19,4) decimal string. */
  remaining: string;
  /** layer unit cost, numeric(19,4) decimal string. */
  unitCost: string;
}

export interface LayerConsumption {
  layerId: string;
  quantity: string;
  unitCost: string;
  cost: string;
}

export interface FifoResult {
  consumptions: LayerConsumption[];
  totalCost: string;
  /** quantity that exceeded available layers (stock went negative). */
  shortfallQuantity: string;
  /** cost booked for the shortfall (at fallbackUnitCost). */
  shortfallCost: string;
}

/**
 * Consume `quantity` from `layers` (oldest first) at each layer's cost. If the
 * layers run out, the remainder is a shortfall costed at `fallbackUnitCost`
 * (the item's last/standard cost) — perpetual inventory may go negative, and
 * the caller books that against a to-be-trued-up layer. `quantity` must be > 0.
 */
export function consumeFifo(layers: CostLayer[], quantity: string, fallbackUnitCost: string): FifoResult {
  let need = toUnits(quantity);
  if (need <= 0n) {
    return { consumptions: [], totalCost: "0", shortfallQuantity: "0", shortfallCost: "0" };
  }
  const consumptions: LayerConsumption[] = [];
  let totalCostUnits = 0n;

  for (const layer of layers) {
    if (need <= 0n) break;
    const avail = toUnits(layer.remaining);
    if (avail <= 0n) continue;
    const take = avail < need ? avail : need;
    const cu = toUnits(layer.unitCost);
    // Consume the reduction in the stored layer value. Rounding take × rate
    // independently can create/destroy a money unit on fractional withdrawals.
    const cost = mulUnits(avail, cu) - mulUnits(avail - take, cu);
    consumptions.push({
      layerId: layer.id,
      quantity: fromUnits(take),
      unitCost: layer.unitCost,
      cost: fromUnits(cost),
    });
    totalCostUnits += cost;
    need -= take;
  }

  let shortfallQuantity = "0";
  let shortfallCost = "0";
  if (need > 0n) {
    const fu = toUnits(fallbackUnitCost);
    const sc = mulUnits(need, fu);
    shortfallQuantity = fromUnits(need);
    shortfallCost = fromUnits(sc);
    totalCostUnits += sc;
  }

  return {
    consumptions,
    totalCost: fromUnits(totalCostUnits),
    shortfallQuantity,
    shortfallCost,
  };
}

// ---------------------------------------------------------------------------
// Moving average (value-based, exact)
// ---------------------------------------------------------------------------

export interface MovingAverageState {
  /** quantity on hand, numeric(19,4). */
  quantity: string;
  /** total inventory value on hand, numeric(19,4). */
  value: string;
}

/** Receive into a moving-average pool: value and quantity both grow. */
export function receiveMovingAverage(state: MovingAverageState, quantity: string, unitCost: string): MovingAverageState {
  const q = toUnits(state.quantity) + toUnits(quantity);
  const v = toUnits(state.value) + mulUnits(toUnits(quantity), toUnits(unitCost));
  return { quantity: fromUnits(q), value: fromUnits(v) };
}

export interface MovingAverageIssue {
  cost: string;
  /** the pool state after the issue. */
  state: MovingAverageState;
  /** unit cost used (value/qty at issue time), for the movement record. */
  unitCost: string;
}

/**
 * Issue from a moving-average pool at the current average (value / qty). Cost is
 * value-proportional so the remaining value never drifts. Issuing the entire
 * quantity drains the value to exactly zero.
 */
export function issueMovingAverage(state: MovingAverageState, quantity: string): MovingAverageIssue {
  const onQty = toUnits(state.quantity);
  const onVal = toUnits(state.value);
  const issQty = toUnits(quantity);
  let costUnits: bigint;
  if (onQty === issQty) {
    costUnits = onVal; // draining the pool: take all remaining value exactly
  } else if (onQty <= 0n) {
    costUnits = 0n; // no basis; caller handles negative-stock fallback
  } else {
    costUnits = roundDiv(onVal * issQty, onQty);
  }
  const unitCost = onQty !== 0n ? divUnits(onVal, onQty) : 0n;
  return {
    cost: fromUnits(costUnits),
    unitCost: fromUnits(unitCost),
    state: { quantity: fromUnits(onQty - issQty), value: fromUnits(onVal - costUnits) },
  };
}

// ---------------------------------------------------------------------------
// Standard cost
// ---------------------------------------------------------------------------

export interface StandardReceipt {
  /** value booked to inventory (at standard). */
  inventoryValue: string;
  /** purchase price variance = (actual − standard) × qty (DR = unfavorable). */
  variance: string;
}

/** Receive at standard cost; the actual-vs-standard delta is a PPV. */
export function receiveStandard(quantity: string, actualUnitCost: string, standardCost: string): StandardReceipt {
  const q = toUnits(quantity);
  const std = toUnits(standardCost);
  const act = toUnits(actualUnitCost);
  const inventoryValue = mulUnits(q, std);
  const variance = mulUnits(q, act - std);
  return { inventoryValue: fromUnits(inventoryValue), variance: fromUnits(variance) };
}

/** Issue at standard cost. */
export function issueStandard(quantity: string, standardCost: string): string {
  return fromUnits(mulUnits(toUnits(quantity), toUnits(standardCost)));
}

/**
 * value ÷ quantity as a 4-decimal unit cost, half-up and sign-preserving.
 *
 * BigInt `/` truncates, which quietly rounded every non-terminating average
 * DOWN and drifted the subledger below the GL, so this rounds. `roundDiv`
 * refuses a non-positive denominator, and quantity is legitimately negative on
 * reversal and consumption paths, so the sign is taken out and put back rather
 * than handed to it. A zero quantity has no unit cost to state; callers choose
 * the fallback that fits their context.
 */
export function unitCostPerQuantity(value: string, quantity: string): string | null {
  const q = toUnits(quantity);
  if (q === 0n) return null;
  const v = toUnits(value) * 10_000n;
  return fromUnits(q < 0n ? roundDiv(-v, -q) : roundDiv(v, q));
}
