import assert from "node:assert/strict";
import test from "node:test";
import {
  civilDateParams,
  civilDateTranslator,
  countLabel,
  currencyLabel,
  dateLabel,
  dateTime,
  decimalLabel,
  formatCivilDate,
  formatCount,
  formatExactPercent,
  formatPercent01,
  monthLabel,
  monthYearLabel,
  reportPeriodLabel,
  shortDateLabel,
  trendWeekLabel,
  viewerDateTime,
  viewerNumber,
} from "./format";

// Intl uses narrow/no-break spaces in some locales; compare on plain spaces.
const nbsp = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

// Timestamps must render in the viewer's locale: the Users
// list passes its request locale through, so the formatter has to honor
// the argument rather than always falling back to the default.

test("dateTime renders month names in the requested locale", () => {
  const stamp = "2026-07-17T00:37:00Z";
  assert.match(dateTime(stamp, "en"), /Jul/);
  assert.match(dateTime(stamp, "fr"), /juil/);
  assert.notEqual(dateTime(stamp, "en"), dateTime(stamp, "fr"));
});

test("dateTime keeps its default and empty handling", () => {
  assert.equal(dateTime(null), "");
  assert.equal(dateTime(undefined), "");
  assert.match(dateTime("2026-07-17T00:37:00Z"), /2026/);
});

// Trend week labels must render in the viewer's locale (F2-14): the
// purchasing loader passes its request locale through, so the formatter
// has to honor the argument rather than pinning en-US.

test("trendWeekLabel renders the week start in the requested locale", () => {
  assert.match(trendWeekLabel("2026-01-05", "en-US"), /Jan 5/);
  assert.match(trendWeekLabel("2026-01-05", "fr"), /janv/i);
  assert.notEqual(trendWeekLabel("2026-01-05", "en-US"), trendWeekLabel("2026-01-05", "fr"));
});

test("trendWeekLabel pins the UTC day so time zones cannot shift it", () => {
  assert.match(trendWeekLabel("2026-09-07", "en-US"), /Sep 7/);
  assert.match(trendWeekLabel("2026-09-07", "de"), /Sep/i);
});

// The F2-14b viewer-locale family: every helper must honor its locale
// argument — a helper that pins one language repeats the defect it exists
// to remove. French differs from en-US on every shape below.

test("dateLabel renders the full date in the requested locale", () => {
  const day = new Date("2026-09-07T00:00:00Z");
  assert.match(dateLabel(day, "en-US"), /Sep 7, 2026/);
  assert.match(dateLabel(day, "fr"), /sept/i);
  assert.notEqual(dateLabel(day, "en-US"), dateLabel(day, "fr"));
});

test("shortDateLabel renders the compact date in the requested locale", () => {
  const day = new Date("2026-01-05T00:00:00Z");
  assert.match(shortDateLabel(day, "en-US"), /Jan 5/);
  assert.match(shortDateLabel(day, "fr"), /janv/i);
  assert.notEqual(shortDateLabel(day, "en-US"), shortDateLabel(day, "fr"));
});

test("monthYearLabel renders the drill grouping in the requested locale", () => {
  const first = new Date(Date.UTC(2026, 8, 1));
  assert.match(monthYearLabel(first, "en-US"), /Sep/);
  assert.match(monthYearLabel(first, "fr"), /sept/i);
  assert.notEqual(monthYearLabel(first, "en-US"), monthYearLabel(first, "fr"));
});

test("monthYearLabel keeps the caller's year width", () => {
  const first = new Date(Date.UTC(2026, 8, 1));
  assert.match(monthYearLabel(first, "en-US", "numeric"), /2026/);
  assert.doesNotMatch(monthYearLabel(first, "en-US"), /2026/);
});

test("monthLabel renders the axis tick in the requested locale", () => {
  const day = new Date(Date.UTC(2026, 6, 1));
  assert.match(monthLabel(day, "en-US"), /Jul/);
  assert.match(monthLabel(day, "fr"), /juil/i);
  assert.notEqual(monthLabel(day, "en-US"), monthLabel(day, "fr"));
});

test("countLabel groups integers in the requested locale", () => {
  assert.equal(countLabel(50000, "en-US"), "50,000");
  assert.notEqual(countLabel(50000, "en-US"), countLabel(50000, "fr"));
});

test("decimalLabel trims trailing zeros in the requested locale", () => {
  assert.equal(decimalLabel(1.75, "en-US", 0, 4), "1.75");
  assert.equal(decimalLabel(40, "en-US", 0, 4), "40");
  assert.notEqual(decimalLabel(1750.5, "en-US", 0, 4), decimalLabel(1750.5, "fr", 0, 4));
});

test("currencyLabel renders whole-unit amounts in the requested locale", () => {
  assert.match(currencyLabel(125000, "USD", "en-US"), /\$125,000/);
  assert.notEqual(currencyLabel(125000, "USD", "en-US"), currencyLabel(125000, "USD", "fr"));
});

