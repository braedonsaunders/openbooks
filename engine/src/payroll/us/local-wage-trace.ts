/** Stable per-stub factor key paired with a local deduction line's sequence. */
export function w2LocalWageTraceKey(sequence: number): string {
  return `W2_LOCAL_WAGES_${sequence}`;
}
