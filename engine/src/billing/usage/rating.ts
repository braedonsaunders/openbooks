/**
 * Pure usage-rating kernel: aggregate usage records, then price the aggregate
 * through rating bands. No database, no clock — the same inputs rate to the
 * same lines to the penny on every replay, which is what makes a rating run
 * idempotent evidence rather than opinion.
 *
 * Money discipline: quantities and unit prices carry up to 8 decimal places
 * (`document_lines.unit_price` is numeric(28,8)); amounts are ledger money at
 * 4. Every line rounds exactly once, half away from zero, through
 * `mulDecimalFactors`, and the invoice total is the sum of the rounded
 * lines — there is no second rounding, so there is no dust to allocate.
 * Never `mul`/`mulMoney` here: both read their operands at 4dp and throw on
 * a sub-cent price.
 */
import { canonicalDecimal, fixedDecimal } from "../../money/exact-decimal.ts";
import { suppliedValue } from "../../money/decimal-refusal.ts";
import {
  parseMoney,
  parseQuantity,
  parseRate,
  type Money,
  type Quantity,
  type Rate,
} from "../../money/brands.ts";
import { fromUnits, mulDecimalFactors, toUnits } from "../../money/money.ts";
import { UsageBillingError } from "./errors.ts";

export type UsageAggregation = "sum" | "count" | "max" | "last" | "unique_count";

export type RatingBandKind =
  | "graduated"
  | "volume"
  | "package"
  | "overage"
  | "commit_shortfall"
  | "prepaid_drawdown";

export type PackageRounding = "up" | "down";

export interface UsageRecordInput {
  id: string;
  /** ISO date (or datetime) text; `last` orders it lexicographically, then by id. */
  occurredOn: string;
  quantity: Quantity;
  distinctKey: string | null;
  reversesId: string | null;
}

export interface RatingBand {
  kind: RatingBandKind;
  seq: number;
  /** Null is infinity; exactly one band per call carries it, in last position. */
  upToQty: Quantity | null;
  /** Per-unit price (per block for `package`); at most 8 decimal places. */
  unitPrice: Rate;
  /** Per-tier flat fee, its own line once when the band bills; zero bills none. */
  flatAmount: Money;
  /** Free allowance, read only by `overage`. */
  includedQty: Quantity;
  /** Block size, read only by `package`. */
  packageSize: Quantity | null;
  packageRounding: PackageRounding | null;
}

export interface RateLine {
  kind: RatingBandKind;
  bandSeq: number;
  /** Billed units — or the block count for `package` (see ratePackage). */
  quantity: Quantity;
  /** Price the line rated at — the per-block price for `package`. */
  unitPrice: Rate;
  amount: Money;
}

const QUANTITY_UNITS = 100_000_000n;

function quantityUnits(value: string, what: string): bigint {
  let fixed: string;
  try {
    fixed = fixedDecimal(value, 8);
  } catch {
    throw new Error(
      `${what} must be a decimal with at most 8 decimal places — got ${suppliedValue(value)}`,
    );
  }
  const [whole = "0", fraction = ""] = fixed.split(".");
  const negative = whole.startsWith("-");
  const digits = (negative ? whole.slice(1) : whole) || "0";
  const units = BigInt(digits) * QUANTITY_UNITS + BigInt(fraction);
  return negative ? -units : units;
}

function formatQuantity(units: bigint): Quantity {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = (magnitude / QUANTITY_UNITS).toString();
  const fraction = (magnitude % QUANTITY_UNITS).toString().padStart(8, "0").replace(/0+$/, "");
  return parseQuantity(`${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`);
}

function moneyUnits(value: string, what: string): bigint {
  try {
    return toUnits(value);
  } catch {
    throw new Error(
      `${what} must be a money amount with at most 4 decimal places — got ${suppliedValue(value)}`,
    );
  }
}

function checkUnitPrice(bandSeq: number, value: string): void {
  if (canonicalDecimal(value, 8) === null) {
    throw new Error(
      `rating band ${bandSeq} unitPrice accepts at most 8 decimal places` +
        ` (document_lines.unit_price is numeric(28,8)) — got ${suppliedValue(value)}`,
    );
  }
}