test("counts group in the operator locale", () => {
  assert.equal(nbsp(formatCount(1234, "en")), "1,234");
  assert.equal(nbsp(formatCount(1234, "de")), "1.234");
  assert.equal(nbsp(formatCount(1234, "fr")), "1 234");
});

test("percents localize placement instead of concatenating %", () => {
  assert.equal(nbsp(formatPercent01(0.125, "en")), "13%");
  assert.equal(nbsp(formatPercent01(0.125, "de")), "13 %");
  assert.equal(nbsp(formatPercent01(0.125, "fr")), "13 %");
  assert.equal(nbsp(formatPercent01(0, "de")), "0 %");
});

test("exact decimal percentages localize without passing the value through Number", () => {
  assert.equal(nbsp(formatExactPercent("0.2", "en")), "0.2%");
  assert.equal(nbsp(formatExactPercent("0.2", "fr-CA")), "0,2 %");
  assert.equal(nbsp(formatExactPercent("-1234.5", "de")), "-1.234,5 %");
});

test("civil dates render medium in the operator locale without shifting days", () => {
  assert.equal(formatCivilDate("2026-01-05", "en"), "Jan 5, 2026");
  assert.equal(formatCivilDate("2026-01-05", "de"), "5. Jan. 2026");
  assert.equal(formatCivilDate("2026-01-05", "fr"), "5 janv. 2026");
  assert.equal(formatCivilDate("2026-01-05T00:00:00", "en"), "Jan 5, 2026");
});

