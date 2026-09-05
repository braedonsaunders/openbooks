/** Resource bound for one materialized schedule, not an asset-category policy.
 * 12,000 monthly periods support 1,000 years. A convention window is bounded
 * independently, so even a fully deferred schedule has at most 24,000 rows.
 */
export const MAX_DEPRECIATION_PERIODS = 12_000;

export function depreciationPeriodCount(value: unknown): number {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_DEPRECIATION_PERIODS) {
    throw new Error(`Depreciation periods must be a whole number between 1 and ${MAX_DEPRECIATION_PERIODS}`);
  }
  return n;
}
