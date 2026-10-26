/**
 * The one precision rule for per-share values: prices per share, exercise
 * and conversion prices, par values, fair values per unit and payouts per
 * share all read with four decimal places, so a column of prices aligns and
 * two prices never disagree in precision ($3.8220 beside $2.1483). A
 * non-zero value that four places would show as zero (a par value of
 * 0.00001) keeps the places it needs, up to the ten it is stored with,
 * trailing zeros trimmed. Display only: the stored value stays exact.
 */

export const PER_SHARE_FRACTION_DIGITS = 4;
const MAX_STORED_FRACTION_DIGITS = 10;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The fraction digits a per-share value reads with (minimum and maximum alike). */
export function perShareFractionDigits(value: string): number {
  if (!DECIMAL.test(value)) return PER_SHARE_FRACTION_DIGITS;
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const kept = fraction.slice(0, PER_SHARE_FRACTION_DIGITS);
  const roundsToZero =
    /^0+$/.test(whole) && !/[1-9]/.test(kept) && (fraction[PER_SHARE_FRACTION_DIGITS] ?? "0") < "5";
  if (!roundsToZero || !/[1-9]/.test(fraction)) return PER_SHARE_FRACTION_DIGITS;
  return Math.min(MAX_STORED_FRACTION_DIGITS, fraction.replace(/0+$/, "").length);
}
