/**
 * Pure civil-time temporal primitives for employment effective history.
 *
 * Date-only semantics: civil ISO dates (YYYY-MM-DD) ordered on an integer
 * day grid. No Date objects, no time zones, no DST on the civil path.
 * Recorded time is a UTC instant compared as an (epochSecond, nano)
 * integer tuple, so sub-millisecond precision (for example PostgreSQL
 * microseconds) never collapses into equal JS milliseconds.
 *
 * Half-open everywhere: an effective interval covers
 * [start, end), and a recorded window covers
 * [recordedAt, recordedUntil). A null end / recordedUntil is unbounded.
 * Adjacent intervals ([a,b), [b,c)) do NOT overlap.
 *
 * Scope rule: overlap validation and as-of resolution each operate on ONE
 * stable identity chain (one employment, one assignment). Callers partition
 * by identity first, so legitimate simultaneous assignments are never
 * rejected. Supersession must be explicit: a correction sets the old
 * revision's recordedUntil to the new revision's recordedAt in the same
 * write. More than one live applicable revision for one identity at one
 * as-known instant is an inconsistent chain and is refused, never
 * silently resolved.
 *
 * Zero imports: business-date.ts couples to db.ts (pool creation at
 * import), so this module mirrors its civil validation semantics in
 * dependency-free integer arithmetic instead of importing it.
 *
 * Database boundary: recorded stamps cross as exact UTC text (read PG
 * timestamptz as text, never through JS Date, which truncates
 * microseconds). Civil dates cross as YYYY-MM-DD text; the null
 * unbounded end maps to 'infinity' only inside SQL range expressions.
 */

export type CivilDate = string & { readonly __civilDate: unique symbol };

export interface EffectiveInterval {
  readonly start: CivilDate;
  readonly end: CivilDate | null;
}

export interface RecordedRevision<P> {
  readonly effective: EffectiveInterval;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
  readonly payload: P;
}

export interface AsOfQuery {
  readonly effective: string;
  readonly asKnown: string;
}

export type TemporalErrorCode =
  | "INVALID_DATE"
  | "EMPTY_INTERVAL"
  | "OVERLAP"
  | "NO_REVISION"
  | "AMBIGUOUS_REVISION"
  | "INVALID_RECORDED_STAMP"
  | "EMPTY_RECORDED_WINDOW";

export class TemporalError extends Error {
  readonly code: TemporalErrorCode;
  constructor(code: TemporalErrorCode, message: string) {
    super(message);
    this.name = "TemporalError";
    this.code = code;
  }
}

export class InvalidCivilDateError extends TemporalError {
  constructor(value: unknown) {
    super(
      "INVALID_DATE",
      `invalid civil date ${preview(value)}: use a real YYYY-MM-DD calendar date in years 0001 through 9999`,
    );
    this.name = "InvalidCivilDateError";
  }
}

export class EmptyIntervalError extends TemporalError {
  constructor(start: string, end: string) {
    super(
      "EMPTY_INTERVAL",
      `effective end ${end} must be after start ${start}; use null for an unbounded interval`,
    );
    this.name = "EmptyIntervalError";
  }
}

export class OverlappingIntervalsError extends TemporalError {
  constructor(first: number, second: number) {
    super(
      "OVERLAP",
      `effective intervals ${first} and ${second} overlap: split at a shared boundary or partition by stable identity before validating`,
    );
    this.name = "OverlappingIntervalsError";
  }
}

export class NoRevisionError extends TemporalError {
  constructor(effective: string, asKnown: string) {
    super(
      "NO_REVISION",
      `no revision covers effective date ${effective} as known at ${asKnown}: check the query dates or record a revision for that identity`,
    );
    this.name = "NoRevisionError";
  }
}

export class AmbiguousRevisionError extends TemporalError {
  constructor(detail: string) {
    super(
      "AMBIGUOUS_REVISION",
      `refusing ambiguous revision: ${detail}; supersede all but one revision by setting recordedUntil so exactly one revision is live`,
    );
    this.name = "AmbiguousRevisionError";
  }
}

export class InvalidRecordedStampError extends TemporalError {
  constructor(field: string, value: unknown) {
    super(
      "INVALID_RECORDED_STAMP",
      `invalid ${field} ${preview(value)}: record UTC instants as YYYY-MM-DDTHH:mm:ss[.fraction]Z`,
    );
    this.name = "InvalidRecordedStampError";
  }
}

export class EmptyRecordedWindowError extends TemporalError {
  constructor(recordedAt: string, recordedUntil: string) {
    super(
      "EMPTY_RECORDED_WINDOW",
      `recordedUntil ${recordedUntil} must be after recordedAt ${recordedAt}; use null while the revision is still current`,
    );
    this.name = "EmptyRecordedWindowError";
  }
}

function preview(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = `array[${value.length}]`;
  } else {
    text = typeof value;
  }
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

