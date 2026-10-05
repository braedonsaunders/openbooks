/**
 * Forecast confidence levels and their band multipliers.
 *
 * The Z table is the single source of truth: the offered levels below and
 * the analytics threshold spec both derive from these keys, so adding a
 * level teaches every surface at once. It lives in web/lib (never under a
 * route tree) so server readers like the threshold spec can import it
 * without reaching into component directories.
 */
export class UnknownConfidenceError extends Error {
  constructor(readonly level: number) {
    super(`unknown forecast confidence level ${level} — choose one of ${FORECAST_CONFIDENCE_LEVELS.join(", ")}`);
    this.name = "UnknownConfidenceError";
  }
}

const Z: Record<number, number> = { 80: 1.282, 90: 1.645, 95: 1.96, 99: 2.576 };

/** The confidence levels the model can band, in ascending order: the Z keys. */
export const FORECAST_CONFIDENCE_LEVELS: number[] = Object.keys(Z).map(Number);

/**
 * The band multiplier for a configured confidence level. An unlisted level
 * is a refusal, never a silent z: 1.645 at an unlisted level would print a
 * 90% band under another name.
 */
export function zScoreForConfidence(confidence: number): number {
  const z = Z[confidence];
  if (z === undefined) throw new UnknownConfidenceError(confidence);
  return z;
}
