/**
 * Pure performance and retention math (0196, HR-7). No server imports, so
 * unit tests run it directly like process-math.ts: rating-scale parsing and
 * in-scale checks, goal progress clamping, applies_to scope matching, and
 * the turnover arithmetic the retention read reports.
 *
 * Decimals cross as strings and are compared as scaled integers — never
 * floats — because a rating boundary decided by binary floating point is a
 * refusal computed wrong.
 */

export class PerformanceMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerformanceMathError";
  }
}

export interface RatingScale {
  readonly min: string;
  readonly max: string;
  readonly labels: readonly string[];
}

/** Civil YYYY-MM-DD, finite AD range (the 0184 reader/storage contract). */
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCivilDay(value: unknown, field: string): string {
  if (typeof value !== "string" || !CIVIL_DATE_RE.test(value)) {
    throw new PerformanceMathError(`${field} must be a civil date YYYY-MM-DD`);
  }
  const [y, m, d] = value.split("-").map(Number);
  if (y! < 1 || y! > 9999 || m! < 1 || m! > 12 || d! < 1 || d! > 31) {
    throw new PerformanceMathError(`${field} must be a civil date YYYY-MM-DD`);
  }
  // setUTCFullYear keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999 (the platform/business-date.ts utcDateFromParts idiom,
  // copied here so this pure module loads no platform stack).
  const dt = new Date(0);
  dt.setUTCFullYear(y!, m! - 1, d!);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    throw new PerformanceMathError(`${field} must be a real calendar date, got ${value}`);
  }
  return value;
}

/**
 * The engine's decimal recognition, shared by readers (parseRatingScale)
 * and input boundaries (the setup review-template fold): one classifier,
 * never two. A bound the reader accepts must normalize; anything else is
 * refused by name before the write.
 */
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const PERSISTED_DECIMAL_RE = /^-?\d+(\.\d{1,4})?$/;

/** Scale a decimal string to a bigint at 4 fractional digits (exact, never float). */
function scale4(value: string): bigint {
  const neg = value.startsWith("-");
  const digits = neg ? value.slice(1) : value;
  const [whole, frac = ""] = digits.split(".");
  const padded = (frac + "0000").slice(0, 4);
  return BigInt((neg ? "-" : "") + whole + padded);
}

/**
 * The rating scale from a template row: {min, max, labels[]}. Refused by
 * name when the shape is wrong — a review submitted against an unreadable
 * scale would otherwise validate against nothing.
 */
export function parseRatingScale(value: unknown): RatingScale {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PerformanceMathError(
      "the review template carries no readable rating scale — set min, max and labels on the template before opening the cycle",
    );
  }
  const scale = value as Record<string, unknown>;
  const min = scale.min;
  const max = scale.max;
  if ((typeof min !== "number" && typeof min !== "string") || (typeof max !== "number" && typeof max !== "string")) {
    throw new PerformanceMathError(
      "the review template carries no readable rating scale — set min, max and labels on the template before opening the cycle",
    );
  }
  const minStr = String(min);
  const maxStr = String(max);
  if (!DECIMAL_RE.test(minStr) || !DECIMAL_RE.test(maxStr)) {
    throw new PerformanceMathError(
      `the review template scale bounds must be decimal numbers, got min ${JSON.stringify(min)} max ${JSON.stringify(max)} — fix the template before opening the cycle`,
    );
  }
  if (!PERSISTED_DECIMAL_RE.test(minStr) || !PERSISTED_DECIMAL_RE.test(maxStr)) {
    throw new PerformanceMathError(
      `the review template scale bounds may have at most four decimal places because ratings persist at scale 4 — fix the template before opening the cycle`,
    );
  }
  if (scale4(maxStr) <= scale4(minStr)) {
    throw new PerformanceMathError(
      `the review template scale is inverted (min ${minStr} is not below max ${maxStr}) — fix the template before opening the cycle`,
    );
  }
  if (scale4(maxStr) - scale4(minStr) > BigInt(99) * BigInt(10000)) {
    throw new PerformanceMathError(
      `the review template scale spans more than 99 points (${minStr} to ${maxStr}) — narrow it before opening the cycle`,
    );
  }
  const rawLabels = scale.labels ?? [];
  if (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== "string")) {
    throw new PerformanceMathError(
      "the review template scale labels must be an array of strings — fix the template before opening the cycle",
    );
  }
  return { min: minStr, max: maxStr, labels: [...rawLabels] };
}

/**
 * A submitted rating inside the template scale (inclusive). The question
 * prompt travels in the refusal so the reviewer knows which answer to fix.
 */
export function assertRatingInScale(scale: RatingScale, rating: string, questionPrompt: string): void {
  if (!DECIMAL_RE.test(rating)) {
    throw new PerformanceMathError(
      `the answer to ${JSON.stringify(questionPrompt)} must be a decimal rating, got ${JSON.stringify(rating)}`,
    );
  }
  if (!PERSISTED_DECIMAL_RE.test(rating)) {
    throw new PerformanceMathError(
      `the answer to ${JSON.stringify(questionPrompt)} has more than four decimal places, but ratings persist at scale 4 — enter a rating with at most four decimal places`,
    );
  }
  const value = scale4(rating);
  if (value < scale4(scale.min) || value > scale4(scale.max)) {
    throw new PerformanceMathError(
      `the answer to ${JSON.stringify(questionPrompt)} is ${rating}, outside the template scale ${scale.min} to ${scale.max} — rate inside the scale`,
    );
  }
}

