/** Forecast horizon choices shared by server loaders and client controls. */
export const MAX_CASH_HORIZON_WEEKS = 26;
export const CASH_HORIZON_PRESETS = [4, 8, 13, 26] as const;

/**
 * Normalize a requested horizon (?horizon=) to a whole week count inside the
 * supported cap, falling back to the caller's default for invalid input.
 */
export function normalizeCashHorizonWeeks(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CASH_HORIZON_WEEKS) return fallback;
  return n;
}
