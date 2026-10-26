import { perShareFractionDigits } from "@openbooks/reports";

/** The per-share precision rule (packages/reports/src/per-share.ts), shared with reports and exports. */
export { PER_SHARE_FRACTION_DIGITS, perShareFractionDigits } from "@openbooks/reports";

/** Number-format options for a per-share value under the per-share rule. */
export function perShareFormatOptions(value: string): {
  minimumFractionDigits: number;
  maximumFractionDigits: number;
} {
  const digits = perShareFractionDigits(value);
  return { minimumFractionDigits: digits, maximumFractionDigits: digits };
}
