import { apportion, fromUnits, mulDecimalFactors, mulPercent, toUnits } from "../money/money.ts";
import { posRefusal } from "./errors.ts";

/**
 * Register cart arithmetic. Pure and exact: every amount is a bigint of
 * ledger units (four decimal places, the `toUnits` scale shared with
 * document tenders), rounded once to the currency's minor unit.
 *
 * - A line's gross is quantity × unit price, rounded once.
 * - A line discount (percent of the line, or an amount) is capped at the
 *   line gross, so a line never goes negative.
 * - An order discount applies to the sum of discounted lines and is
 *   prorated across them by largest remainder: the shares sum exactly to the
 *   order discount and no share exceeds its line. Each line therefore
 *   carries its own net amount, and the native tax engine taxes each net
 *   line exactly as it would any other document line.
 *
 * Tax is deliberately absent: the document writer computes it from each
 * line's tax code at the document date, so the register can never disagree
 * with the posted sale.
 */

export type PosDiscount = { kind: "percent"; value: string } | { kind: "amount"; value: string };

export interface PosCartLineInput {
  quantity: string;
  unitPrice: string;
  discount?: PosDiscount | null;
}

export interface PosPricedLine {
  quantity: string;
  unitPrice: string;
  grossUnits: bigint;
  lineDiscountUnits: bigint;
  orderDiscountUnits: bigint;
  netUnits: bigint;
}

export interface PosPricedCart {
  lines: PosPricedLine[];
  grossUnits: bigint;
  lineDiscountUnits: bigint;
  orderDiscountUnits: bigint;
  netUnits: bigint;
}

const QUANTITY_RE = /^\d{1,9}(\.\d{1,4})?$/;
const AMOUNT_RE = /^\d{1,13}(\.\d{1,4})?$/;
const PERCENT_RE = /^\d{1,3}(\.\d{1,4})?$/;

/** Ledger units in one minor unit of a currency with `decimals` places (0..4). */
export function minorStep(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw posRefusal(
      `Currency precision ${decimals} is not supported.`,
      "register_misconfigured",
      422,
      "Use a currency with between zero and four minor-unit digits.",
    );
  }
  return 10n ** BigInt(4 - decimals);
}

function invalid(message: string, remedy: string): never {
  throw posRefusal(message, "invalid_input", 422, remedy);
}

/** Parse a positive quantity with at most four decimal places. */
export function parsePosQuantity(raw: string, label: string): string {
  const value = String(raw ?? "").trim();
  if (!QUANTITY_RE.test(value) || toUnits(value) <= 0n) {
    invalid(
      `${label} quantity ${JSON.stringify(raw)} is not a positive quantity.`,
      "Enter a quantity greater than zero with at most four decimal places.",
    );
  }
  return fromUnits(toUnits(value));
}

/**
 * Parse a non-negative amount that is exact in the currency's minor unit:
 * an amount the till cannot physically hand over is refused, never rounded.
 */
export function parsePosAmount(raw: string, label: string, decimals: number): bigint {
  const value = String(raw ?? "").trim();
  if (!AMOUNT_RE.test(value)) {
    invalid(
      `${label} ${JSON.stringify(raw)} is not an amount.`,
      "Enter the amount as a decimal number, for example 12.50.",
    );
  }
  const units = toUnits(value);
  if (units % minorStep(decimals) !== 0n) {
    invalid(
      `${label} ${value} has more decimal places than the currency allows.`,
      `Enter the amount with at most ${decimals} decimal places.`,
    );
  }
  return units;
}

/** Parse a unit price: non-negative, at most four decimal places (unit prices may be finer than the currency). */
export function parsePosUnitPrice(raw: string, label: string): string {
  const value = String(raw ?? "").trim();
  if (!AMOUNT_RE.test(value)) {
    invalid(
      `${label} unit price ${JSON.stringify(raw)} is not a price.`,
      "Enter the unit price as a decimal number with at most four decimal places.",
    );
  }
  return fromUnits(toUnits(value));
}

