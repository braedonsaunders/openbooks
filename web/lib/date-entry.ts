import {
  addCalendarDays,
  addMonthsClamped,
  addMonthsStart,
  calendarDaysBetween,
  civilDateFromParts,
  daysInCivilMonth,
  endOfMonth,
  isIsoCalendarDate,
  parseIsoDate,
  startOfMonth,
  utcDateFromParts,
} from "@openbooks/engine/platform/civil-date";

/**
 * Keyboard grammar and forgiving typed entry for date fields.
 *
 * Every function here is pure civil-date arithmetic on YYYY-MM-DD strings:
 * no local-timezone Date math, and "today" is always the organization's
 * business date supplied by the caller. Typed text is read in the viewer's
 * date order; anything that cannot be read as exactly one real calendar date
 * refuses instead of rolling over to a neighbouring day.
 */

export type DateOrder = "mdy" | "dmy" | "ymd";

/** ISO weekday the week starts on: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DateEntryContext {
  /**
   * Organization business date (YYYY-MM-DD), or null where none is known.
   * Without one, entry that is relative to it (a missing or two-digit year)
   * refuses instead of guessing from the browser clock.
   */
  today: string | null;
  /** Viewer locale used for date order and month names. */
  locale: string;
  /** First day of the week for W/K. */
  weekStartsOn: IsoWeekday;
}

export type TypedDateResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "empty" | "unrecognized" | "impossible" | "needsYear" };

/** A typed shape that reads only against a business date nobody supplied. */
const NEEDS_YEAR = Symbol("needsYear");

/**
 * The single-key commands a focused date field accepts. Letters are matched
 * case-insensitively; `=` is the unshifted `+` key and `_` the shifted `-`.
 */
export const DATE_ENTRY_KEYS = [
  { keys: ["+", "="], command: "nextDay" },
  { keys: ["-", "_"], command: "previousDay" },
  { keys: ["t"], command: "today" },
  { keys: ["w"], command: "weekStart" },
  { keys: ["k"], command: "weekEnd" },
  { keys: ["m"], command: "monthStart" },
  { keys: ["h"], command: "monthEnd" },
  { keys: ["y"], command: "yearStart" },
  { keys: ["r"], command: "yearEnd" },
] as const;

export type DateEntryCommand = (typeof DATE_ENTRY_KEYS)[number]["command"];

/** The date command bound to a `KeyboardEvent.key`, or null for any other key. */
export function dateEntryCommand(key: string): DateEntryCommand | null {
  const normalized = key.length === 1 ? key.toLowerCase() : key;
  for (const entry of DATE_ENTRY_KEYS) {
    if ((entry.keys as readonly string[]).includes(normalized)) return entry.command;
  }
  return null;
}

