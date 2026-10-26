import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDateEntryCommand,
  calendarWeeks,
  dateEntryCommand,
  dateOrderForLocale,
  entryDatePattern,
  firstDayOfWeekForLocale,
  formatEntryDate,
  isCompleteTypedDate,
  parseTypedDate,
  regionalViewerLocale,
  shiftMonths,
  startsMonthName,
  type DateEntryCommand,
} from "./date-entry";

const sundayWeek = { today: "2026-10-17", weekStartsOn: 7 as const };
const mondayWeek = { today: "2026-10-17", weekStartsOn: 1 as const };

function step(
  command: DateEntryCommand,
  current: string,
  context: { today: string; weekStartsOn: 1 | 7 } = sundayWeek,
) {
  return applyDateEntryCommand(command, current, context);
}

test("keys map case-insensitively to their commands and other keys to none", () => {
  assert.equal(dateEntryCommand("+"), "nextDay");
  assert.equal(dateEntryCommand("="), "nextDay");
  assert.equal(dateEntryCommand("-"), "previousDay");
  assert.equal(dateEntryCommand("T"), "today");
  assert.equal(dateEntryCommand("t"), "today");
  assert.equal(dateEntryCommand("H"), "monthEnd");
  for (const key of ["a", "1", "Enter", "ArrowUp", "/", "Tab"])
    assert.equal(dateEntryCommand(key), null, key);
});

test("day steps cross month, leap-day and year boundaries on the civil calendar", () => {
  assert.equal(step("nextDay", "2024-02-28"), "2024-02-29");
  assert.equal(step("nextDay", "2024-02-29"), "2024-03-01");
  assert.equal(step("nextDay", "2025-02-28"), "2025-03-01");
  assert.equal(step("previousDay", "2026-01-01"), "2025-12-31");
  assert.equal(step("nextDay", "2026-12-31"), "2027-01-01");
});

test("an empty or unreadable field starts from the business date, never the browser clock", () => {
  assert.equal(step("today", ""), "2026-10-17");
  assert.equal(step("today", "2020-01-01"), "2026-10-17");
  assert.equal(step("nextDay", ""), "2026-10-18");
  assert.equal(step("monthEnd", "not a date"), "2026-10-31");
});

test("first-day keys step back a period when already on a first day", () => {
  assert.equal(step("monthStart", "2026-03-17"), "2026-03-01");
  assert.equal(step("monthStart", "2026-03-01"), "2026-02-01");
  assert.equal(step("monthStart", "2026-01-01"), "2025-12-01");
  assert.equal(step("yearStart", "2026-06-30"), "2026-01-01");
  assert.equal(step("yearStart", "2026-01-01"), "2025-01-01");
});

test("last-day keys step forward a period when already on a last day, honoring leap years", () => {
  assert.equal(step("monthEnd", "2024-02-10"), "2024-02-29");
  assert.equal(step("monthEnd", "2024-01-31"), "2024-02-29");
  assert.equal(step("monthEnd", "2024-02-29"), "2024-03-31");
  assert.equal(step("monthEnd", "2025-01-31"), "2025-02-28");
  assert.equal(step("monthEnd", "2026-12-31"), "2027-01-31");
  assert.equal(step("yearEnd", "2026-03-01"), "2026-12-31");
  assert.equal(step("yearEnd", "2026-12-31"), "2027-12-31");
});

test("week keys follow the configured first day of the week and repeat by whole weeks", () => {
  // 2026-10-17 is a Saturday.
  assert.equal(step("weekStart", "2026-10-17", sundayWeek), "2026-10-11");
  assert.equal(
    step("weekEnd", "2026-10-17", sundayWeek),
    "2026-10-24",
    "Saturday already ends a Sunday week, so K moves a week on",
  );
  assert.equal(step("weekStart", "2026-10-11", sundayWeek), "2026-10-04");
  assert.equal(step("weekStart", "2026-10-17", mondayWeek), "2026-10-12");
  assert.equal(step("weekEnd", "2026-10-17", mondayWeek), "2026-10-18");
  assert.equal(step("weekEnd", "2026-10-18", mondayWeek), "2026-10-25");
  assert.equal(
    step("weekStart", "2027-01-02", mondayWeek),
    "2026-12-28",
    "a week spanning the year end starts in December",
  );
});

test("steps past the supported calendar refuse instead of wrapping", () => {
  assert.equal(step("nextDay", "9999-12-31"), null);
  assert.equal(step("yearEnd", "9999-12-31"), null);
  assert.equal(step("previousDay", "0001-01-01"), null);
  assert.equal(step("yearStart", "0001-01-01"), null);
});

