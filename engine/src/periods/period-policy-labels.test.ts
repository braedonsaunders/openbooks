import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPeriodLabel, periodDisplayLabel, periodMonthSpan } from "./period-policy.ts";

test("regular periods share one label format with zero-padded numbers", () => {
  assert.equal(
    canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 1, adjustment: false }),
    "P01 FY2025",
  );
  assert.equal(
    canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 12, adjustment: false }),
    "P12 FY2025",
  );
});

test("the adjustment period is labelled by its fiscal year", () => {
  assert.equal(
    canonicalPeriodLabel({ fiscalYear: 2025, periodNumber: 13, adjustment: true }),
    "FY2025 adjustment",
  );
});

test("every fiscal year reads in the same format, derived from the period's own dates", () => {
  const december = (fiscalYear: number) =>
    periodDisplayLabel(
      {
        fiscalYear,
        periodNumber: 12,
        adjustment: false,
        startsOn: `${fiscalYear}-12-01`,
        endsOn: `${fiscalYear}-12-31`,
      },
      "en",
    );
  assert.equal(december(2024), "P12 FY2024 · Dec 2024");
  assert.equal(december(2025), "P12 FY2025 · Dec 2025");
  assert.equal(december(2026), "P12 FY2026 · Dec 2026");
});

test("the month follows the period dates, not the fiscal year, for a non-calendar fiscal year", () => {
  assert.equal(
    periodDisplayLabel(
      {
        fiscalYear: 2026,
        periodNumber: 1,
        adjustment: false,
        startsOn: "2025-07-01",
        endsOn: "2025-07-31",
      },
      "en",
    ),
    "P01 FY2026 · Jul 2025",
  );
});

test("a period spanning calendar months names its first and last month", () => {
  assert.equal(
    periodMonthSpan({ startsOn: "2025-12-28", endsOn: "2026-01-24" }, "en"),
    "Dec 2025 – Jan 2026",
  );
  assert.equal(periodMonthSpan({ startsOn: "2026-03-01", endsOn: "2026-03-28" }, "en"), "Mar 2026");
});

test("the adjustment period carries the month of its closing day", () => {
  assert.equal(
    periodDisplayLabel(
      {
        fiscalYear: 2025,
        periodNumber: 13,
        adjustment: true,
        startsOn: "2025-12-31",
        endsOn: "2025-12-31",
      },
      "en",
    ),
    "FY2025 adjustment · Dec 2025",
  );
});

test("the month span is localized and matches the platform month-year format in every locale", () => {
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "zh", "ar-EG"]) {
    const native = new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    for (let month = 1; month <= 12; month++) {
      const iso = `2026-${String(month).padStart(2, "0")}-01`;
      assert.equal(
        periodMonthSpan({ startsOn: iso, endsOn: iso }, locale),
        native.format(new Date(`${iso}T12:00:00Z`)),
        `${locale} ${iso}`,
      );
    }
  }
  assert.equal(
    periodMonthSpan({ startsOn: "2026-12-01", endsOn: "2026-12-31" }, "ja"),
    "2026年12月",
  );
});

test("a civil date never shifts by time zone", () => {
  assert.equal(periodMonthSpan({ startsOn: "2026-01-01", endsOn: "2026-01-31" }, "en"), "Jan 2026");
  assert.equal(periodMonthSpan({ startsOn: "2026-12-31", endsOn: "2026-12-31" }, "en"), "Dec 2026");
});

test("a malformed period date is refused rather than mislabelled", () => {
  assert.throws(() => periodMonthSpan({ startsOn: "", endsOn: "2026-01-31" }, "en"), RangeError);
});