/** Records that survive reversals: reversal rows are evidence, not usage, and
 * a reversed row counts nowhere. A `reversesId` naming no known row is inert. */
function liveRecords(records: readonly UsageRecordInput[]): UsageRecordInput[] {
  const reversed = new Set<string>();
  for (const record of records) {
    if (record.reversesId !== null) reversed.add(record.reversesId);
  }
  return records.filter((record) => record.reversesId === null && !reversed.has(record.id));
}

/** `occurredOn` is ISO text so lexicographic order is chronological; the id
 * (uuid v7, time-ordered) breaks ties deterministically. */
function compareRecords(a: UsageRecordInput, b: UsageRecordInput): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Aggregate one window's records. Every arm reads the live set only: `sum`
 * subtracts the reversed quantity, `count` removes the reversed event, and
 * `max`, `last` and `unique_count` exclude the reversed record entirely — a
 * distinct key survives only if another live record carries it. An empty
 * window aggregates to zero under every arm, which rates to no lines.
 */
export function aggregateUsage(
  aggregation: UsageAggregation,
  records: readonly UsageRecordInput[],
): Quantity {
  const live = liveRecords(records);
  switch (aggregation) {
    case "sum": {
      let total = 0n;
      for (const record of live) {
        total += quantityUnits(record.quantity, `usage record ${record.id} quantity`);
      }
      return formatQuantity(total);
    }
    case "count":
      return formatQuantity(BigInt(live.length) * QUANTITY_UNITS);
    case "max": {
      let best: bigint | null = null;
      for (const record of live) {
        const units = quantityUnits(record.quantity, `usage record ${record.id} quantity`);
        if (best === null || units > best) best = units;
      }
      return formatQuantity(best ?? 0n);
    }
    case "last": {
      if (live.length === 0) return formatQuantity(0n);
      const ordered = live.slice().sort(compareRecords);
      const chosen = ordered[ordered.length - 1];
      if (chosen === undefined) return formatQuantity(0n);
      return formatQuantity(quantityUnits(chosen.quantity, `usage record ${chosen.id} quantity`));
    }
    case "unique_count": {
      const keys = new Set<string>();
      for (const record of live) {
        if (record.distinctKey === null) {
          throw new Error(
            `usage record ${record.id} aggregates unique_count but carries no distinct key —` +
              ` send the distinct key with the reading`,
          );
        }
        keys.add(record.distinctKey);
      }
      return formatQuantity(BigInt(keys.size) * QUANTITY_UNITS);
    }
    default: {
      const exhaustive: never = aggregation;
      throw new Error(`unknown usage aggregation: ${suppliedValue(exhaustive)}`);
    }
  }
}

interface PlacedBand {
  band: RatingBand;
  top: bigint | null;
}

function usageLine(
  kind: RatingBandKind,
  bandSeq: number,
  qtyUnits: bigint,
  unitPrice: Rate,
): RateLine {
  const quantity = formatQuantity(qtyUnits);
  return {
    kind,
    bandSeq,
    quantity,
    unitPrice,
    amount: parseMoney(mulDecimalFactors("1", [unitPrice, quantity])),
  };
}

function pushFlatLine(lines: RateLine[], kind: RatingBandKind, band: RatingBand): void {
  if (moneyUnits(band.flatAmount, `rating band ${band.seq} flatAmount`) === 0n) return;
  const unitPrice = parseRate(band.flatAmount);
  lines.push({
    kind,
    bandSeq: band.seq,
    quantity: parseQuantity("1"),
    unitPrice,
    amount: parseMoney(mulDecimalFactors("1", [unitPrice, "1"])),
  });
}

function rateGraduated(total: bigint, placed: readonly PlacedBand[]): RateLine[] {
  const lines: RateLine[] = [];
  let floor = 0n;
  for (const entry of placed) {
    const ceiling = entry.top ?? total;
    const remaining = total - floor;
    const take = remaining <= 0n ? 0n : remaining < ceiling - floor ? remaining : ceiling - floor;
    if (take > 0n) {
      lines.push(usageLine("graduated", entry.band.seq, take, entry.band.unitPrice));
      pushFlatLine(lines, "graduated", entry.band);
    }
    if (entry.top === null) break;
    floor = entry.top;
  }
  return lines;
}