function discountUnits(
  baseUnits: bigint,
  discount: PosDiscount | null | undefined,
  decimals: number,
  label: string,
): bigint {
  if (!discount) return 0n;
  if (baseUnits <= 0n) return 0n;
  if (discount.kind === "percent") {
    const value = String(discount.value ?? "").trim();
    if (!PERCENT_RE.test(value) || toUnits(value) <= 0n || toUnits(value) > toUnits("100")) {
      invalid(
        `${label} discount ${JSON.stringify(discount.value)}% is not a percentage between 0 and 100.`,
        "Enter a discount percentage greater than 0 and at most 100.",
      );
    }
    const units = toUnits(mulPercent(fromUnits(baseUnits), value, decimals));
    return units > baseUnits ? baseUnits : units;
  }
  if (discount.kind === "amount") {
    const units = parsePosAmount(discount.value, `${label} discount`, decimals);
    if (units <= 0n)
      invalid(
        `${label} discount must be greater than zero.`,
        "Enter a discount amount greater than zero, or remove the discount.",
      );
    return units > baseUnits ? baseUnits : units;
  }
  return invalid(
    `${label} discount kind is not recognised.`,
    "Choose a percentage or an amount discount.",
  );
}

/** Price a cart: gross, line discounts, prorated order discount and net per line. */
export function priceCart(
  lines: readonly PosCartLineInput[],
  orderDiscount: PosDiscount | null | undefined,
  decimals: number,
): PosPricedCart {
  const step = minorStep(decimals);
  const priced = lines.map((line, index) => {
    const label = `Line ${index + 1}`;
    const quantity = parsePosQuantity(line.quantity, label);
    const unitPrice = parsePosUnitPrice(line.unitPrice, label);
    const grossUnits = toUnits(
      mulDecimalFactors(unitPrice, [quantity], { decimalPlaces: decimals }),
    );
    const lineDiscountUnits = discountUnits(grossUnits, line.discount, decimals, label);
    return {
      quantity,
      unitPrice,
      grossUnits,
      lineDiscountUnits,
      net: grossUnits - lineDiscountUnits,
    };
  });
  const discountedUnits = priced.reduce((total, line) => total + line.net, 0n);
  const orderDiscountUnits = discountUnits(discountedUnits, orderDiscount, decimals, "Order");
  // Prorate whole minor units so every share is itself an amount the till
  // can hand over; the weights are each line's discounted amount.
  const shares =
    orderDiscountUnits === 0n
      ? priced.map(() => 0n)
      : apportion(
          orderDiscountUnits / step,
          priced.map((line) => line.net / step),
        ).map((share) => share * step);
  const out: PosPricedLine[] = priced.map((line, index) => ({
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    grossUnits: line.grossUnits,
    lineDiscountUnits: line.lineDiscountUnits,
    orderDiscountUnits: shares[index]!,
    netUnits: line.net - shares[index]!,
  }));
  return {
    lines: out,
    grossUnits: out.reduce((total, line) => total + line.grossUnits, 0n),
    lineDiscountUnits: out.reduce((total, line) => total + line.lineDiscountUnits, 0n),
    orderDiscountUnits,
    netUnits: out.reduce((total, line) => total + line.netUnits, 0n),
  };
}

/** Change owed on a cash tender, or null when the cash does not cover what it must. */
export function changeDue(owedUnits: bigint, tenderedUnits: bigint): bigint | null {
  if (tenderedUnits < owedUnits) return null;
  return tenderedUnits - owedUnits;
}

/**
 * Quick cash amounts for a total: the exact amount, then the next round
 * figures in the currency's common steps, ascending, at most four.
 */
