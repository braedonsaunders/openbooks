import "server-only";
import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import type { ExtraPeriodOption } from "../../app/(app)/reports/ReportFilterBar";

/**
 * Named fiscal periods for the analytics period picker, newest first.
 * Non-adjustment periods from the org's calendars — the same rows the
 * accounting-period presets resolve against — so an owner can open an
 * arbitrary closed month by name instead of hand-typing its dates. Each
 * option reads as every period list labels it in the viewer's locale
 * (`P05 FY2026 · May 2026`), whatever free-text name the period was stored
 * with. Capped: a dropdown is a picker, not an archive.
 */
export async function analyticsFiscalPeriodOptions(
  orgId: string,
  locale: string,
  limit = 25,
): Promise<ExtraPeriodOption[]> {
  const rows = await db.execute<{
    id: string;
    fiscal_year: number;
    period_number: number;
    starts_on: string;
    ends_on: string;
  }>(
    sql`
    select id, fiscal_year, period_number, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
     where org_id = ${orgId} and not is_adjustment
     order by starts_on desc
     limit ${limit}
  `,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    label: periodDisplayLabel(
      {
        fiscalYear: Number(row.fiscal_year),
        periodNumber: Number(row.period_number),
        adjustment: false,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
      },
      locale,
    ),
    from: row.starts_on,
    to: row.ends_on,
  }));
}

/**
 * The analytics period picker's named fiscal periods plus their optgroup
 * label, resolved in the viewer's locale. Selecting one compiles to
 * period=custom with its exact bounds, so the choice is URL-addressable
 * and every dashboard loader resolves the identical window.
 */
export async function analyticsFiscalPeriodPicker(
  orgId: string,
  locale: string,
): Promise<{
  extraPeriods: ExtraPeriodOption[];
  extraPeriodsLabel: string;
}> {
  const [t, extraPeriods] = await Promise.all([
    getTranslations("reports"),
    analyticsFiscalPeriodOptions(orgId, locale),
  ]);
  return { extraPeriods, extraPeriodsLabel: t("filterBar.fiscalPeriods") };
}