function isoWeekdayOf(iso: string): IsoWeekday {
  const day = parseIsoDate(iso).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

/** First day of the week containing `iso`, for a week starting on `weekStartsOn`. */
export function startOfWeek(iso: string, weekStartsOn: IsoWeekday): string {
  const offset = (isoWeekdayOf(iso) - weekStartsOn + 7) % 7;
  return addCalendarDays(iso, -offset);
}

/** Last day of the week containing `iso`. */
export function endOfWeek(iso: string, weekStartsOn: IsoWeekday): string {
  return addCalendarDays(startOfWeek(iso, weekStartsOn), 6);
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/**
 * The date a command moves a field to. `current` is the field's value; an
 * empty or unreadable value starts from the business date. Period keys are
 * repeatable: pressing a "first day" key on a first day steps back one
 * period, and a "last day" key on a last day steps forward one period. A
 * step past the supported calendar (years 0001–9999), or a step that needs
 * a business date when none is known, returns null.
 */
export function applyDateEntryCommand(
  command: DateEntryCommand,
  current: string,
  context: Pick<DateEntryContext, "today" | "weekStartsOn">,
): string | null {
  const base = isIsoCalendarDate(current) ? current : context.today;
  if (base === null || (command === "today" && context.today === null)) return null;
  try {
    switch (command) {
      case "nextDay":
        return addCalendarDays(base, 1);
      case "previousDay":
        return addCalendarDays(base, -1);
      case "today":
        return context.today ?? null;
      case "weekStart": {
        const start = startOfWeek(base, context.weekStartsOn);
        return start === base ? addCalendarDays(base, -7) : start;
      }
      case "weekEnd": {
        const end = endOfWeek(base, context.weekStartsOn);
        return end === base ? addCalendarDays(base, 7) : end;
      }
      case "monthStart": {
        const start = startOfMonth(base);
        return start === base ? addMonthsStart(base, -1) : start;
      }
      case "monthEnd": {
        const end = endOfMonth(base);
        return end === base ? endOfMonth(addMonthsStart(base, 1)) : end;
      }
      case "yearStart": {
        const year = yearOf(base);
        const start = civilDateFromParts(year, 1, 1);
        return start === base ? yearBoundary(year - 1, 1, 1) : start;
      }
      case "yearEnd": {
        const year = yearOf(base);
        const end = civilDateFromParts(year, 12, 31);
        return end === base ? yearBoundary(year + 1, 12, 31) : end;
      }
    }
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function yearBoundary(year: number, month1: number, day: number): string | null {
  if (year < 1 || year > 9999) return null;
  return civilDateFromParts(year, month1, day);
}

const orderCache = new Map<string, DateOrder>();

/** The order in which `locale` writes a numeric day, month and year. */
export function dateOrderForLocale(locale: string): DateOrder {
  const cached = orderCache.get(locale);
  if (cached) return cached;
  const parts = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  })
    .formatToParts(utcDateFromParts(2001, 10, 23))
    .map((part) => part.type)
    .filter((type) => type === "year" || type === "month" || type === "day");
  const order: DateOrder = parts[0] === "year" ? "ymd" : parts[0] === "day" ? "dmy" : "mdy";
  orderCache.set(locale, order);
  return order;
}

/**
 * First day of the week for `locale` from CLDR week data. Runtimes without
 * week data use the ISO 8601 Monday start.
 */
export function firstDayOfWeekForLocale(locale: string): IsoWeekday {
  try {
    const tag = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = tag.getWeekInfo?.().firstDay ?? tag.weekInfo?.firstDay;
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7)
      return firstDay as IsoWeekday;
  } catch {
    // An unparseable tag falls through to the ISO default.
  }
  return 1;
}

/**
 * The viewer locale refined by the browser's region when both name the same
 * language: a viewer reading English on an en-GB browser types dates
 * day-first, as the browser's own date controls display them.
 */
export function regionalViewerLocale(
  viewerLocale: string,
  browserLanguages: readonly string[],
): string {
  const language = viewerLocale.split("-")[0]!.toLowerCase();
  if (viewerLocale.includes("-")) return viewerLocale;
  const match = browserLanguages.find(
    (tag) => tag.split("-")[0]!.toLowerCase() === language && tag.includes("-"),
  );
  return match ?? viewerLocale;
}

function foldMonthName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/\.$/, "").toLowerCase();
}

const monthNameCache = new Map<string, Array<[name: string, month: number]>>();

function monthNames(locale: string): Array<[name: string, month: number]> {
  const cached = monthNameCache.get(locale);
  if (cached) return cached;
  const names: Array<[string, number]> = [];
  for (const tag of new Set([locale, "en"])) {
    for (const width of ["long", "short"] as const) {
      const format = new Intl.DateTimeFormat(tag, { month: width, timeZone: "UTC" });
      for (let month = 1; month <= 12; month++) {
        const name = foldMonthName(format.format(utcDateFromParts(2001, month - 1, 15)));
        if (/^\p{L}+$/u.test(name)) names.push([name, month]);
      }
    }
  }
  monthNameCache.set(locale, names);
  return names;
}

/** The month a written name denotes (full name, or a unique prefix of at least three letters). */
function monthFromName(token: string, locale: string): number | null {
  const folded = foldMonthName(token);
  const matches = new Set<number>();
  for (const [name, month] of monthNames(locale)) {
    if (name === folded) return month;
    if (folded.length >= 3 && name.startsWith(folded)) matches.add(month);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/** Expand a one- or two-digit year to the century that puts it nearest the business year. */
function expandShortYear(year: number, businessYear: number): number {
  let expanded = Math.floor(businessYear / 100) * 100 + year;
  if (expanded > businessYear + 50) expanded -= 100;
  else if (expanded <= businessYear - 50) expanded += 100;
  return expanded;
}

function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isSafeInteger(day) || day < 1 || day > daysInCivilMonth(year, month)) return null;
  return civilDateFromParts(year, month, day);
}

/**
 * A month and day with no year read in the business year. Near the turn of
 * the year the adjacent year wins when its occurrence is within a quarter of
 * the business date and the business-year occurrence is more than half a
 * year away: 12/28 entered on January 5 is the December just ended, and 1/3
 * entered on December 28 is the coming January.
 */
function yearlessDate(month: number, day: number, today: string): string | null {
  const businessYear = yearOf(today);
  const current = validDate(businessYear, month, day);
  if (current && Math.abs(calendarDaysBetween(today, current)) <= 183) return current;
  for (const year of [businessYear - 1, businessYear + 1]) {
    const adjacent = validDate(year, month, day);
    if (adjacent && Math.abs(calendarDaysBetween(today, adjacent)) <= 92) return adjacent;
  }
  return current;
}

type Resolved = string | null | undefined | typeof NEEDS_YEAR;

