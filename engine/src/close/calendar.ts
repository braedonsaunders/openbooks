import { CloseError, CLOSE_MODULES } from "./period-policy.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
type CalendarRow = {
  id: string;
  cadence:
    | "monthly"
    | "four_four_five"
    | "four_five_four"
    | "five_four_four"
    | "thirteen_period"
    | "custom";
  year_start_month: number;
  anchor_date: string | null;
  adjustment_period_enabled: boolean;
  config: Record<string, unknown>;
};

type GeneratedPeriod = {
  fiscalYear: number;
  number: number;
  name: string;
  startsOn: string;
  endsOn: string;
  adjustment: boolean;
};

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function fiscalStartYear(fiscalYear: number, startMonth: number): number {
  return startMonth === 1 ? fiscalYear : fiscalYear - 1;
}

function periodName(
  number: number,
  fiscalYear: number,
  adjustment = false,
): string {
  return adjustment
    ? `FY${fiscalYear} adjustment`
    : `P${String(number).padStart(2, "0")} FY${fiscalYear}`;
}

function generatedPeriods(
  calendar: CalendarRow,
  fiscalYear: number,
): GeneratedPeriod[] {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 9999) {
    throw new CloseError("fiscal year must be between 1900 and 9999");
  }

  let rows: GeneratedPeriod[] = [];
  if (calendar.cadence === "monthly") {
    const startYear = fiscalStartYear(fiscalYear, calendar.year_start_month);
    for (let i = 0; i < 12; i++) {
      const start = new Date(
        Date.UTC(startYear, calendar.year_start_month - 1 + i, 1),
      );
      rows.push({
        fiscalYear,
        number: i + 1,
        name: periodName(i + 1, fiscalYear),
        startsOn: isoDate(start),
        endsOn: isoDate(endOfMonth(start)),
        adjustment: false,
      });
    }
  } else if (calendar.cadence === "custom") {
    const years = (calendar.config.years ?? {}) as Record<string, unknown>;
    const configured = years[String(fiscalYear)];
    if (!Array.isArray(configured) || configured.length === 0) {
      throw new CloseError(
        `custom calendar has no period definition for FY${fiscalYear}`,
      );
    }
    rows = configured.map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const startsOn = String(item.startsOn ?? "");
      const endsOn = String(item.endsOn ?? "");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(startsOn) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(endsOn) ||
        startsOn > endsOn
      ) {
        throw new CloseError(
          `custom calendar period ${index + 1} has an invalid date range`,
        );
      }
      return {
        fiscalYear,
        number: index + 1,
        name: String(item.name ?? periodName(index + 1, fiscalYear)),
        startsOn,
        endsOn,
        adjustment: Boolean(item.adjustment),
      };
    });
  } else {
    if (!calendar.anchor_date)
      throw new CloseError("week-based calendars require an anchor date");
    const anchorFiscalYear = Number(
      calendar.config.anchorFiscalYear ??
        utcDate(calendar.anchor_date).getUTCFullYear(),
    );
    const leapWeekYears = new Set(
      Array.isArray(calendar.config.leapWeekYears)
        ? (calendar.config.leapWeekYears as unknown[]).map(Number)
        : [],
    );
    let start = utcDate(calendar.anchor_date);
    const direction = fiscalYear >= anchorFiscalYear ? 1 : -1;
    for (let year = anchorFiscalYear; year !== fiscalYear; year += direction) {
      const measuredYear = direction > 0 ? year : year - 1;
      start = addDays(
        start,
        direction * (leapWeekYears.has(measuredYear) ? 371 : 364),
      );
    }
    const weeks =
      calendar.cadence === "thirteen_period"
        ? Array(13).fill(4)
        : Array.from({ length: 4 }, () =>
            calendar.cadence === "four_four_five"
              ? [4, 4, 5]
              : calendar.cadence === "four_five_four"
                ? [4, 5, 4]
                : [5, 4, 4],
          ).flat();
    if (leapWeekYears.has(fiscalYear)) weeks[weeks.length - 1] += 1;
    let cursor = start;
    rows = weeks.map((weekCount, index) => {
      const end = addDays(cursor, weekCount * 7 - 1);
      const row = {
        fiscalYear,
        number: index + 1,
        name: periodName(index + 1, fiscalYear),
        startsOn: isoDate(cursor),
        endsOn: isoDate(end),
        adjustment: false,
      };
      cursor = addDays(end, 1);
      return row;
    });
  }

  if (
    calendar.adjustment_period_enabled &&
    !rows.some((row) => row.adjustment)
  ) {
    const final = rows.at(-1);
    if (!final) throw new CloseError("calendar generated no periods");
    rows.push({
      fiscalYear,
      number: rows.length + 1,
      name: periodName(rows.length + 1, fiscalYear, true),
      startsOn: final.endsOn,
      endsOn: final.endsOn,
      adjustment: true,
    });
  }
  // Date-derived period resolution picks one covering period per posting
  // date, so overlapping regular ranges would scope those postings — and
  // the close locks evaluated for them — arbitrarily. Adjustment rows are
  // exempt: the adjustment day intentionally coincides with the final
  // regular day, and date-derived resolution never selects adjustments.
  // Gaps stay legal (posting fails closed with "no accounting period").
  const regular = rows.filter((row) => !row.adjustment);
  for (let i = 0; i < regular.length; i++) {
    for (let j = i + 1; j < regular.length; j++) {
      const a = regular[i]!;
      const b = regular[j]!;
      if (!(a.endsOn < b.startsOn || b.endsOn < a.startsOn)) {
        throw new CloseError(
          `calendar periods overlap: ${a.name} (${a.startsOn}..${a.endsOn}) overlaps ${b.name} (${b.startsOn}..${b.endsOn})`,
        );
      }
    }
  }
  return rows;
}

