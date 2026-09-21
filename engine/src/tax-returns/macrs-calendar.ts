import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import {
  macrsWindowsThroughFiscalCalendar,
  type MacrsYearWindow,
} from "./depreciation-pool.ts";

export class MacrsCalendarError extends Error {
  readonly name = "MacrsCalendarError";
}

/** Authoritative MACRS tax-year windows from the org fiscal calendar.
 * Monthly calendars derive year bounds from year_start_month. Other
 * cadences require generated accounting periods — missing years refuse. */
export async function loadOrgMacrsWindows(
  tx: SqlExecutor,
  orgId: string,
  fromOn: string,
  throughOn: string,
): Promise<MacrsYearWindow[]> {
  const calendar = (
    await tx.execute<{ cadence: string; year_start_month: number }>(sql`
      select cadence, year_start_month
        from fiscal_calendars
       where org_id=${orgId} and is_default and is_active
       limit 1`)
  ).rows[0];
  if (!calendar) {
    throw new MacrsCalendarError(
      "an active default fiscal calendar is required to date MACRS recovery years; configure it on Company Settings — do not invent January–December windows",
    );
  }
  if (calendar.cadence === "monthly") {
    return macrsWindowsThroughFiscalCalendar({
      yearStartMonth: calendar.year_start_month,
      fromOn,
      throughOn,
    });
  }
  const rows = (
    await tx.execute<{ tax_year: number; year_start: string; year_end: string }>(sql`
      select p.fiscal_year as tax_year,
             min(p.starts_on)::text as year_start,
             max(p.ends_on)::text as year_end
        from accounting_periods p
        join fiscal_calendars c on c.id=p.fiscal_calendar_id and c.org_id=p.org_id
       where p.org_id=${orgId} and c.is_default and c.is_active
         and p.is_adjustment is not true
       group by p.fiscal_year
       order by p.fiscal_year`)
  ).rows;
  if (rows.length === 0) {
    throw new MacrsCalendarError(
      `fiscal calendar cadence ${calendar.cadence} has no generated accounting periods covering ${fromOn}–${throughOn}; generate those periods — do not invent month boundaries`,
    );
  }
  return rows.map((row) => ({
    taxYear: row.tax_year,
    yearStart: row.year_start,
    yearEnd: row.year_end,
  }));
}