test("locale date order and week start come from CLDR data", () => {
  assert.equal(dateOrderForLocale("en"), "mdy");
  assert.equal(dateOrderForLocale("en-GB"), "dmy");
  assert.equal(dateOrderForLocale("fr"), "dmy");
  assert.equal(dateOrderForLocale("de"), "dmy");
  assert.equal(dateOrderForLocale("ja"), "ymd");
  assert.equal(dateOrderForLocale("zh"), "ymd");
  assert.equal(firstDayOfWeekForLocale("de"), 1);
  assert.ok([1, 7].includes(firstDayOfWeekForLocale("en")));
  assert.equal(regionalViewerLocale("en", ["en-GB", "fr-FR"]), "en-GB");
  assert.equal(regionalViewerLocale("en", ["fr-FR"]), "en");
  assert.equal(regionalViewerLocale("pt-BR", ["pt-PT"]), "pt-BR");
});

const en = { today: "2026-10-17", locale: "en" };
const fr = { today: "2026-10-17", locale: "fr" };
const ja = { today: "2026-10-17", locale: "ja" };

function iso(text: string, context = en): string | null {
  const result = parseTypedDate(text, context);
  return result.ok ? result.iso : null;
}

test("ISO dates are always accepted, whatever the viewer locale", () => {
  for (const context of [en, fr, ja]) assert.equal(iso("2026-03-15", context), "2026-03-15");
});

test("numeric dates read in the viewer locale order with any common separator", () => {
  assert.equal(iso("3/15/2026"), "2026-03-15");
  assert.equal(iso("3-15-2026"), "2026-03-15");
  assert.equal(iso("3.15.2026"), "2026-03-15");
  assert.equal(iso("3 15 2026"), "2026-03-15");
  assert.equal(iso("15/3/2026", fr), "2026-03-15");
  assert.equal(iso("15.03.2026", fr), "2026-03-15");
  assert.equal(iso("2026/3/15", ja), "2026-03-15");
  assert.equal(iso("2026年3月15日", ja), "2026-03-15");
  assert.equal(iso("4/5/2026"), "2026-04-05", "month first for en");
  assert.equal(iso("4/5/2026", fr), "2026-05-04", "day first for fr");
});

test("a day/month the viewer order cannot hold refuses instead of swapping fields", () => {
  assert.deepEqual(parseTypedDate("15/3/2026", en), { ok: false, reason: "impossible" });
  assert.deepEqual(parseTypedDate("3/15/2026", fr), { ok: false, reason: "impossible" });
});

test("two-digit years land in the century nearest the business year", () => {
  assert.equal(iso("3/15/26"), "2026-03-15");
  assert.equal(iso("3/15/76"), "2076-03-15");
  assert.equal(iso("3/15/77"), "1977-03-15");
  assert.equal(iso("15/3/99", fr), "1999-03-15");
  assert.equal(iso("Mar 15 '26"), "2026-03-15");
});

test("a missing year reads in the business year, crossing a near year end only", () => {
  assert.equal(iso("3/15"), "2026-03-15");
  assert.equal(iso("11/30"), "2026-11-30");
  assert.equal(iso("12/28", { today: "2027-01-05", locale: "en" }), "2026-12-28");
  assert.equal(iso("1/3", { today: "2026-12-28", locale: "en" }), "2027-01-03");
  assert.equal(iso("3/4", fr), "2026-04-03");
  assert.equal(iso("3/1", fr), "2027-01-03", "early January in mid-October is the coming one");
});

test("month names in the viewer language or English, with ordinals and commas", () => {
  assert.equal(iso("Mar 15"), "2026-03-15");
  assert.equal(iso("March 15th, 2026"), "2026-03-15");
  assert.equal(iso("15 March 2026"), "2026-03-15");
  assert.equal(iso("2026 Mar 15"), "2026-03-15");
  assert.equal(iso("3 juin 2026", fr), "2026-06-03");
  assert.equal(iso("1er mars", fr), "2026-03-01");
  assert.equal(
    iso("15 Mar 2026", fr),
    "2026-03-15",
    "English names stay readable for every viewer",
  );
  assert.deepEqual(
    parseTypedDate("Ju 15", en),
    { ok: false, reason: "unrecognized" },
    "an ambiguous prefix refuses",
  );
});

test("compact digit runs read as YYYYMMDD or the locale order", () => {
  assert.equal(iso("20260315"), "2026-03-15");
  assert.equal(iso("03152026"), "2026-03-15");
  assert.equal(iso("031526"), "2026-03-15");
  assert.equal(iso("0315"), "2026-03-15");
  assert.equal(iso("150326", fr), "2026-03-15");
});

