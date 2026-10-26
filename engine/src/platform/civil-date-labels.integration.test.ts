import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { civilDateLabel, civilDateLabelSql } from "./civil-date-labels.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "the SQL label is the TypeScript label for every month and locale",
  { skip: !DB },
  async () => {
    const dates = Array.from(
      { length: 12 },
      (_, index) => `2026-${String(index + 1).padStart(2, "0")}-${index % 2 ? "09" : "28"}`,
    );
    for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "zh", "ar-EG"]) {
      for (const style of ["date", "monthYear"] as const) {
        const rows = await db.execute<{ iso: string; label: string }>(
          sql`
        select d::text as iso, ${civilDateLabelSql(sql`d`, locale, style)} as label
          from unnest(${`{${dates.join(",")}}`}::date[]) as d`,
          "objects",
        );
        assert.equal(rows.length, dates.length);
        for (const row of rows)
          assert.equal(
            row.label,
            civilDateLabel(row.iso, locale, style),
            `${locale} ${style} ${row.iso}`,
          );
      }
    }
  },
);

test("a null date renders as null so searches skip it", { skip: !DB }, async () => {
  const row = (
    await db.execute<{ label: string | null }>(
      sql`select ${civilDateLabelSql(sql`null::date`, "en")} as label`,
      "objects",
    )
  )[0];
  assert.equal(row?.label, null);
});
