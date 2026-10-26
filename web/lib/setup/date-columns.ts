import { sql, type SQL } from "drizzle-orm";
import { civilDateLabelSql } from "@openbooks/engine/platform/civil-date-labels";
import { formatCivilDate, viewerDate } from "../format";
import { toSnake, type SetupColumn } from "./registry";

/**
 * Display and search for Setup `date` columns.
 *
 * Effective dates and other civil dates are stored as `YYYY-MM-DD` and read
 * as that calendar day in the viewer's locale, never shifted by a time zone.
 * A `date` column bound to a timestamp reads as the calendar day of that
 * instant in the organization's time zone. Edit forms keep the ISO value;
 * only the list text changes, and the list search matches that text as well
 * as the stored ISO value.
 */

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}[ T]\d/;
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

export function setupDateLabel(raw: unknown, locale: string, timeZone: string): string {
  if (raw == null || raw === "") return "—";
  if (raw instanceof Date)
    return Number.isNaN(raw.getTime()) ? "—" : viewerDate(raw, locale, timeZone, DATE_OPTIONS);
  const text = String(raw);
  if (CIVIL_DATE.test(text)) return formatCivilDate(text, locale);
  if (INSTANT.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime()))
      return viewerDate(instant, locale, timeZone, DATE_OPTIONS);
  }
  return text;
}

/**
 * The list-search predicate for one Setup column: the stored value as text,
 * and for `date` columns also the localized label the list shows.
 */
export function setupColumnSearchSql(
  column: SetupColumn,
  query: string,
  locale: string,
  timeZone: string,
): SQL {
  const stored = sql`cast(${sql.raw(toSnake(column.key))} as text)`;
  const pattern = `%${query}%`;
  if (column.kind !== "date") return sql`${stored} ilike ${pattern}`;
  const civil = civilDateLabelSql(sql`(${stored})::date`, locale);
  const instant = civilDateLabelSql(
    sql`((${stored})::timestamptz at time zone ${timeZone})::date`,
    locale,
  );
  return sql`(${stored} ilike ${pattern} or (case
    when ${stored} ~ ${CIVIL_DATE.source} then ${civil}
    when ${stored} ~ ${INSTANT.source} then ${instant}
  end) ilike ${pattern})`;
}