export function cashSuggestions(totalUnits: bigint, decimals: number): bigint[] {
  const step = minorStep(decimals);
  const exact = ((totalUnits + step - 1n) / step) * step;
  const out = new Set<bigint>([exact]);
  for (const major of [1n, 5n, 10n, 20n, 50n, 100n]) {
    const unit = major * 10_000n;
    const up = ((totalUnits + unit - 1n) / unit) * unit;
    if (up > totalUnits) out.add(up);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 4);
}

export interface DenominationCount {
  value: string;
  count: number;
}

/**
 * Total a drawer count by denomination. Denominations must be the
 * register's configured set (when it has one); counts are whole and
 * non-negative. A count with no denominations configured is a single
 * total entered as one row of value × 1.
 */
export function totalDenominationCount(
  rows: readonly DenominationCount[],
  allowed: readonly string[],
  decimals: number,
): { totalUnits: bigint; rows: DenominationCount[] } {
  const allowedUnits = new Set(allowed.map((value) => toUnits(value).toString()));
  const seen = new Set<string>();
  const canonical: DenominationCount[] = [];
  let totalUnits = 0n;
  rows.forEach((row, index) => {
    const label = `Count row ${index + 1}`;
    const units = parsePosAmount(row.value, `${label} denomination`, decimals);
    if (units <= 0n) {
      throw posRefusal(
        `${label} denomination must be greater than zero.`,
        "count_invalid",
        422,
        "Count each note and coin denomination once.",
      );
    }
    const key = units.toString();
    if (allowedUnits.size > 0 && !allowedUnits.has(key)) {
      throw posRefusal(
        `${label} denomination ${fromUnits(units)} is not one of this register's denominations.`,
        "count_invalid",
        422,
        "Count the drawer with the register's denominations, or update them in the register setup.",
      );
    }
    if (seen.has(key)) {
      throw posRefusal(
        `${label} repeats denomination ${fromUnits(units)}.`,
        "count_invalid",
        422,
        "Count each denomination once.",
      );
    }
    seen.add(key);
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw posRefusal(
        `${label} count must be a whole number of zero or more.`,
        "count_invalid",
        422,
        "Enter how many of each note or coin are in the drawer.",
      );
    }
    totalUnits += units * BigInt(row.count);
    canonical.push({ value: fromUnits(units), count: row.count });
  });
  return { totalUnits, rows: canonical };
}

export interface SessionCashFacts {
  openingFloatUnits: bigint;
  saleCashUnits: bigint;
  refundCashUnits: bigint;
  payInUnits: bigint;
  payOutUnits: bigint;
}

/** Cash the drawer should hold: float + cash sales − cash refunds + pay-ins − pay-outs. */
export function expectedDrawerCash(facts: SessionCashFacts): bigint {
  return (
    facts.openingFloatUnits +
    facts.saleCashUnits -
    facts.refundCashUnits +
    facts.payInUnits -
    facts.payOutUnits
  );
}

/**
 * Prorate an original line's amount for a partial return: the returned
 * share of the original quantity, rounded to the currency's minor unit.
 * A full return is the original amount exactly.
 */
export function proratedReturnUnits(
  originalUnits: bigint,
  originalQuantity: string,
  returnQuantity: string,
  decimals: number,
): bigint {
  const original = toUnits(originalQuantity);
  const returned = toUnits(returnQuantity);
  if (original <= 0n || returned <= 0n || returned > original) {
    throw posRefusal(
      `A return of ${returnQuantity} does not fit the original quantity ${originalQuantity}.`,
      "refund_exceeds_sale",
      422,
      "Return at most the quantity still unreturned on the original receipt.",
    );
  }
  if (returned === original) return originalUnits;
  const step = minorStep(decimals);
  const negative = originalUnits < 0n;
  const magnitude = negative ? -originalUnits : originalUnits;
  const exact = magnitude * returned;
  const denominator = original * step;
  const rounded = ((exact + denominator / 2n) / denominator) * step;
  return negative ? -rounded : rounded;
}
