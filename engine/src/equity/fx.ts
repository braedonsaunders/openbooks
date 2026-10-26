/**
 * Exchange rates for equity instruments stated in a currency other than the
 * legal entity's functional currency.
 *
 * Rates come from the organization's exchange-rate table on the transaction
 * date (the newest spot rate on or before it, direct or inverse). A pair with
 * no direct quote is crossed through the functional currency. A missing rate
 * refuses by name; it never becomes 1. A foreign amount becomes functional
 * ledger units as round(amount × rate, 4), the measurement every journal line
 * carries.
 */
import { lookupSpotRate } from "../fx/spot-rate.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { EquityError, equityError, fig } from "./errors.ts";
import type { EquityTermName } from "./refusals/terms.ts";
import {
  divideRational,
  fromLedgerUnits,
  MONEY_SCALE,
  multiplyRational,
  parseDecimal,
  quantize,
  type Rational,
} from "./quantities.ts";

/** Decimal places of a stored exchange rate. */
export const RATE_SCALE = 10;

export const parseRate = (value: string, label: EquityTermName = "exchangeRate"): Rational =>
  parseDecimal(value, label, RATE_SCALE);

function missingRate(from: string, to: string, on: string): EquityError {
  return equityError("fxRateMissing", {
    from: fig.text(from),
    to: fig.text(to),
    date: fig.date(on),
  });
}

/** Units of `to` per unit of `from` on `on`, as the stored rate string. */
export async function spotRate(
  runner: SqlExecutor,
  orgId: string,
  from: string,
  to: string,
  on: string,
  functional: string,
): Promise<string> {
  if (from === to) return "1";
  const direct = await lookupSpotRate(runner, orgId, from, to, on);
  if (direct) return direct;
  if (from !== functional && to !== functional) {
    const fromLeg = await lookupSpotRate(runner, orgId, from, functional, on);
    const toLeg = await lookupSpotRate(runner, orgId, to, functional, on);
    if (fromLeg && toLeg) {
      const crossed = divideRational(parseRate(fromLeg), parseRate(toLeg));
      return formatRate(crossed);
    }
  }
  throw missingRate(from, to, on);
}

/** A rate rounded half up to the stored ten places. */
export function formatRate(rate: Rational): string {
  const units = quantize(rate, RATE_SCALE, "half_up");
  const digits = units.toString().padStart(RATE_SCALE + 1, "0");
  return `${digits.slice(0, -RATE_SCALE)}.${digits.slice(-RATE_SCALE)}`;
}

/** Functional ledger units of a foreign amount (ledger units) at a rate: round(amount × rate, 4). */
export function functionalUnits(txnUnits: bigint, rate: string): bigint {
  return quantize(
    multiplyRational(fromLedgerUnits(txnUnits), parseRate(rate)),
    MONEY_SCALE,
    "half_up",
  );
}

/** An exact foreign amount restated at a rate (exact). */
export function restate(value: Rational, rate: string): Rational {
  return multiplyRational(value, parseRate(rate));
}
