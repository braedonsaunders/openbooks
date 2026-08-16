import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Observed statutory holidays — the TENANT half of the holiday calendar.
 *
 * A statutory holiday is two different things at once and the product has to
 * keep them apart:
 *
 * 1. A jurisdictional FACT. "Labour Day is the first Monday in September in
 *    Canada" is not configuration, it is law, and it belongs in the country
 *    pack beside the statutory components
 *    (engine/src/payroll/packs.ts `PayrollJurisdiction.holidays`). Nothing in
 *    this table can invent, move or delete a mandatory statutory holiday —
 *    letting a tenant switch off Canada Day would be letting a tenant switch
 *    off the law.
 *
 * 2. An employer POLICY, on top of that fact. Every Canadian jurisdiction has
 *    optional days its statute names but does not compel (Boxing Day in
 *    Ontario, Heritage Day in Alberta, Easter Monday in Quebec as the
 *    alternative to Good Friday), and every employer also has purely internal
 *    closures — the week between Christmas and New Year, a shutdown day, a
 *    founder's day. Those ARE configuration and this is where they live.
 *
 * So a row here does exactly one of two things:
 *
 * - `pack_key` SET — an election on a pack-declared day. `is_observed = true`
 *   turns an OPTIONAL day on; `is_observed = false` turns one off again. A row
 *   that tries to switch off a day the pack declares mandatory is rejected by
 *   the engine, not by this table, because only the pack knows which days
 *   those are.
 * - `pack_key` NULL — a company holiday the pack does not declare at all. It
 *   carries its own recurrence rule (or a one-off date).
 *
 * Effective-dated, like every rule that could otherwise reinterpret history.
 * An employer that adds a floating holiday in 2027 must not make last year's
 * pay runs retroactively wrong, and a day dropped in 2027 must still show as
 * observed on the 2026 stubs that paid it. `effective_from`/`effective_to` are
 * compared against the holiday's OBSERVED DATE, not against today.
 *
 * `is_paid` is separate from `is_observed` on purpose. A company holiday can
 * be a paid closure (it attracts holiday pay through the jurisdiction's
 * statutory formula) or an unpaid one (the office is shut and nobody is paid
 * for it). Both are real, and conflating them either pays money nobody agreed
 * to or shuts the office for free.
 */
export const payrollHolidays = pgTable(
  "payroll_holidays",
  {
    id: id(),
    orgId: orgRef(),
    /**
     * The pack jurisdiction this row applies to: 'CA' (federally regulated),
     * 'CA-ON', 'CA-QC', 'US', or a tax administration's own calendar such as
     * 'CA-CRA'. Validated against the pack, so a typo is a loud failure rather
     * than a calendar that silently never matches anything.
     */
    jurisdiction: text("jurisdiction").notNull(),
    /**
     * The pack holiday this row is an election on ('boxing_day',
     * 'heritage_day'). NULL for a company holiday the pack does not declare.
     */
    packKey: text("pack_key"),
    /** Display name. For a pack election the pack's name still wins on the
     *  calendar; this is only used for company holidays. */
    name: text("name"),

    /**
     * Recurrence, mirroring `PayrollHolidayRule` in the pack so a company
     * holiday can be "the first Friday in August" and not just a list of
     * dates somebody has to re-enter every December.
     *
     * - `date`           — a one-off, in `observed_on`.
     * - `fixed`          — rule_month / rule_day, every year.
     * - `nth_weekday`    — rule_month / rule_weekday / rule_nth (nth = -1 is
     *                      the last such weekday of the month).
     * - `weekday_before` — the last rule_weekday strictly before
     *                      rule_month/rule_day.
     * - `easter_offset`  — rule_offset days from Easter Sunday.
     *
     * NULL for a pack election, which takes the pack's rule.
     */
    ruleKind: text("rule_kind", {
      enum: ["date", "fixed", "nth_weekday", "weekday_before", "easter_offset"],
    }),
    ruleMonth: integer("rule_month"),
    ruleDay: integer("rule_day"),
    /** 0 = Sunday … 6 = Saturday, matching the pack and JavaScript. */
    ruleWeekday: integer("rule_weekday"),
    ruleNth: integer("rule_nth"),
    ruleOffset: integer("rule_offset"),
    /** The date itself, for `rule_kind = 'date'`. */
    observedOn: date("observed_on"),
    /** Weekend handling; the same three values the pack declares. */
    observance: text("observance", {
      enum: ["none", "next_monday", "nearest_weekday"],
    })
      .notNull()
      .default("none"),

    /** The election: true adds the day, false suppresses an optional one. */
    isObserved: boolean("is_observed").notNull().default(true),
    /** Does the day attract statutory holiday pay, or is it an unpaid closure. */
    isPaid: boolean("is_paid").notNull().default(true),

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    index("payroll_holidays_org_jurisdiction").on(t.orgId, t.jurisdiction, t.effectiveFrom),
    // One election per pack day per jurisdiction per effective start: two
    // contradictory rows for Boxing Day 2027 is ambiguous configuration, and
    // ambiguous configuration about money is a defect, not a preference.
    uniqueIndex("payroll_holidays_org_pack_key")
      .on(t.orgId, t.jurisdiction, t.packKey, t.effectiveFrom)
      .where(sql`pack_key is not null`),
    check(
      "payroll_holidays_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    // A company holiday has to say WHEN it is and what it is called; a pack
    // election takes both from the pack.
    check(
      "payroll_holidays_shape",
      sql`(${t.packKey} is not null and ${t.ruleKind} is null)
          or (${t.packKey} is null and ${t.ruleKind} is not null
              and ${t.name} is not null and length(btrim(${t.name})) > 0)`,
    ),
    // Every recurrence kind carries exactly the columns it needs. Without
    // these a half-filled rule resolves to a plausible wrong date instead of
    // failing: 'nth_weekday' with no nth would silently mean "the 1st".
    check(
      "payroll_holidays_rule_columns",
      sql`${t.ruleKind} is null
          or (${t.ruleKind} = 'date' and ${t.observedOn} is not null)
          or (${t.ruleKind} = 'fixed'
              and ${t.ruleMonth} between 1 and 12 and ${t.ruleDay} between 1 and 31)
          or (${t.ruleKind} = 'nth_weekday'
              and ${t.ruleMonth} between 1 and 12 and ${t.ruleWeekday} between 0 and 6
              and ${t.ruleNth} between -1 and 5 and ${t.ruleNth} <> 0)
          or (${t.ruleKind} = 'weekday_before'
              and ${t.ruleMonth} between 1 and 12 and ${t.ruleDay} between 1 and 31
              and ${t.ruleWeekday} between 0 and 6)
          or (${t.ruleKind} = 'easter_offset' and ${t.ruleOffset} between -60 and 60)`,
    ),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
