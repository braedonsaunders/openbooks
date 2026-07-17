import { fromUnits, toUnits } from "./money.ts";

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
 * The DB engine (engine/src/inventory.ts) turns these results into cost-layer
 * rows and balanced journal entries through the kernel.
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

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/**
 * Convert a quantity in `unit` to base units using the item's conversion map
 * (base units per unit, e.g. { box: 12, pallet: 720 }). The base unit and any
 * unknown unit convert 1:1.
 */
export function toBaseQuantity(quantity: string, unit: string | null | undefined, conversions: Record<string, number>, baseUnit: string): string {
  if (!unit || unit === baseUnit) return fromUnits(toUnits(quantity));
  const factor = conversions[unit];
  if (!factor || factor <= 0) return fromUnits(toUnits(quantity));
  return fromUnits(mulUnits(toUnits(quantity), toUnits(String(factor))));
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
    const cost = mulUnits(take, cu);
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
    costUnits = divUnits(mulUnits(onVal, issQty), onQty);
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