test("impossible and unreadable text refuses rather than becoming another date", () => {
  assert.deepEqual(parseTypedDate("2/30/2026", en), { ok: false, reason: "impossible" });
  assert.deepEqual(parseTypedDate("2/29/2025", en), { ok: false, reason: "impossible" });
  assert.deepEqual(parseTypedDate("2/29/2024", en), { ok: true, iso: "2024-02-29" });
  assert.deepEqual(parseTypedDate("13/01/2026", en), { ok: false, reason: "impossible" });
  assert.deepEqual(parseTypedDate("2026-02-30", en), { ok: false, reason: "impossible" });
  assert.deepEqual(parseTypedDate("", en), { ok: false, reason: "empty" });
  assert.deepEqual(parseTypedDate("   ", en), { ok: false, reason: "empty" });
  for (const text of [
    "tomorrow",
    "3/15/2026 10:00",
    "1/2/3/4",
    "$3/15",
    "Mon Mar 15",
    "2026",
    "12345",
  ]) {
    assert.equal(parseTypedDate(text, en).ok, false, text);
  }
});

test("without a business date, relative entry refuses and absolute entry still reads", () => {
  const unknown = { today: null, locale: "en" };
  assert.deepEqual(parseTypedDate("3/15", unknown), { ok: false, reason: "needsYear" });
  assert.deepEqual(parseTypedDate("3/15/26", unknown), { ok: false, reason: "needsYear" });
  assert.deepEqual(parseTypedDate("3/15/2026", unknown), { ok: true, iso: "2026-03-15" });
  assert.deepEqual(parseTypedDate("15 March 2026", unknown), { ok: true, iso: "2026-03-15" });
  assert.deepEqual(parseTypedDate("2/30/2026", unknown), { ok: false, reason: "impossible" });
  assert.equal(applyDateEntryCommand("today", "", { today: null, weekStartsOn: 7 }), null);
  assert.equal(applyDateEntryCommand("nextDay", "", { today: null, weekStartsOn: 7 }), null);
  assert.equal(
    applyDateEntryCommand("nextDay", "2026-03-15", { today: null, weekStartsOn: 7 }),
    "2026-03-16",
  );
});

test("a typed date is complete only once it states its year", () => {
  for (const text of ["3/15/2026", "3-15-26", "15 Mar 2026", "20260315", "031526", "2026-03-15"]) {
    assert.equal(isCompleteTypedDate(text, en), true, text);
  }
  for (const text of ["3-15", "3/15", "Mar 15", "2/30/2026", "3-15-"]) {
    assert.equal(isCompleteTypedDate(text, en), false, text);
  }
});

test("month-name prefixes are recognized in the viewer language and English", () => {
  assert.equal(startsMonthName("ma", "en"), true);
  assert.equal(startsMonthName("Mä", "de"), true);
  assert.equal(startsMonthName("ju", "fr"), true);
  assert.equal(startsMonthName("mx", "en"), false);
  assert.equal(startsMonthName("m", "en"), false, "one letter is still a date key");
  assert.equal(startsMonthName("m1", "en"), false);
});

test("stored dates display in each viewer format and read back as the same day", () => {
  const expected: Record<string, string> = {
    en: "03/05/2026",
    "en-GB": "05/03/2026",
    "en-CA": "2026-03-05",
    de: "05.03.2026",
    es: "05/03/2026",
    fr: "05/03/2026",
    "pt-BR": "05/03/2026",
    ja: "2026/03/05",
    zh: "2026/03/05",
  };
  for (const [locale, shown] of Object.entries(expected)) {
    assert.equal(formatEntryDate("2026-03-05", locale), shown, locale);
    for (const iso of ["2026-03-05", "2024-02-29", "0026-12-31", "9999-12-31"]) {
      const text = formatEntryDate(iso, locale);
      assert.deepEqual(
        parseTypedDate(text, { today: "2026-10-17", locale }),
        { ok: true, iso },
        `${locale} ${text}`,
      );
    }
  }
  assert.equal(formatEntryDate("", "en"), "");
  assert.equal(
    formatEntryDate("not-a-date", "en"),
    "not-a-date",
    "an unexpected value is shown, never reinterpreted",
  );
});

test("entry patterns follow the locale order and separators", () => {
  const symbols = { year: "yyyy", month: "mm", day: "dd" };
  assert.equal(entryDatePattern("en", symbols), "mm/dd/yyyy");
  assert.equal(entryDatePattern("en-GB", symbols), "dd/mm/yyyy");
  assert.equal(entryDatePattern("de", { year: "JJJJ", month: "MM", day: "TT" }), "TT.MM.JJJJ");
  assert.equal(entryDatePattern("ja", symbols), "yyyy/mm/dd");
});

test("calendar months show six whole weeks from the configured first weekday", () => {
  const sunday = calendarWeeks("2026-10-01", 7);
  assert.equal(sunday.length, 6);
  assert.equal(sunday[0]![0], "2026-09-27");
  assert.equal(sunday[5]![6], "2026-11-07");
  const monday = calendarWeeks("2026-02-01", 1);
  assert.equal(monday[0]![0], "2026-01-26");
  assert.ok(monday.every((week) => week.length === 7));
  assert.equal(
    calendarWeeks("0001-01-01", 7).length,
    5,
    "weeks before the supported calendar are omitted",
  );
  assert.equal(shiftMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftMonths("9999-12-15", 1), null);
});
