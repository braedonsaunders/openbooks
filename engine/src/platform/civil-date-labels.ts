import { sql, type SQL } from "drizzle-orm";

/**
 * Localized labels for civil (calendar) dates, rendered identically in
 * TypeScript and in SQL.
 *
 * A civil date has no time zone: `2026-01-01` is the first of January for
 * every viewer, so labels are built from the date's own year, month and day
 * and never pass through an instant. Each locale's Intl format is captured
 * once as one template per month with the day and year replaced by tokens;
 * the TypeScript renderer and the SQL expression both fill the same
 * templates, so a search over a label matches exactly the text a list shows
 * in the viewer's locale.
 */

export type CivilDateLabelStyle = "date" | "monthYear";

const STYLE_OPTIONS: Record<CivilDateLabelStyle, Intl.DateTimeFormatOptions> = {
  date: { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
  monthYear: { year: "numeric", month: "short", timeZone: "UTC" },
};

/** Token stand-ins; control characters never appear in Intl output. */
const YEAR_TOKEN = "\u0001";
const DAY_TOKEN = "\u0002";
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

interface LabelTemplates {
  /** Twelve localized templates, January first, with day/year as tokens. */
  months: string[];
  /** The locale's digits for 0-9, so numbers render in its numbering system. */
  digits: string;
}

const cache = new Map<string, LabelTemplates>();

function labelTemplates(locale: string, style: CivilDateLabelStyle): LabelTemplates {
  const key = `${style}\u0000${locale}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, STYLE_OPTIONS[style]);
  const months = Array.from({ length: 12 }, (_, index) =>
    formatter
      .formatToParts(new Date(`2001-${String(index + 1).padStart(2, "0")}-15T12:00:00Z`))
      .map((part) =>
        part.type === "year" ? YEAR_TOKEN : part.type === "day" ? DAY_TOKEN : part.value,
      )
      .join(""),
  );
  const numbers = new Intl.NumberFormat(locale, {
    numberingSystem: formatter.resolvedOptions().numberingSystem,
    useGrouping: false,
  });
  const digits = Array.from({ length: 10 }, (_, digit) => numbers.format(digit)).join("");
  const resolved = { months, digits };
  cache.set(key, resolved);
  return resolved;
}

function localizedNumber(value: string, digits: string): string {
  return [...value.replace(/^0+(?=\d)/, "")]
    .map((digit) => digits[Number(digit)] ?? digit)
    .join("");
}

/**
 * `Jan 1, 2026` (style `date`) or `Jan 2026` (style `monthYear`) for a
 * `YYYY-MM-DD` civil date in the given locale. A timestamp suffix is ignored;
 * anything that does not start with a civil date is refused.
 */
export function civilDateLabel(
  isoDate: string,
  locale: string,
  style: CivilDateLabelStyle = "date",
): string {
  const match = CIVIL_DATE.exec(isoDate);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw new RangeError(`a civil date must be YYYY-MM-DD, received "${isoDate}"`);
  }
  const templates = labelTemplates(locale, style);
  return templates.months[month - 1]!.replace(
    DAY_TOKEN,
    localizedNumber(match[3]!, templates.digits),
  ).replace(YEAR_TOKEN, localizedNumber(match[1]!, templates.digits));
}

/**
 * SQL form of civilDateLabel over a `date`-typed expression. Null in, null
 * out, so the expression composes into `ilike` searches without coalescing.
 */
export function civilDateLabelSql(
  date: SQL,
  locale: string,
  style: CivilDateLabelStyle = "date",
): SQL {
  const templates = labelTemplates(locale, style);
  const months = sql`array[${sql.join(
    templates.months.map((template) => sql`${template}`),
    sql`, `,
  )}]::text[]`;
  const digits = (part: SQL) =>
    sql`translate(${part}::int::text, '0123456789', ${templates.digits})`;
  return sql`replace(replace((${months})[extract(month from ${date})::int], ${DAY_TOKEN}, ${digits(sql`extract(day from ${date})`)}), ${YEAR_TOKEN}, ${digits(sql`extract(year from ${date})`)})`;
}