interface CivilParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function splitCivilDate(value: string): CivilParts | null {
  const match = CIVIL_DATE_PATTERN.exec(value);
  // match[0] !== value rejects trailing newlines: JS $ also matches before
  // a final \n, so the pattern anchor alone is not a full-string match.
  if (match === null || match[0] !== value) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isSafeInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Strict validation: format, year range, and real calendar day. */
export function parseCivilDate(value: unknown): CivilDate {
  if (typeof value !== "string" || splitCivilDate(value) === null) {
    throw new InvalidCivilDateError(value);
  }
  return value as CivilDate;
}

/** Boolean boundary for callers that report invalid dates instead of throwing. */
export function isCivilDate(value: unknown): value is CivilDate {
  return typeof value === "string" && splitCivilDate(value) !== null;
}

/**
 * Days since 0001-01-01 (which is day 0), proleptic Gregorian calendar.
 * Integer arithmetic only; every intermediate value is an exact integer.
 */
function dayNumberOf(parts: CivilParts): number {
  const shiftedYear = parts.month <= 2 ? parts.year - 1 : parts.year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthPrime = parts.month > 2 ? parts.month - 3 : parts.month + 9;
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + parts.day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 306;
}

function dayNumber(date: CivilDate): number {
  const parts = splitCivilDate(date);
  if (parts === null) throw new InvalidCivilDateError(date);
  return dayNumberOf(parts);
}

/** Total order on the civil grid: -1, 0, or 1. */
export function compareCivilDates(first: unknown, second: unknown): -1 | 0 | 1 {
  const left = dayNumber(parseCivilDate(first));
  const right = dayNumber(parseCivilDate(second));
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build a validated half-open [start, end) interval. Null end is
 * unbounded. An end on or before the start is an empty interval and is
 * refused; only null means unbounded, so an omitted end cannot slip
 * through as undefined.
 */
export function makeEffectiveInterval(start: unknown, end: unknown): EffectiveInterval {
  const parsedStart = parseCivilDate(start);
  if (end === null) return { start: parsedStart, end: null };
  const parsedEnd = parseCivilDate(end);
  if (dayNumber(parsedEnd) <= dayNumber(parsedStart)) {
    throw new EmptyIntervalError(parsedStart, parsedEnd);
  }
  return { start: parsedStart, end: parsedEnd };
}

function validatedBounds(interval: EffectiveInterval): { start: number; end: number } {
  const start = dayNumber(parseCivilDate(interval.start));
  if (interval.end === null) return { start, end: Number.POSITIVE_INFINITY };
  const end = dayNumber(parseCivilDate(interval.end));
  if (end <= start) throw new EmptyIntervalError(interval.start, String(interval.end));
  return { start, end };
}

/** Half-open membership: start <= date < end (null end is unbounded). */
export function containsDate(interval: EffectiveInterval, date: unknown): boolean {
  const bounds = validatedBounds(interval);
  const target = dayNumber(parseCivilDate(date));
  return bounds.start <= target && target < bounds.end;
}

/**
 * Range-overlap (&&) semantics on [start, end) bounds: adjacency is NOT
 * overlap. Mirrors daterange(from, coalesce(to, 'infinity'), '[)').
 */
export function intervalsOverlap(
  first: EffectiveInterval,
  second: EffectiveInterval,
): boolean {
  const left = validatedBounds(first);
  const right = validatedBounds(second);
  return left.start < right.end && right.start < left.end;
}

/**
 * Disjointness for ONE stable identity timeline. Throws on the first
 * overlapping pair (original indices). Partition by identity before
 * calling; simultaneous assignments across identities must each pass
 * separately and are never compared here.
 */
export function assertNoOverlap(intervals: readonly EffectiveInterval[]): void {
  if (!Array.isArray(intervals)) {
    throw new TemporalError("OVERLAP", "expected an array of effective intervals");
  }
  const decorated = intervals.map((interval, index) => ({ ...validatedBounds(interval), index }));
  decorated.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  let openEnd = Number.NEGATIVE_INFINITY;
  let openIndex = -1;
  for (const current of decorated) {
    if (current.start < openEnd) {
      throw new OverlappingIntervalsError(openIndex, current.index);
    }
    if (current.end > openEnd) {
      openEnd = current.end;
      openIndex = current.index;
    }
  }
}

const RECORDED_STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const DAY_1970 = 719162;
const SECONDS_PER_DAY = 86400;

interface RecordedStamp {
  readonly epochSecond: number;
  readonly nano: number;
}

/**
 * Strict UTC instant with up to nanosecond fraction. Compared as an
 * integer (second, nano) tuple, so distinct sub-millisecond stamps never
 * collapse. Leap second 60 is refused; a UTC day has no 60th second in
 * the recorded-time contract.
 */
function parseRecordedStamp(value: unknown, field: string): RecordedStamp {
  if (typeof value !== "string") throw new InvalidRecordedStampError(field, value);
  const match = RECORDED_STAMP_PATTERN.exec(value);
  // See splitCivilDate: $ matches before a trailing newline, so the
  // full-string check carries the strictness, not the anchor.
  if (match === null || match[0] !== value) {
    throw new InvalidRecordedStampError(field, value);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !Number.isSafeInteger(year) || year < 1 || year > 9999 ||
    !Number.isSafeInteger(month) || month < 1 || month > 12 ||
    !Number.isSafeInteger(day) || day < 1 || day > daysInMonth(year, month) ||
    !Number.isSafeInteger(hour) || hour > 23 ||
    !Number.isSafeInteger(minute) || minute > 59 ||
    !Number.isSafeInteger(second) || second > 59
  ) {
    throw new InvalidRecordedStampError(field, value);
  }
  const fraction = match[7] ?? "";
  const nano = fraction === "" ? 0 : Number(fraction.padEnd(9, "0"));
  const epochSecond =
    (dayNumberOf({ year, month, day }) - DAY_1970) * SECONDS_PER_DAY +
    hour * 3600 +
    minute * 60 +
    second;
  return { epochSecond, nano };
}

function compareRecordedStamps(first: RecordedStamp, second: RecordedStamp): -1 | 0 | 1 {
  if (first.epochSecond !== second.epochSecond) {
    return first.epochSecond < second.epochSecond ? -1 : 1;
  }
  if (first.nano !== second.nano) return first.nano < second.nano ? -1 : 1;
  return 0;
}

/**
 * Build a validated revision: a non-empty effective window plus a
 * non-empty recorded window [recordedAt, recordedUntil). Null
 * recordedUntil means still current. Equal or inverted recorded bounds
 * are an empty window and are refused.
 */
export function makeRecordedRevision<P>(
  effective: EffectiveInterval,
  recordedAt: unknown,
  recordedUntil: unknown,
  payload: P,
): RecordedRevision<P> {
  const window = makeEffectiveInterval(effective.start, effective.end);
  if (typeof recordedAt !== "string") {
    throw new InvalidRecordedStampError("recordedAt", recordedAt);
  }
  const at = parseRecordedStamp(recordedAt, "recordedAt");
  if (recordedUntil === null) {
    return { effective: window, recordedAt, recordedUntil: null, payload };
  }
  if (typeof recordedUntil !== "string") {
    throw new InvalidRecordedStampError("recordedUntil", recordedUntil);
  }
  const until = parseRecordedStamp(recordedUntil, "recordedUntil");
  if (compareRecordedStamps(until, at) <= 0) {
    throw new EmptyRecordedWindowError(recordedAt, recordedUntil);
  }
  return { effective: window, recordedAt, recordedUntil, payload };
}

interface LiveRevision<P> {
  readonly revision: RecordedRevision<P>;
  readonly index: number;
}

/**
 * Deterministic as-of resolution for ONE stable identity chain.
 *
 * A revision applies when its recorded window covers asKnown
 * (recordedAt <= asKnown < recordedUntil, null until is unbounded) AND
 * its effective interval covers the effective date. Zero applicable
 * revisions is a refusal (NoRevisionError), never a silent null. More
 * than one applicable revision is an inconsistent chain and is refused
 * (AmbiguousRevisionError) even with distinct recordedAt values: proper
 * supersession chains hand off at recordedUntil boundaries, so exactly
 * one revision can ever be live. Input order is irrelevant.
 */
export function resolveAsOf<P>(
  revisions: readonly RecordedRevision<P>[],
  query: AsOfQuery,
): RecordedRevision<P> {
  if (!Array.isArray(revisions)) {
    throw new TemporalError("NO_REVISION", "expected an array of revisions");
  }
  const effective = parseCivilDate(query.effective);
  const asKnown = parseRecordedStamp(query.asKnown, "asKnown");
  const applicable: LiveRevision<P>[] = [];
  revisions.forEach((revision, index) => {
    const clean = makeRecordedRevision(
      revision.effective,
      revision.recordedAt,
      revision.recordedUntil,
      revision.payload,
    );
    const at = parseRecordedStamp(clean.recordedAt, "recordedAt");
    const until =
      clean.recordedUntil === null
        ? null
        : parseRecordedStamp(clean.recordedUntil, "recordedUntil");
    const live =
      compareRecordedStamps(at, asKnown) <= 0 &&
      (until === null || compareRecordedStamps(asKnown, until) < 0);
    if (live && containsDate(clean.effective, effective)) {
      applicable.push({ revision: clean, index });
    }
  });
  if (applicable.length === 0) {
    throw new NoRevisionError(effective, query.asKnown);
  }
  if (applicable.length > 1) {
    const detail = applicable
      .map((item) =>
        `#${item.index} recorded [${item.revision.recordedAt}, ${item.revision.recordedUntil ?? "unbounded"})`
      )
      .join("; ");
    throw new AmbiguousRevisionError(
      `${applicable.length} live revisions cover ${effective} as known at ${query.asKnown} (${detail})`,
    );
  }
  const winner = applicable[0];
  if (winner === undefined) throw new NoRevisionError(effective, query.asKnown);
  return winner.revision;
}
