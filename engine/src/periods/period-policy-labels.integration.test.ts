import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { periodDisplayLabel, periodDisplayLabelSql } from "./period-policy.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const PERIODS = [
  { fiscalYear: 2025, periodNumber: 12, adjustment: false, startsOn: "2025-12-01", endsOn: "2025-12-31" },
  { fiscalYear: 2026, periodNumber: 12, adjustment: false, startsOn: "2026-12-01", endsOn: "2026-12-31" },
  { fiscalYear: 2026, periodNumber: 1, adjustment: false, startsOn: "2025-12-28", endsOn: "2026-01-24" },
  { fiscalYear: 2026, periodNumber: 3, adjustment: false, startsOn: "2026-03-01", endsOn: "2026-03-31" },
  { fiscalYear: 2026, periodNumber: 13, adjustment: true, startsOn: "2026-12-31", endsOn: "2026-12-31" },
];

test("the search expression renders exactly the label the list shows, in every locale", { skip: !DB }, async () => {
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "zh", "ar-EG"]) {
    for (const period of PERIODS) {
      const rendered = (await db.execute<{ label: string }>(sql`
        select ${periodDisplayLabelSql(locale)} as label
          from (select ${period.fiscalYear}::int as fiscal_year, ${period.periodNumber}::int as period_number,
                       ${period.adjustment}::boolean as is_adjustment,
                       ${period.startsOn}::date as starts_on, ${period.endsOn}::date as ends_on) p`)).rows[0]?.label;
      assert.equal(rendered, periodDisplayLabel(period, locale), `${locale} ${period.startsOn}`);
    }
  }
});

test("a search for the shown month text finds the period", { skip: !DB }, async () => {
  const match = (await db.execute<{ matched: boolean }>(sql`
    select ${periodDisplayLabelSql("en")} ilike ${"%dec 2026%"} as matched
      from (select 2026 as fiscal_year, 12 as period_number, false as is_adjustment,
                   '2026-12-01'::date as starts_on, '2026-12-31'::date as ends_on) p`)).rows[0]?.matched;
  assert.equal(match, true);
});
