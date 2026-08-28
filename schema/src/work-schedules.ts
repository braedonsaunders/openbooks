import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Work schedules — the hours and days an employee is NORMALLY scheduled to
 * work.
 *
 * This is a generic employment attribute, not a payroll-jurisdiction one. Every
 * employment-standards regime in the world reaches for it, because the two
 * questions statutes actually ask are:
 *
 *   "what would this employee have earned on the day the holiday fell?"
 *   "did they work their scheduled shift on either side of it?"
 *
 * Neither can be answered by a single weekly-hours number, and neither may be
 * ASSUMED. An employee with no schedule recorded has an UNKNOWN pattern; a
 * formula that needs one refuses by name rather than inventing an eight-hour
 * day, because an invented day's pay is indistinguishable from a correct one on
 * the stub and wrong in the bank.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL: a repeating cycle of days, anchored to a date.
 * ---------------------------------------------------------------------------
 *
 * `cycle_days` days long, starting on `cycle_anchor`, with one
 * `work_schedule_days` row per position in the cycle carrying the hours
 * normally worked on it. The day a date falls on is
 * `(date - cycle_anchor) mod cycle_days`, so the pattern extends backwards and
 * forwards forever from one anchor with no per-week rows to maintain.
 *
 * That one shape expresses every real pattern:
 *
 * - the ordinary week — `cycle_days = 7`, anchored on a Sunday, so the cycle
 *   position IS the weekday. Monday–Friday 8h is five rows of 8 and two of 0.
 * - part-time with different hours by day — the same seven rows, unequal.
 * - a compressed nine-day fortnight — `cycle_days = 14`.
 * - a 4-on-4-off rotation — `cycle_days = 8`, and it deliberately does NOT
 *   line up with the week, which is exactly why the model is a cycle and not
 *   seven weekday columns.
 *
 * `pattern` = `varies` is the OTHER real answer: the employee genuinely has no
 * regular schedule (casual, on-call, hours set week by week). It is a positive
 * statement of a fact several statutes branch on — "where the hours vary, use
 * the average instead of the day" — and it is NOT the same as no row at all,
 * which is silence. A `varies` schedule carries no day rows.
 *
 * ---------------------------------------------------------------------------
 * SCOPE AND EFFECTIVE DATING
 * ---------------------------------------------------------------------------
 *
 * Identical to `labor_cost_rates` and `payroll_entitlement_plan_limits`, and
 * deliberately so — this product resolves scoped, effective-dated rules ONE
 * way: most-specific scope wins
 *   employee > job title > trade > department > subsidiary > organization
 * and within the winning scope the latest `effective_from` ≤ the date wins.
 *
 * The date compared is the WORK DATE, never today. Someone who moved from
 * full-time to part-time in March must still have January's holiday pay resolve
 * against the full-time pattern, and re-running a closed period must reproduce
 * that period's answer rather than today's configuration.
 */
export const workSchedules = pgTable(
  "work_schedules",
  {
    id: id(),
    orgId: orgRef(),
    /** Operator-facing label ("Full time, Mon–Fri", "4 on 4 off"). */
    name: text("name"),

    // --- scope: exactly zero or one key; zero is the organization default ---
    employeePartyId: uuid("employee_party_id"),
    jobTitle: text("job_title"),
    tradeId: uuid("trade_id"),
    departmentId: uuid("department_id"),
    subsidiaryId: uuid("subsidiary_id"),

    /**
     * `cycle` — a repeating pattern, described by `work_schedule_days`.
     * `varies` — no regular schedule; hours are set period by period. A
     * declared fact, never a default, and never confused with an absent row.
     */
    pattern: text("pattern", { enum: ["cycle", "varies"] }).notNull().default("cycle"),
    /** Length of the repeating cycle in days. 7 is the ordinary week. */
    cycleDays: integer("cycle_days"),
    /**
     * The date that is position 0 of the cycle. For a weekly pattern this is a
     * Sunday, so position == weekday and the editor can label the rows
     * Sunday…Saturday; for a rotation it is the first day of a known cycle.
     */
    cycleAnchor: date("cycle_anchor"),

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("work_schedules_employee").on(t.orgId, t.employeePartyId, t.effectiveFrom),
    index("work_schedules_job_title").on(t.orgId, t.jobTitle, t.effectiveFrom),
    index("work_schedules_trade").on(t.orgId, t.tradeId, t.effectiveFrom),
    index("work_schedules_department").on(t.orgId, t.departmentId, t.effectiveFrom),
    index("work_schedules_subsidiary").on(t.orgId, t.subsidiaryId, t.effectiveFrom),
    // One row per scope per start date: two contradictory patterns for the same
    // employee from the same day is ambiguous configuration, and ambiguous
    // configuration about a day's pay is a defect, not a preference.
    // Nullable scope keys must be folded to one sentinel per scope so PostgreSQL
    // cannot treat two NULLs as distinct. Job titles are case-insensitive in the
    // resolver, so the indexed key applies the same lower-case normalization.
    uniqueIndex("work_schedules_scope_from").on(
      t.orgId,
      sql`coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(lower(job_title), '')`,
      sql`coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.effectiveFrom,
    ),
    check(
      "work_schedules_one_scope",
      sql`num_nonnulls(${t.employeePartyId}, ${t.jobTitle}, ${t.tradeId}, ${t.departmentId}, ${t.subsidiaryId}) <= 1`,
    ),
    check(
      "work_schedules_valid_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    // A cycle must say how long it is and where it starts; a varying schedule
    // must not pretend to. A half-filled cycle would resolve to a plausible
    // wrong day rather than failing.
    check(
      "work_schedules_pattern_columns",
      sql`(${t.pattern} = 'cycle' and ${t.cycleDays} is not null and ${t.cycleDays} between 1 and 366
           and ${t.cycleAnchor} is not null)
          or (${t.pattern} = 'varies' and ${t.cycleDays} is null and ${t.cycleAnchor} is null)`,
    ),
  ],
);

/**
 * One position in a schedule's cycle, and the hours normally worked on it.
 *
 * A child TABLE rather than a JSON array on the parent: the hours of a working
 * day are queryable, constrainable and reportable data, and the editor renders
 * them as real number inputs. A blob would make the UI a JSON textarea, which
 * this product does not do.
 *
 * A position with no row means no scheduled hours — the same as an explicit
 * zero — so a Monday-to-Friday week may be stored as five rows or as seven.
 */
export const workScheduleDays = pgTable(
  "work_schedule_days",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    /** 0 … cycle_days − 1. For a weekly cycle anchored on a Sunday this is the
     *  weekday, 0 = Sunday, matching PayrollHolidayRule and JavaScript. */
    dayIndex: integer("day_index").notNull(),
    /** Hours normally worked on this position. Zero is a scheduled day off. */
    hours: numeric("hours", { precision: 9, scale: 4 }).notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    index("work_schedule_days_schedule").on(t.orgId, t.scheduleId, t.dayIndex),
    uniqueIndex("work_schedule_days_position").on(t.scheduleId, t.dayIndex),
    check("work_schedule_days_index", sql`${t.dayIndex} >= 0 and ${t.dayIndex} < 366`),
    // 24 is the ceiling a day can physically hold; a 30 is a typo, and a typo
    // in scheduled hours is a typo in a day's holiday pay.
    check("work_schedule_days_hours", sql`${t.hours} >= 0 and ${t.hours} <= 24`),
  ],
);

// Foreign keys are maintained in schema/migrations/referential-integrity.sql.
