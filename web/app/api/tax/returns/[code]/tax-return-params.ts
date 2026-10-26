import { decimalNullRefusal } from "../../../../../lib/payroll-decimal-refusal";
import { add } from "@openbooks/engine/money/money";

const AMOUNT_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

/** An `adj_<lineCode>` query param the server cannot read as an amount. */
export class AdjustmentParamError extends Error {
  readonly param: string;
  constructor(param: string, message: string) {
    super(message);
    this.name = "AdjustmentParamError";
    this.param = param;
  }
}

/**
 * Adjustment-box amounts arrive as `adj_<lineCode>=<amount>` query params.
 * A line with several recorded entries repeats its key; the amounts are
 * summed exactly, so the preview matches the total the filing records. Every
 * `adj_` key is validated: an unreadable amount is refused by name (naming the
 * parameter, with the shared decimal remedy) instead of being skipped silently
 * — a skipped key used to compute the box as 0.0000.
 */
export function parseAdjustments(params: URLSearchParams): Record<string, string> {
  const adjustments: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!key.startsWith("adj_")) continue;
    const lineCode = key.slice(4);
    if (!lineCode || lineCode.length > 20) {
      throw new AdjustmentParamError(
        key,
        "an adjustment must name a return line of at most 20 characters — choose an adjustment line of the form",
      );
    }
    const amount = value.trim();
    const whole = amount.split(".")[0]!;
    if (/^-?\d+$/.test(whole) && whole.replace("-", "").length > 15) {
      throw new AdjustmentParamError(
        key,
        `adjustment ${lineCode} exceeds the supported amount — enter at most 15 digits before the decimal point`,
      );
    }
    if (!AMOUNT_RE.test(amount)) {
      throw new AdjustmentParamError(
        key,
        decimalNullRefusal(`adjustment ${lineCode}`, "an amount", value, 4),
      );
    }
    const prior = Object.hasOwn(adjustments, lineCode) ? adjustments[lineCode] : undefined;
    Object.defineProperty(adjustments, lineCode, {
      value: prior === undefined ? amount : add(prior, amount),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return adjustments;
}