test("viewer formatting uses both the requested locale and organization time zone", () => {
  const instant = new Date("2026-01-05T01:30:00Z");
  const local = viewerDateTime(instant, "fr", "America/Toronto", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const utc = viewerDateTime(instant, "fr", "UTC", { dateStyle: "short", timeStyle: "short" });
  assert.match(local, /04\/01\/2026|4\/01\/2026/);
  assert.notEqual(local, utc);
  assert.notEqual(viewerNumber(12345.6, "fr"), viewerNumber(12345.6, "en"));
});

test("report phrase values localize civil dates and pass other values through", () => {
  assert.deepEqual(
    civilDateParams({ from: "2026-01-01", to: "2026-12-31", count: 3, book: "Primary" }, "en"),
    { from: "Jan 1, 2026", to: "Dec 31, 2026", count: 3, book: "Primary" },
  );
  assert.deepEqual(civilDateParams({ date: "2026-10-19" }, "de"), { date: "19. Okt. 2026" });
  assert.deepEqual(civilDateParams({ date: "2026-02-30", label: "2026-10" }, "en"), {
    date: "2026-02-30",
    label: "2026-10",
  });
});

test("a localizing report translator formats the as-of date it is given", () => {
  const t = civilDateTranslator((key, values) => `${key}:${values?.date ?? ""}`, "fr");
  assert.equal(t("balanceSheet.asOf", { date: "2026-10-19" }), "balanceSheet.asOf:19 oct. 2026");
  assert.equal(t("title"), "title:");
});

test("a custom report window reads as its localized bounds while presets keep their names", () => {
  assert.equal(
    reportPeriodLabel(
      {
        presetId: "custom",
        from: "2026-01-01",
        to: "2026-12-31",
        label: "2026-01-01 – 2026-12-31",
      },
      "en",
    ),
    "Jan 1, 2026 – Dec 31, 2026",
  );
  assert.equal(
    reportPeriodLabel(
      {
        presetId: "custom",
        from: "2026-10-18",
        to: "2026-10-18",
        label: "2026-10-18 – 2026-10-18",
      },
      "en",
    ),
    "Oct 18, 2026",
  );
  assert.equal(
    reportPeriodLabel(
      { presetId: "this_fiscal_year", from: "2026-01-01", to: "2026-12-31", label: "FY 2026" },
      "en",
    ),
    "FY 2026",
  );
});

test("an accounting-period window reads as its period label in every fiscal year and locale", () => {
  const december = (fiscalYear: number) => ({
    fiscalYear,
    periodNumber: 12,
    from: `${fiscalYear}-12-01`,
    to: `${fiscalYear}-12-31`,
  });
  for (const fiscalYear of [2025, 2026]) {
    const fiscalPeriod = december(fiscalYear);
    assert.equal(
      reportPeriodLabel(
        {
          presetId: "last_period",
          from: fiscalPeriod.from,
          to: fiscalPeriod.to,
          label: `P12 FY${fiscalYear}`,
          fiscalPeriod,
        },
        "en",
      ),
      `P12 FY${fiscalYear} · Dec ${fiscalYear}`,
    );
  }
  const fiscalPeriod = december(2026);
  assert.equal(
    reportPeriodLabel(
      {
        presetId: "this_period",
        from: fiscalPeriod.from,
        to: fiscalPeriod.to,
        label: "P12 FY2026",
        fiscalPeriod,
      },
      "ja",
    ),
    "P12 FY2026 · 2026年12月",
  );
  // Cut short at the business day, the window is that period to date.
  assert.equal(
    reportPeriodLabel(
      {
        presetId: "this_period_to_date",
        from: fiscalPeriod.from,
        to: "2026-12-15",
        label: "P12 FY2026 to date",
        fiscalPeriod,
      },
      "en",
    ),
    "P12 FY2026 · Dec 2026 to date",
  );
});

test("a window that runs to the business day reads its qualifier from the locale catalogs", async () => {
  const { resolvePreset } = await import("@openbooks/reports");
  const catalogs = {
    de: (await import("../messages/de/periodLabels.json")).default,
    ja: (await import("../messages/ja/periodLabels.json")).default,
  };
  const fiscalPeriod = { fiscalYear: 2026, periodNumber: 5, from: "2026-05-01", to: "2026-05-31" };
  const periodToDate = {
    presetId: "this_period_to_date",
    from: "2026-05-01",
    to: "2026-05-19",
    label: "P05 FY2026 to date",
    fiscalPeriod,
  };
  assert.equal(reportPeriodLabel(periodToDate, "en"), "P05 FY2026 · May 2026 to date");
  assert.equal(
    reportPeriodLabel(periodToDate, "de"),
    catalogs.de.toDate.replace(
      "{label}",
      reportPeriodLabel({ ...periodToDate, to: "2026-05-31" }, "de"),
    ),
  );
  // Calendar and fiscal-year windows carry their bare name, so the qualifier never stays English.
  const yearToDate = {
    presetId: "this_calendar_year_to_date",
    ...resolvePreset("this_calendar_year_to_date", { startMonth: 1, today: "2026-10-19" })!,
  };
  assert.equal(reportPeriodLabel(yearToDate, "en"), "2026 to date");
  assert.equal(reportPeriodLabel(yearToDate, "de"), "2026 bis heute");
  assert.equal(reportPeriodLabel(yearToDate, "ja"), catalogs.ja.toDate.replace("{label}", "2026"));
  const fiscalToDate = {
    presetId: "this_fiscal_year_to_date",
    ...resolvePreset("this_fiscal_year_to_date", { startMonth: 4, today: "2026-10-19" })!,
  };
  assert.ok(
    fiscalToDate.toDate && fiscalToDate.windowName,
    "a fiscal year to date names its window",
  );
  assert.equal(reportPeriodLabel(fiscalToDate, "fr"), `${fiscalToDate.windowName} à ce jour`);
  const week = {
    presetId: "week_to_date",
    ...resolvePreset("week_to_date", { startMonth: 1, today: "2026-10-19" })!,
  };
  assert.equal(
    reportPeriodLabel(week, "es"),
    (await import("../messages/es/periodLabels.json")).default.presets.week_to_date,
  );
  for (const locale of ["de", "es", "fr", "ja", "pt-BR", "zh"]) {
    assert.doesNotMatch(
      reportPeriodLabel(yearToDate, locale),
      /to date/,
      `${locale} reads the qualifier in its own language`,
    );
  }
});

test("every preset window reads in the viewer's language, keyed by its stable id", async () => {
  const { PERIOD_PRESETS, resolvePreset } = await import("@openbooks/reports");
  const catalog = async (locale: string) =>
    (await import(`../messages/${locale}/periodLabels.json`)).default as {
      presets: Record<string, string>;
    };
  const [de, ja, fr] = await Promise.all([catalog("de"), catalog("ja"), catalog("fr")]);
  const window = (id: string) => ({
    presetId: id,
    ...resolvePreset(id, { startMonth: 1, today: "2026-10-19" })!,
  });
  assert.equal(
    reportPeriodLabel(window("trailing_12_months"), "de"),
    de.presets.trailing_12_months,
  );
  assert.equal(reportPeriodLabel(window("last_30_days"), "ja"), ja.presets.last_30_days);
  assert.equal(reportPeriodLabel(window("rolling_quarter"), "fr"), fr.presets.rolling_quarter);
  assert.equal(reportPeriodLabel(window("trailing_12_months"), "en"), "Trailing 12 Months");
  // A calendar month and a single day read in the locale, never as ISO text.
  assert.equal(reportPeriodLabel(window("this_month"), "de"), "Okt. 2026");
  assert.equal(reportPeriodLabel(window("yesterday"), "fr"), formatCivilDate("2026-10-18", "fr"));
  // The resolved window keeps its locale-free label as the stable key.
  assert.equal(window("trailing_12_months").label, "Trailing 12 months");

  // No preset that resolves to a window shows English words in a non-English locale.
  const english =
    /\b(Trailing|Rolling|Last|Next|Days?|Months?|Week|Year|Quarter|Today|Yesterday|Tomorrow|to date)\b/;
  const leaks: string[] = [];
  for (const locale of ["de", "es", "fr", "ja", "pt-BR", "zh"]) {
    for (const preset of PERIOD_PRESETS.filter((candidate) => candidate.id !== "custom")) {
      const shown = reportPeriodLabel(window(preset.id), locale);
      if (english.test(shown)) leaks.push(`${locale}:${preset.id} → ${shown}`);
    }
  }
  assert.deepEqual(leaks, [], leaks.join("\n"));
});