/** The landed band is the first whose ceiling holds the total. `upToQty` is
 * inclusive: a quantity exactly on a boundary belongs to the lower band. */
function findLandedBand(total: bigint, placed: readonly PlacedBand[]): PlacedBand {
  const landed = placed.find((entry) => entry.top === null || total <= entry.top);
  // Unreachable: validation above guarantees one trailing open-ended band.
  if (landed === undefined) throw new Error("rating bands must cover [0, ∞)");
  return landed;
}

function rateVolume(total: bigint, placed: readonly PlacedBand[]): RateLine[] {
  const landed = findLandedBand(total, placed);
  const lines = [usageLine("volume", landed.band.seq, total, landed.band.unitPrice)];
  pushFlatLine(lines, "volume", landed.band);
  return lines;
}

function ratePackage(total: bigint, placed: readonly PlacedBand[]): RateLine[] {
  const landed = findLandedBand(total, placed);
  const band = landed.band;
  if (band.packageSize === null) {
    throw new Error(`rating band ${band.seq} is a package band without a packageSize — set the block size`);
  }
  if (band.packageRounding !== "up" && band.packageRounding !== "down") {
    throw new Error(
      `rating band ${band.seq} packageRounding must be "up" or "down" — got ${suppliedValue(band.packageRounding)}`,
    );
  }
  const size = quantityUnits(band.packageSize, `rating band ${band.seq} packageSize`);
  if (size <= 0n) {
    throw new Error(
      `rating band ${band.seq} packageSize must be greater than zero — got ${suppliedValue(band.packageSize)}`,
    );
  }
  let blocks = total / size;
  if (band.packageRounding === "up" && total % size !== 0n) blocks += 1n;
  // Rounding down below one block bills nothing, so the band emits no lines.
  if (blocks === 0n) return [];
  // The line quantity is the block COUNT priced at the per-block price, so the
  // amount is blocks × block price through the single rounding. Carrying
  // billed units here would multiply the block price by the block size.
  const lines = [usageLine("package", band.seq, blocks * QUANTITY_UNITS, band.unitPrice)];
  pushFlatLine(lines, "package", band);
  return lines;
}

function rateOverage(total: bigint, placed: readonly PlacedBand[]): RateLine[] {
  const only = placed.length === 1 ? placed[0] : undefined;
  if (only === undefined) {
    throw new Error("overage rates a single band: includedQty at zero, the excess at unitPrice");
  }
  const band = only.band;
  const included = quantityUnits(band.includedQty, `rating band ${band.seq} includedQty`);
  if (included < 0n) {
    throw new Error(
      `rating band ${band.seq} includedQty cannot be negative — got ${suppliedValue(band.includedQty)}`,
    );
  }
  const excess = total - included;
  if (excess <= 0n) return [];
  const lines = [usageLine("overage", band.seq, excess, band.unitPrice)];
  pushFlatLine(lines, "overage", band);
  return lines;
}

/**
 * Price one aggregate through one kind of bands. Bands arrive in any order
 * and are read by `seq`; every arm is exhaustive over the union so a new
 * band kind cannot compile without one. `commit_shortfall` and
 * `prepaid_drawdown` are arms that refuse: neither is an invoice line — the
 * shortfall bills through `commitShortfall`, the rated amount splits through
 * `applyPrepaid`.
 */