function resolveYear(
  token: string | undefined,
  month: number,
  day: number,
  today: string | null,
): string | null | typeof NEEDS_YEAR {
  if (token === undefined) return today === null ? NEEDS_YEAR : yearlessDate(month, day, today);
  if (token.length === 3) return null;
  if (token.length <= 2 && today === null) return NEEDS_YEAR;
  const year = token.length <= 2 ? expandShortYear(Number(token), yearOf(today!)) : Number(token);
  return validDate(year, month, day);
}

const SEPARATORS = /[\s/.\-,年月日]+/gu;
const ALLOWED = /^[\p{L}0-9\s/.\-,']+$/u;

/**
 * Read a typed date. Accepts ISO YYYY-MM-DD always; otherwise the viewer's
 * day/month/year order with `/`, `-`, `.`, spaces or CJK date markers as
 * separators, one- or two-digit years (nearest century to the business
 * year), a missing year (the business year, or the adjacent year across a
 * near year end), month names in the viewer's language or English, and
 * compact digit runs (YYYYMMDD, or the locale order as 4, 6 or 8 digits).
 * Text that names an impossible date (February 30) or that cannot be read
 * unambiguously refuses; it is never normalized into a different day.
 * Without a business date, text that omits the century refuses with
 * `needsYear`.
 */
export function parseTypedDate(
  text: string,
  context: Pick<DateEntryContext, "today" | "locale">,
): TypedDateResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  // The ISO guard narrows its argument to `string`, so test a widened copy
  // and keep `trimmed` a string for the free-form reading below.
  const candidate: unknown = trimmed;
  if (isIsoCalendarDate(candidate)) return { ok: true, iso: candidate };
  const cleaned = trimmed
    .replace(/(\d)(?:st|nd|rd|th|er)\b/giu, "$1")
    .replace(/'(\d{2})\b/gu, "$1");
  if (!ALLOWED.test(cleaned.replace(/[年月日]/gu, " ")))
    return { ok: false, reason: "unrecognized" };
  const tokens = cleaned.split(SEPARATORS).filter(Boolean);
  const order = dateOrderForLocale(context.locale);
  const named = tokens.filter((token) => /^\p{L}+$/u.test(token));
  const numeric = tokens.filter((token) => /^[0-9]+$/.test(token));
  if (named.length + numeric.length !== tokens.length) return { ok: false, reason: "unrecognized" };

  let resolved: Resolved;
  if (named.length === 1) {
    resolved = readWithMonthName(named[0]!, numeric, context);
  } else if (named.length > 1) {
    return { ok: false, reason: "unrecognized" };
  } else if (numeric.length === 1) {
    resolved = readCompact(numeric[0]!, order, context.today);
  } else if (numeric.length === 2 || numeric.length === 3) {
    resolved = readNumeric(numeric, order, context.today);
  } else {
    return { ok: false, reason: "unrecognized" };
  }
  if (resolved === undefined) return { ok: false, reason: "unrecognized" };
  if (resolved === null) return { ok: false, reason: "impossible" };
  if (resolved === NEEDS_YEAR) return { ok: false, reason: "needsYear" };
  return { ok: true, iso: resolved };
}

/** undefined: the shape is not a date. null: a date shape naming no real day. */
function readNumeric(parts: string[], order: DateOrder, today: string | null): Resolved {
  if (parts.some((part) => part.length > 4)) return undefined;
  if (parts.length === 3 && parts[0]!.length >= 3) {
    if (parts[0]!.length !== 4) return undefined;
    return validDate(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (parts.length === 3 && order === "ymd") {
    return resolveYear(parts[0], Number(parts[1]), Number(parts[2]), today);
  }
  if (parts.length === 2 && parts.some((part) => part.length > 2)) return undefined;
  const [first, second, year] = parts;
  const month = Number(order === "dmy" ? second : first);
  const day = Number(order === "dmy" ? first : second);
  return resolveYear(year, month, day, today);
}

function readCompact(digits: string, order: DateOrder, today: string | null): Resolved {
  if (digits.length === 8) {
    const basic = validDate(
      Number(digits.slice(0, 4)),
      Number(digits.slice(4, 6)),
      Number(digits.slice(6, 8)),
    );
    if (basic || order === "ymd") return basic;
    return readNumeric([digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)], order, today);
  }
  if (digits.length === 6) {
    if (order === "ymd")
      return resolveYear(
        digits.slice(0, 2),
        Number(digits.slice(2, 4)),
        Number(digits.slice(4, 6)),
        today,
      );
    return readNumeric([digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)], order, today);
  }
  if (digits.length === 4) {
    return readNumeric(
      [digits.slice(0, 2), digits.slice(2, 4)],
      order === "ymd" ? "mdy" : order,
      today,
    );
  }
  return undefined;
}

function readWithMonthName(
  name: string,
  numeric: string[],
  context: Pick<DateEntryContext, "today" | "locale">,
): Resolved {
  const month = monthFromName(name, context.locale);
  if (month === null || numeric.length < 1 || numeric.length > 2) return undefined;
  if (numeric.some((part) => part.length > 4 || part.length === 3)) return undefined;
  // A four-digit number is the year wherever it stands ("2026 March 15",
  // "15 Mar 2026"); otherwise the first number is the day and a second one
  // is a short year ("Mar 15 26").
  const yearIndex = numeric.findIndex((part) => part.length === 4);
  const dayToken = yearIndex < 0 ? numeric[0] : numeric[yearIndex === 0 ? 1 : 0];
  const yearToken = yearIndex < 0 ? numeric[1] : numeric[yearIndex];
  if (dayToken === undefined || dayToken.length > 2) return undefined;
  return resolveYear(yearToken, month, Number(dayToken), context.today);
}

/**
 * Whether typed text is a whole date the way the viewer writes it: it reads
 * as a real date and states its year (or is a compact digit run that does).
 * A yearless "3-15" is still being typed — its next `-` is a separator, not
 * the previous-day key.
 */
export function isCompleteTypedDate(
  text: string,
  context: Pick<DateEntryContext, "today" | "locale">,
): boolean {
  if (!parseTypedDate(text, context).ok) return false;
  const tokens = text.trim().split(SEPARATORS).filter(Boolean);
  if (tokens.length === 1) return /^(?:\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/.test(tokens[0]!);
  return tokens.length >= 3;
}

/**
 * Whether `text` is the start of a month name in the viewer's language or
 * English ("ma" for March and May), so a field can tell a month being typed
 * from a single-letter date key.
 */
export function startsMonthName(text: string, locale: string): boolean {
  const folded = foldMonthName(text.trim());
  if (folded.length < 2 || !/^\p{L}+$/u.test(folded)) return false;
  return monthNames(locale).some(([name]) => name.startsWith(folded));
}

const entryFormatCache = new Map<string, Intl.DateTimeFormat>();

function entryFormat(locale: string): Intl.DateTimeFormat {
  let format = entryFormatCache.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    });
    entryFormatCache.set(locale, format);
  }
  return format;
}

