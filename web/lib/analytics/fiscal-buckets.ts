import { sql, type SQL } from "drizzle-orm";
import { defaultFiscalCalendarPeriods } from "../fiscal";
import type { FiscalPeriod } from "@openbooks/reports";

/**
 * Fiscal-period bucketing for analytics trend series.
 *
 * Calendar-month buckets misstate trend windows for organizations on 4-4-5,
 * 13-period or custom calendars, and a bare month number collides once a
 * window spans more than twelve months. When the organization has a declared
 * default calendar with a non-monthly cadence, series bucket by its
 * accounting periods (keyed by period start, labelled with the period's own
 * name); every other organization keeps calendar months. The monthly rule
 * mirrors period resolution, so dashboard windows and trend buckets agree.
 */

export interface FiscalBucketScope {
  useFiscal: boolean;
  /** Declared non-adjustment periods, ordered by start. Empty unless fiscal. */
  periods: FiscalPeriod[];
}

export async function fiscalBucketScope(orgId: string): Promise<FiscalBucketScope> {
  // No silent fallback: a calendar that fails to resolve must fail the
  // dashboard the same way period resolution fails it, or trend buckets and
  // period labels would quietly disagree about which calendar is in force.
  const cal = await defaultFiscalCalendarPeriods(orgId);
  if (!cal || cal.cadence === "monthly" || cal.periods.length === 0) {
    return { useFiscal: false, periods: [] };
  }
  return { useFiscal: true, periods: cal.periods };
}

/**
 * LEFT JOIN resolving one posting/document date to its declared period. The
 * lateral lookup returns at most one row, so overlapping declarations can
 * never fan spend out. A date outside declared coverage falls back to its
 * calendar-month key with a null label: consumers render every key the data
 * holds (declared periods plus those fallback boxes), so a partially
 * provisioned calendar degrades box by box, never to nothing. Emits no join
 * at all outside fiscal bucketing.
 */
export function fiscalBucketJoin(orgId: string, dateExpr: SQL, useFiscal: boolean): SQL {
  if (!useFiscal) return sql``;
  return sql`left join lateral (
      select fbp.starts_on, fbp.name from accounting_periods fbp
        join fiscal_calendars fcb on fcb.id = fbp.fiscal_calendar_id and fcb.org_id = fbp.org_id
       where fbp.org_id = ${orgId} and fcb.is_default and fcb.is_active and not fbp.is_adjustment
         and ${dateExpr}::date between fbp.starts_on and fbp.ends_on
       order by fbp.starts_on limit 1
    ) fbp on true`;
}

/** Stable bucket key: the period start, or the calendar month for fallback boxes. */
export function fiscalBucketKey(dateExpr: SQL, useFiscal: boolean): SQL {
  if (!useFiscal) return sql`to_char(${dateExpr}, 'YYYY-MM')`;
  return sql`coalesce(fbp.starts_on::text, to_char(${dateExpr}, 'YYYY-MM'))`;
}

/**
 * Periods per fiscal year around a date, for annualising per-period figures
 * (13 for a thirteen-period year, 12 for 4-4-5 or monthly calendars).
 * Unknown coverage annualises by calendar months.
 */
export function fiscalPeriodsPerYear(periods: FiscalPeriod[], asOf: string): number {
  const perYear = new Map<number, number>();
  for (const p of periods) perYear.set(p.fiscalYear, (perYear.get(p.fiscalYear) ?? 0) + 1);
  for (const p of periods) {
    if (p.from <= asOf && asOf <= p.to) return perYear.get(p.fiscalYear) ?? 12;
  }
  return 12;
}

export interface FiscalMonthBox {
  month: string;
  label: string;
  spend: string;
}

/**
 * One box per declared fiscal period overlapping the window, plus one
 * fallback box per calendar-month key the data holds outside declared
 * coverage. Fallback keys are "YYYY-MM" and never collide with period
 * starts, so the two sets partition the series: a partially provisioned
 * calendar degrades box by box, never by dropping spend.
 */
export function fiscalMonthlyBoxes(
  periods: FiscalPeriod[],
  startIso: string,
  endIso: string,
  spendByBucket: ReadonlyMap<string, string>,
  zero: string,
  labels: ReadonlyMap<string, string>,
  monthLabel: (ym: string) => string,
): FiscalMonthBox[] {
  const declared = periods.filter((p) => p.to >= startIso && p.from <= endIso);
  const declaredKeys = new Set(declared.map((p) => p.from));
  const boxes = declared.map((p) => ({
    month: p.from,
    label: labels.get(p.from) ?? p.name,
    spend: spendByBucket.get(p.from) ?? zero,
  }));
  for (const key of [...spendByBucket.keys()].sort()) {
    if (/^\d{4}-\d{2}$/.test(key) && !declaredKeys.has(key)) {
      boxes.push({ month: key, label: monthLabel(key), spend: spendByBucket.get(key) ?? zero });
    }
  }
  return boxes;
}

/** Display label: the period's own name, or null when the view should render the calendar month. */
export function fiscalBucketLabel(dateExpr: SQL, useFiscal: boolean): SQL {
  if (!useFiscal) return sql`null::text`;
  return sql`fbp.name`;
}
