import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

type Runner = Pick<typeof db, "execute">;

export interface CoveringPeriod {
  id: string;
  fiscal_calendar_id: string;
  fiscal_year: number;
  period_number: number;
  name: string;
  starts_on: string;
  ends_on: string;
}

/**
 * THE period covering a date for ordinary postings — the single shared
 * resolver every module resolves a posting period through.
 *
 * It reads the entity's effective posting calendar, or the default active calendar;
 * the admin close screen guarantees at most one default) and returns the
 * regular period covering the date, deterministic under overlaps
 * (`order by starts_on, ends_on, id`). Ordinary postings NEVER resolve
 * into an adjustment period by date: an adjustment period shares its final
 * regular day, so date resolution would silently divert year-end activity
 * into the adjustment bucket. Postings that belong in an adjustment period
 * name it explicitly (documents carry posting_period_id; the posting kernel
 * honours an explicit adjustment override without a date-window check).
 *
 * Returns null when uncovered OR when the org has no default active
 * calendar — callers refuse with their own remedy-naming error, never a
 * silent mix and never a defaulted period. (Failing closed on a missing
 * default calendar is deliberate: with several active calendars, picking
 * any one without the default marker is the arbitrary choice this resolver
 * exists to eliminate.)
 */
/**
 * Every regular period of the posting calendar overlapping [from, to] — the
 * window twin of {@link resolveCoveringPeriod} for fences that certify a
 * range (the tax filing close fence). Same calendar, same exclusions:
 * effective entity calendar or organization default, never adjustment periods, so an
 * alternate planning calendar can never hold a posting fence hostage.
 */
export async function resolveCoveringPeriodsInWindow(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  subsidiaryId?: string | null,
): Promise<CoveringPeriod[]> {
  const r = await runner.execute<{
    id: string;
    fiscal_calendar_id: string;
    fiscal_year: number;
    period_number: number;
    name: string;
    starts_on: string;
    ends_on: string;
  }>(
    sql`
    select p.id, p.fiscal_calendar_id, p.fiscal_year, p.period_number, p.name,
           p.starts_on::text as starts_on, p.ends_on::text as ends_on
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_active
       and fc.id = public.subsidiary_posting_calendar(${orgId}::uuid, ${subsidiaryId ?? null}::uuid, greatest(p.starts_on,${from}::date))
     where p.org_id = ${orgId} and not p.is_adjustment
       and p.starts_on <= ${to} and p.ends_on >= ${from}
     order by p.starts_on, p.ends_on, p.id`,
    "objects",
  );
  return r;
}

export async function resolveCoveringPeriod(
  runner: Runner,
  orgId: string,
  date: string,
  subsidiaryId?: string | null,
): Promise<CoveringPeriod | null> {
  const r = await runner.execute<{
    id: string;
    fiscal_calendar_id: string;
    fiscal_year: number;
    period_number: number;
    name: string;
    starts_on: string;
    ends_on: string;
  }>(
    sql`
    select p.id, p.fiscal_calendar_id, p.fiscal_year, p.period_number, p.name,
           p.starts_on::text as starts_on, p.ends_on::text as ends_on
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_active
       and fc.id = public.subsidiary_posting_calendar(${orgId}::uuid, ${subsidiaryId ?? null}::uuid, ${date}::date)
     where p.org_id = ${orgId} and not p.is_adjustment
       and p.starts_on <= ${date} and p.ends_on >= ${date}
     order by p.starts_on, p.ends_on, p.id
     limit 1`,
    "objects",
  );
  return r[0] ?? null;
}
