import type { CountryTaxCodeDefinition, EffectiveTaxRate } from "./types.ts";

/**
 * The channel invariant for pack rate schedules (F-tax-sunset-001): exactly
 * one declared rate COVERS TODAY. A band in force now may carry a published
 * end date — temporary law is ordinary statecraft, and forcing it
 * open-ended would assert a decree is permanent. `ratePercent` tracks the
 * rate current today, which is what every reader of the headline wants.
 *
 * This is deliberately TIME-DEPENDENT: a pack whose current band expires
 * starts failing on a calendar date with no code change, because the data
 * really is stale and someone must transcribe the successor rate. The
 * failure therefore names the code, the expired band, and its end date, and
 * says plainly that the successor rate is missing — a guard that fires on
 * a date boundary with a vague message is one people learn to disable.
 *
 * The clock is injectable so tests are deterministic; the guard loops pass
 * nothing and read the real today.
 */

/** Real today as a UTC yyyy-mm-dd date string, the guard's default clock. */
export function packGuardToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Every declared band covering `today` (inclusive on both ends). */
export function packRatesCoveringDate(
  rates: readonly EffectiveTaxRate[] | undefined,
  today: string,
): readonly EffectiveTaxRate[] {
  return (rates ?? []).filter(
    (rate) => rate.effectiveFrom <= today && (rate.effectiveTo === undefined || rate.effectiveTo >= today),
  );
}

function describeBand(rate: EffectiveTaxRate): string {
  return `${rate.ratePercent}% from ${rate.effectiveFrom} to ${rate.effectiveTo ?? "open-ended"}`;
}

/**
 * Enforce the covers-today invariant for one declared code, throwing a
 * teaching error when the schedule cannot provision current tax.
 */
export function assertPackCodeRateSchedule(
  label: string,
  definition: CountryTaxCodeDefinition,
  today: string = packGuardToday(),
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`${label} schedule guard needs a yyyy-mm-dd date, got ${today}`);
  }
  const rates = definition.rates ?? [];
  if (rates.length === 0) {
    throw new Error(`missing effective-dated rates for ${label}`);
  }
  const covering = packRatesCoveringDate(rates, today);
  if (covering.length === 0) {
    const last = rates.at(-1)!;
    if (last.effectiveTo !== undefined && last.effectiveTo < today) {
      throw new Error(
        `${label} has no rate covering ${today}: its last band (${describeBand(last)}) already ended, `
        + `so the pack needs the successor rate transcribed before this code can provision current tax`,
      );
    }
    const first = rates[0]!;
    if (first.effectiveFrom > today) {
      throw new Error(
        `${label} has no rate covering ${today}: its earliest band (${describeBand(first)}) `
        + `does not start until ${first.effectiveFrom}, so no declared rate is in force yet`,
      );
    }
    throw new Error(
      `${label} has no rate covering ${today}: the declared bands leave a gap on that date, `
      + `so the pack needs a band transcribed for it before this code can provision current tax`,
    );
  }
  if (covering.length > 1) {
    throw new Error(
      `${label} has ${covering.length} rates covering ${today} `
      + `(${covering.map(describeBand).join("; ")}): exactly one rate may cover today`,
    );
  }
  const current = covering[0]!;
  if (definition.ratePercent !== current.ratePercent) {
    throw new Error(
      `${label} headline rate is stale: ${describeBand(current)} covers ${today} `
      + `but ratePercent is ${definition.ratePercent}`,
    );
  }
}