export function rateUsage(input: { quantity: Quantity; bands: readonly RatingBand[] }): RateLine[] {
  const total = quantityUnits(input.quantity, "rated quantity");
  if (total < 0n) {
    throw new Error(`rated quantity cannot be negative — got ${suppliedValue(input.quantity)}`);
  }
  const first = input.bands[0];
  if (first === undefined) {
    throw new Error("rateUsage requires at least one rating band — a quantity with no price list has no rate");
  }
  if (total === 0n) return [];
  const kinds = new Set(input.bands.map((band) => band.kind));
  if (kinds.size > 1) {
    throw new Error(`rateUsage rates one band kind per call — got ${[...kinds].join(", ")}`);
  }
  const kind = first.kind;
  const ordered = input.bands.slice().sort((a, b) => a.seq - b.seq);
  for (const band of ordered) {
    checkUnitPrice(band.seq, band.unitPrice);
    moneyUnits(band.flatAmount, `rating band ${band.seq} flatAmount`);
  }
  const placed: PlacedBand[] = ordered.map((band) => ({
    band,
    top: band.upToQty === null ? null : quantityUnits(band.upToQty, `rating band ${band.seq} upToQty`),
  }));
  const last = placed[placed.length - 1];
  const openEnded = placed.filter((entry) => entry.top === null);
  if (openEnded.length !== 1 || last === undefined || last.top !== null) {
    throw new Error(
      "rating bands must cover [0, ∞): exactly one band carries a null upToQty (infinity), in the last sequence position",
    );
  }
  let floor = 0n;
  for (const entry of placed) {
    if (entry.top === null) break;
    if (entry.top <= floor) {
      throw new Error(
        `rating band ${entry.band.seq} upToQty must sit above the previous band's — bands overlap or leave no width`,
      );
    }
    floor = entry.top;
  }
  switch (kind) {
    case "graduated":
      return rateGraduated(total, placed);
    case "volume":
      return rateVolume(total, placed);
    case "package":
      return ratePackage(total, placed);
    case "overage":
      return rateOverage(total, placed);
    case "commit_shortfall":
      throw new Error("commit_shortfall bands are not invoice lines — bill the shortfall with commitShortfall instead");
    case "prepaid_drawdown":
      throw new Error("prepaid_drawdown bands are not invoice lines — split the rated amount with applyPrepaid instead");
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown rating band kind: ${suppliedValue(exhaustive)}`);
    }
  }
}

/** Minimum-commit true-up: the shortfall bills when positive, otherwise zero.
 * A commit is a floor, not a prepayment — nothing bills or defers up front. */
export function commitShortfall(input: { commitAmount: Money; ratedInWindow: Money }): Money {
  const commit = moneyUnits(input.commitAmount, "commitAmount");
  if (commit < 0n) {
    throw new Error(`commitAmount cannot be negative — got ${suppliedValue(input.commitAmount)}`);
  }
  const rated = moneyUnits(input.ratedInWindow, "ratedInWindow");
  if (rated < 0n) {
    throw new Error(`ratedInWindow cannot be negative — got ${suppliedValue(input.ratedInWindow)}`);
  }
  const shortfall = commit - rated;
  return parseMoney(fromUnits(shortfall > 0n ? shortfall : 0n));
}

export interface PrepaidSplit {
  drawn: Money;
  billable: Money;
}

/**
 * Split a rated amount against a prepaid grant: the draw is the rated amount
 * up to the balance, the remainder bills. Draws are not invoice lines — the
 * caller records them as recognition against the prepaid obligation. When the
 * remainder is positive and the link disallows overage, the kernel's one
 * refusal names all three remedies.
 */
export function applyPrepaid(input: { rated: Money; balance: Money; allowOverage: boolean }): PrepaidSplit {
  const rated = moneyUnits(input.rated, "rated");
  if (rated < 0n) {
    throw new Error(`rated cannot be negative — got ${suppliedValue(input.rated)}`);
  }
  const balance = moneyUnits(input.balance, "balance");
  if (balance < 0n) {
    throw new Error(`balance cannot be negative — got ${suppliedValue(input.balance)}`);
  }
  const drawn = rated < balance ? rated : balance;
  const billable = rated - drawn;
  if (billable > 0n && !input.allowOverage) {
    const remedy =
      "top up the prepaid balance, allow overage on the subscription's usage link, or bill the usage ad hoc";
    throw new UsageBillingError(
      "prepaid_overage_disallowed",
      `prepaid balance ${fromUnits(balance)} covers ${fromUnits(drawn)} of the rated ${fromUnits(rated)}` +
        ` with ${fromUnits(billable)} still billable and overage disallowed — ${remedy}`,
      remedy,
    );
  }
  return { drawn: parseMoney(fromUnits(drawn)), billable: parseMoney(fromUnits(billable)) };
}
