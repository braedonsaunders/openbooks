import { mulRate } from "@openbooks/engine/src/money.ts";

/** Convert a source rate-card amount into the project's functional currency
 * using decimal money arithmetic (never a JavaScript float). */
export function convertBillRate(rate: string, fxRate: string): string {
  return mulRate(rate, fxRate);
}