/** Goal progress is an integer 0..100; anything else names its bound. */
export function assertProgressPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new PerformanceMathError(
      `goal progress must be a whole percent from 0 to 100, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export interface AppliesScope {
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
}

/**
 * The cycle scope filter from a cycle row. Unknown keys are refused —
 * storage pins the shape, and an unreadable scope must fail closed rather
 * than silently cover the whole org.
 */
export function parseAppliesScope(value: unknown): AppliesScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PerformanceMathError(
      "the review cycle carries no readable scope — set the subsidiary and department scope before opening it",
    );
  }
  const scope = value as Record<string, unknown>;
  for (const key of Object.keys(scope)) {
    if (key !== "employer_subsidiary_id" && key !== "department_id") {
      throw new PerformanceMathError(
        `the review cycle scope carries an unknown key ${JSON.stringify(key)} — only employer_subsidiary_id and department_id apply`,
      );
    }
  }
  const slot = (raw: unknown, key: string): string | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new PerformanceMathError(
        `the review cycle scope ${key} must be an id or null, got ${JSON.stringify(raw)}`,
      );
    }
    return raw;
  };
  return {
    employerSubsidiaryId: slot(scope.employer_subsidiary_id, "employer_subsidiary_id"),
    departmentId: slot(scope.department_id, "department_id"),
  };
}

/** True when an employment (subsidiary + department, both nullable) falls in the cycle scope. */
export function scopeMatchesEmployment(
  scope: AppliesScope,
  employment: { employerSubsidiaryId: string | null; departmentId: string | null },
): boolean {
  if (scope.employerSubsidiaryId !== null && employment.employerSubsidiaryId !== scope.employerSubsidiaryId) {
    return false;
  }
  if (scope.departmentId !== null && employment.departmentId !== scope.departmentId) {
    return false;
  }
  return true;
}

export interface TurnoverInputs {
  /** Headcount at the period start (from getHeadcountAsOf at period start). */
  readonly headcountStart: number;
  /** Headcount at the period end (from getHeadcountAsOf at period end). */
  readonly headcountEnd: number;
  /** Employments whose service ended inside the period. */
  readonly terminations: number;
  /** …of which voluntary (resignation, retirement). */
  readonly voluntary: number;
  /** …of which the org calls regrettable. */
  readonly regrettable: number;
  /** Tenure in days of each leaver, for the median. */
  readonly tenureDays: readonly number[];
}

export interface TurnoverResult {
  /** Terminations / average headcount, null when the average is zero. */
  readonly turnoverRate: number | null;
  readonly voluntaryRate: number | null;
  readonly involuntaryRate: number | null;
  /** Regrettable leavers / all leavers, null when nobody left. */
  readonly regrettableShare: number | null;
  /** Median tenure in days across leavers, null when nobody left. */
  readonly medianTenureDays: number | null;
}

/**
 * Turnover for one period: terminations over average headcount, split
 * voluntary vs involuntary, with the regrettable share and the median
 * leaver tenure. Counts arrive from the retention read (headcount from
 * getHeadcountAsOf at both ends, leavers from the version history plus
 * exit records); the division lives here so it is unit-testable on a fixed
 * series. A zero average headcount yields null rates — refusing by shape
 * would hide a real empty period, and dividing would lie.
 */
export function computeTurnover(inputs: TurnoverInputs): TurnoverResult {
  for (const [key, value] of [
    ["headcountStart", inputs.headcountStart],
    ["headcountEnd", inputs.headcountEnd],
    ["terminations", inputs.terminations],
    ["voluntary", inputs.voluntary],
    ["regrettable", inputs.regrettable],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new PerformanceMathError(`turnover ${key} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
  if (inputs.voluntary > inputs.terminations) {
    throw new PerformanceMathError(
      `voluntary leavers (${inputs.voluntary}) cannot exceed all leavers (${inputs.terminations})`,
    );
  }
  if (inputs.regrettable > inputs.terminations) {
    throw new PerformanceMathError(
      `regrettable leavers (${inputs.regrettable}) cannot exceed all leavers (${inputs.terminations})`,
    );
  }
  for (const days of inputs.tenureDays) {
    if (!Number.isInteger(days) || days < 0) {
      throw new PerformanceMathError(`leaver tenure must be non-negative days, got ${JSON.stringify(days)}`);
    }
  }
  const average = (inputs.headcountStart + inputs.headcountEnd) / 2;
  const sorted = [...inputs.tenureDays].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  if (average === 0) {
    return {
      turnoverRate: null,
      voluntaryRate: null,
      involuntaryRate: null,
      regrettableShare: inputs.terminations === 0 ? null : inputs.regrettable / inputs.terminations,
      medianTenureDays: median,
    };
  }
  return {
    turnoverRate: inputs.terminations / average,
    voluntaryRate: inputs.voluntary / average,
    involuntaryRate: (inputs.terminations - inputs.voluntary) / average,
    regrettableShare: inputs.terminations === 0 ? null : inputs.regrettable / inputs.terminations,
    medianTenureDays: median,
  };
}