export async function generateAccountingPeriods(
  orgId: string,
  calendarId: string,
  fiscalYear: number,
  actorId: string,
): Promise<{ created: number; updated: number; periods: GeneratedPeriod[] }> {
  const calendarRes = (await db.execute<CalendarRow>(sql`
    select id, cadence, year_start_month, anchor_date, adjustment_period_enabled, config
      from fiscal_calendars where id = ${calendarId} and org_id = ${orgId} and is_active`));
  const calendar = calendarRes.rows[0];
  if (!calendar) throw new CloseError("active fiscal calendar not found");
  const periods = generatedPeriods(calendar, fiscalYear);

  type ExistingPeriod = {
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
    is_adjustment: boolean;
    has_entries: boolean;
  };
  const loadExisting = (runner: { execute: typeof db.execute }, number: number) =>
    runner.execute<ExistingPeriod>(sql`
      select p.id, p.name, p.starts_on, p.ends_on, p.is_adjustment,
             exists(select 1 from journal_entries e where e.period_id = p.id) as has_entries
        from accounting_periods p
       where p.org_id = ${orgId} and p.fiscal_calendar_id = ${calendarId}
         and p.fiscal_year = ${fiscalYear} and p.period_number = ${number}`)
      .then((found) => found.rows[0]);

  // Phase 1 — extend forward: missing months are created (with open locks)
  // in their own transaction so a blocked re-date below can never roll them
  // back. Extending the calendar must not depend on regenerating history.
  let created = 0;
  await db.transaction(async (tx) => {
    for (const period of periods) {
      if (await loadExisting(tx, period.number)) continue;
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into accounting_periods
          (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on,
           is_adjustment, created_by, updated_by)
        values (${orgId}, ${calendarId}, ${fiscalYear}, ${period.number}, ${period.name},
                ${period.startsOn}, ${period.endsOn}, ${period.adjustment}, ${actorId}, ${actorId})
        returning id`));
      const books = (await tx.execute<{ id: string }>(sql`
        select id from accounting_books where org_id = ${orgId} and is_active`));
      for (const book of books.rows) {
        for (const module of CLOSE_MODULES) {
          await tx.execute(sql`
            insert into period_locks (org_id, period_id, book_id, module, state, created_by, updated_by)
            values (${orgId}, ${inserted.rows[0]!.id}, ${book.id}, ${module}, 'open', ${actorId}, ${actorId})
            on conflict (org_id, period_id, book_id, subsidiary_id, module) do nothing`);
        }
      }
      created++;
    }
  });

  // Phase 2 — reconcile drift on existing months. Only a boundary change
  // (dates/adjustment-ness, what posted activity was booked against) is a
  // regeneration, and it stays refused while entries exist. A bare name
  // drift (seeded `2026-05` vs canonical `P05 FY2026`) renames freely when
  // nothing posted, and is left alone — never an error — once it has.
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const period of periods) {
      const row = await loadExisting(tx, period.number);
      if (!row) continue;
      const datesChanged =
        row.starts_on !== period.startsOn ||
        row.ends_on !== period.endsOn ||
        row.is_adjustment !== period.adjustment;
      const renamed = row.name !== period.name;
      if (!datesChanged && !renamed) continue;
      if (datesChanged && row.has_entries)
        throw new CloseError(
          `${row.name} has ledger activity and its dates cannot be regenerated`,
        );
      if (datesChanged || !row.has_entries) {
        await tx.execute(sql`
          update accounting_periods
             set name = ${period.name}, starts_on = ${period.startsOn}, ends_on = ${period.endsOn},
                 is_adjustment = ${period.adjustment}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.id} and org_id = ${orgId}`);
        updated++;
      }
      // Otherwise: cosmetic name drift on a period with postings — the
      // posted label stands, and generation still succeeds.
    }
  });
  return { created, updated, periods };
}