/** Directional marks some locales place around date fields. */
const BIDI_MARKS = /[\u200e\u200f\u061c]/gu;

/**
 * A stored date as the viewer types it: numeric, in the locale's order and
 * separators, with a four-digit year so the text reads back as the same
 * day (`10/17/2026`, `17.10.2026`, `2026/10/17`). Empty stays empty; a value
 * that is not a calendar date is shown verbatim rather than reinterpreted.
 */
export function formatEntryDate(iso: string, locale: string): string {
  if (iso === "") return "";
  if (!isIsoCalendarDate(iso)) return iso;
  const [year, month, day] = [
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)),
    Number(iso.slice(8, 10)),
  ];
  return entryFormat(locale)
    .formatToParts(utcDateFromParts(year, month - 1, day))
    .map((part) => (part.type === "year" ? iso.slice(0, 4) : part.value))
    .join("")
    .replace(BIDI_MARKS, "");
}

/**
 * The entry pattern for `locale` with the given field symbols, e.g.
 * `mm/dd/yyyy` or `TT.MM.JJJJ`, for a field's placeholder.
 */
export function entryDatePattern(
  locale: string,
  symbols: { year: string; month: string; day: string },
): string {
  return entryFormat(locale)
    .formatToParts(utcDateFromParts(2001, 9, 23))
    .map((part) =>
      part.type === "year" || part.type === "month" || part.type === "day"
        ? symbols[part.type]
        : part.value,
    )
    .join("")
    .replace(BIDI_MARKS, "");
}

/** The same day `months` away, clamped to the target month's last day. */
export function shiftMonths(iso: string, months: number): string | null {
  try {
    return addMonthsClamped(iso, months);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** A day `days` away, or null past the supported calendar. */
export function shiftDays(iso: string, days: number): string | null {
  try {
    return addCalendarDays(iso, days);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * The six calendar weeks shown for a month: 42 consecutive days starting on
 * the configured first day of the week on or before the 1st. Weeks that
 * would fall outside the supported calendar are omitted.
 */
export function calendarWeeks(month: string, weekStartsOn: IsoWeekday): string[][] {
  const first = startOfMonth(month);
  const lead = (isoWeekdayOf(first) - weekStartsOn + 7) % 7;
  const weeks: string[][] = [];
  for (let week = 0; week < 6; week++) {
    const days: string[] = [];
    for (let day = 0; day < 7; day++) {
      const date = shiftDays(first, week * 7 + day - lead);
      if (date === null) break;
      days.push(date);
    }
    if (days.length === 7) weeks.push(days);
  }
  return weeks;
}
