import { mulDecimal } from "@openbooks/engine/money/money";

/** Display a stored-value rate as percentage points without a float conversion. */
export function formatStoredValueBreakageRate(rate: string): string {
  const percent = mulDecimal(rate, "100");
  return `${percent.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1")}%`;
}
