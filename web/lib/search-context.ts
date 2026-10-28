import "server-only";
import { sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db, memoizedRead } from "@openbooks/engine/platform/database";
import { businessToday } from "@openbooks/engine/platform/business-date";
import {
  localeMonthNames,
  mergeVocabulary,
  SEARCH_SCOPES,
  SEARCH_STATUSES,
  type ParseOptions,
  type SearchVocabulary,
} from "./search-query";

/**
 * Everything a query is read against for one reader: their language's
 * search vocabulary (always alongside English), the organization's business
 * date and fiscal-year start, and the order the reader writes numeric dates
 * in. Read once per search scope.
 */
export async function searchParseOptions(orgId: string): Promise<ParseOptions> {
  return memoizedRead(`search-parse-options:${orgId}`, async () => {
    const [locale, today, fiscalYearStartMonth] = await Promise.all([
      readerLocale(),
      businessToday(orgId),
      fiscalStartMonth(orgId),
    ]);
    const vocabulary = locale === "en" ? null : await localeVocabulary(locale);
    return {
      vocabulary: mergeVocabulary(vocabulary, localeMonthNames(locale)),
      today,
      dateOrder: numericDateOrder(locale),
      fiscalYearStartMonth,
    };
  });
}

/**
 * The reader's language. Outside a request (the application finder behind
 * the API and agent tools) there is no reader locale, and the query is read
 * in English, which every reading understands.
 */
async function readerLocale(): Promise<string> {
  try {
    return await getLocale();
  } catch {
    return "en";
  }
}

/** The first month of the organization's default fiscal calendar (January when none is set). */
async function fiscalStartMonth(orgId: string): Promise<number> {
  const rows = await db.execute<{ month: number }>(
    sql`select year_start_month as month from fiscal_calendars
         where org_id = ${orgId} and is_default and is_active
         order by created_at limit 1`,
    "objects",
  );
  const month = Number(rows[0]?.month);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
}

/** Whether the locale writes a numeric date month first, day first or year first. */
export function numericDateOrder(locale: string): ParseOptions["dateOrder"] {
  const date = new Date(0);
  date.setUTCFullYear(2001, 10, 22);
  const order = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .map((part) => part.type)
    .filter((type) => type === "year" || type === "month" || type === "day");
  if (order[0] === "year") return "ymd";
  return order[0] === "day" ? "dmy" : "mdy";
}

/**
 * The reader's search vocabulary from the message catalog. Each entry is a
 * list of phrases separated by "|".
 */
async function localeVocabulary(locale: string): Promise<Partial<SearchVocabulary> | null> {
  const t = await getTranslations({ locale, namespace: "shell.globalSearch.vocabulary" });
  const list = (key: string): string[] =>
    t.has(key as never)
      ? t(key as never)
          .split("|")
          .map((phrase) => phrase.trim().toLowerCase().replace(/\s+/g, " "))
          .filter(Boolean)
      : [];
  const scopes: SearchVocabulary["scopes"] = {};
  for (const scope of SEARCH_SCOPES) scopes[scope] = list(`scopes.${scope}`);
  const statuses: SearchVocabulary["statuses"] = {};
  for (const status of SEARCH_STATUSES) statuses[status] = list(`statuses.${status}`);
  const keys = [
    "greater",
    "greaterOrEqual",
    "less",
    "lessOrEqual",
    "between",
    "and",
    "approximately",
    "since",
    "before",
    "through",
    "during",
    "today",
    "yesterday",
    "tomorrow",
    "thisPeriod",
    "lastPeriod",
    "nextPeriod",
    "pastPeriod",
    "day",
    "week",
    "month",
    "quarter",
    "year",
    "yearToDate",
    "monthToDate",
    "quarterToDate",
    "stopwords",
  ] as const;
  const vocabulary: Partial<SearchVocabulary> = { scopes, statuses };
  for (const key of keys) (vocabulary as Record<string, string[]>)[key] = list(key);
  return vocabulary;
}
