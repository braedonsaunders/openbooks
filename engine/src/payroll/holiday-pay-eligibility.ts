import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { MB_CONSTRUCTION_HOLIDAY } from "./canada/employment-standards.ts";
import { addCalendarDays, calendarDaysBetween } from "../platform/business-date.ts";
import {
  add,
  cmp,
  fromUnits,
  mul,
  mulDecimal,
  mulPercent,
  prorateDays,
  roundDiv,
  roundMoney,
  sum,
  toUnits,
} from "../money/money.ts";
import { occupationCapValues, type PayrollHolidayPayRule } from "./packs.ts";
import { PayrollHolidayError, weekdayOf, type ObservedHoliday } from "./holiday-calendar.ts";
import { lookbackEarnings, hoursOn } from "./holiday-lookback-evidence.ts";
import { type HolidayLookbackEarnings } from "./holiday-pay-computation.ts";

/** Statutory holiday-pay eligibility: occupation arms, weekly caps, and employment source. */

/** An earning line shaped for `calculateStub`'s line set (phase 2, beside
 *  derived earnings), so holiday pay is in gross before the statutory pass. */
export interface StatutoryHolidayEarningLine {
  componentId: string;
  kind: "earning";
  description: string;
  hours?: string;
  rate?: string;
  amount: string;
  sequence: number;
  /** Provenance for the stub trace. */
  holidayKey: string;
  holidayDate: string;
  /** Wages earned across the whole period rather than on the holiday date. */
  periodWide?: true;
  basis: string;
}

export interface StatutoryHolidayPayInput {
  orgId: string;
  /** Paying legal employer for effective-dated employer facts. */
  subsidiaryId?: string | null;
  country?: string;
  employeePartyId: string;
  /** Exact native employment selected for this payment; never reselected from a profile. */
  employmentId: string;
  employeeName: string;
  /** 'CA-ON', 'CA', 'US-TX' — from `jurisdictionKey(country, province)`. */
  jurisdiction: string;
  periodStart: string;
  periodEnd: string;
  /** pay_components.id for stat_holiday and stat_holiday_premium. */
  holidayComponentId: string;
  premiumComponentId: string;
  /** The pay run being calculated, excluded from its own lookback. */
  excludeDocumentId: string;
  /**
   * True when the stub pays a full periodic salary rather than priced
   * timesheet hours — presented straight off the employment's pay basis, so
   * a rule declaring a `salariedTreatment` can settle the day against the
   * salary instead of pricing it twice. Omitted callers get the hourly
   * behaviour, exactly as before.
   */
  salaried?: boolean;
  hourlyRate: string;
  /**
   * Eligibility facts supplied by the payroll caller. These are deliberately
   * explicit rather than inferred from a timesheet: commission pay changes the
   * statutory lookback/divisor, while an unconsented absence is a legal fact
   * that an attendance gap cannot establish.
   */
  paidOnCommission?: boolean;
  /**
   * The absence assertion per holiday occurrence (`holidayKey|holidayDate`),
   * filed one holiday at a time. An occurrence's own answer wins over the
   * employee-wide `absentWithoutConsent`.
   */
  absentWithoutConsentByHoliday?: Readonly<Record<string, boolean>>;
  /**
   * The presented statutory occupation class (the profile column's raw
   * value). A rule declaring occupation-specific pay refuses an unanswered
   * class. The run reads this from the employment's payroll profile.
   */
  occupationClass?: string | null;
  /**
   * The stub's earning lines so far (before this holiday's lines), for the
   * weekly cap's same-week slice. Undefined callers get the committed-stubs
   * slice only; the run always passes its lines.
   */
  currentEarningLines?: readonly {
    amount: string;
    kind: string;
    nonPeriodic?: boolean | null;
  }[];
  /**
   * Whether the employee worked under an averaging agreement in the qualifying
   * window (BC ESA s. 37). Read only where the rule declares the
   * `averagingAgreementAlternative`; no stored producer supplies it yet, so a
   * run that needs the alternative asserts it here per employee.
   */
  averagingAgreement?: boolean;
  /** Audited complete-evidence assertions by holiday occurrence key. */
  entitledDayAttestations?: Readonly<Record<string, number>>;
  /**
   * The pay's regular wages for the construction 4% base, supplied by the
   * caller from the period's earning lines. Required when the Manitoba
   * construction path runs; never inferred from a lookback.
   */
  periodRegularEarnings?: string;
}

/**
 * Employee facts that affect a jurisdiction's statutory entitlement. An
 * omitted property means the employer has not supplied the authoritative
 * evidence; the database-backed resolver refuses the affected Ontario/Quebec
 * calculation rather than guessing from a pay component or timesheet gap.
 */
export interface StatutoryHolidayEligibilityFacts {
  paidOnCommission?: boolean;
  /**
   * The absence assertion per holiday occurrence (`holidayKey|holidayDate`),
   * filed one holiday at a time. An occurrence's own answer wins over the
   * employee-wide `absentWithoutConsent`.
   */
  absentWithoutConsentByHoliday?: Readonly<Record<string, boolean>>;
  entitledDayAttestations?: Readonly<Record<string, number>>;
}

/**
 * Manitoba construction employees (CCSM c E110, s. 30, MB_CONSTRUCTION_HOLIDAY):
 * 4% of the pay's regular wages on every pay plus 1.5× the regular rate for
 * approved hours worked on a general holiday — INSTEAD of the general
 * per-holiday rule, which never runs for this class. No qualifying tests, no
 * lookback, no commission/absence assertions: the statute asks none. The 4%
 * is wages like the general holiday pay it replaces. The premium reuses
 * approved time-on-day so only recorded holiday work is paid; a zero or
 * unknown hourly rate pays no premium, mirroring the general path.
 */
export async function resolveMbConstructionHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  holidays: ObservedHoliday[],
): Promise<StatutoryHolidayEarningLine[]> {
  if (input.periodRegularEarnings === undefined) {
    throw new PayrollHolidayError(
      `${input.employeeName}: Manitoba construction holiday pay needs the period's regular wages — ` +
        "the caller must supply periodRegularEarnings from the period's earning lines",
    );
  }
  const lines: StatutoryHolidayEarningLine[] = [];
  const fourPercent = mulPercent(input.periodRegularEarnings, MB_CONSTRUCTION_HOLIDAY.percent, 2);
  lines.push({
    componentId: input.holidayComponentId,
    kind: "earning",
    description: "Manitoba construction general holiday pay (4% of regular wages, s. 30)",
    amount: fourPercent,
    sequence: 45,
    holidayKey: "mb-construction-holiday-pay",
    holidayDate: input.periodEnd,
    periodWide: true,
    basis: `4% of current-period regular wages (${MB_CONSTRUCTION_HOLIDAY.citation})`,
  });
  let sequence = 46;
  for (const holiday of holidays) {
    const worked = await hoursOn(tx, input, holiday.date);
    if (cmp(worked, "0") > 0 && cmp(input.hourlyRate, "0") > 0) {
      const uplift = fromUnits(toUnits(MB_CONSTRUCTION_HOLIDAY.premiumMultiplier) - toUnits("1"));
      const premium = roundMoney(mulDecimal(mul(input.hourlyRate, worked), uplift), 2);
      if (cmp(premium, "0") !== 0) {
        lines.push({
          componentId: input.premiumComponentId,
          kind: "earning",
          description: `${holiday.name} — premium for hours worked (construction)`,
          amount: premium,
          sequence: sequence++,
          holidayKey: holiday.key,
          holidayDate: holiday.date,
          basis: `${MB_CONSTRUCTION_HOLIDAY.premiumMultiplier}× the regular rate for hours worked on the holiday (${MB_CONSTRUCTION_HOLIDAY.citation})`,
        });
      }
    }
  }
  return lines;
}

/**
 * Statutory holiday pay for every observed paid holiday landing inside the pay
 * period, as pay-run INPUT lines.
 *
 * Returns an empty array — never throws — when the jurisdiction mandates no
 * holiday pay. Throws, naming the jurisdiction, when the pack does not declare
 * it at all.
 *
 * The lookback reads committed stubs and only attributes boundary earnings
 * when their dated lines establish which side of the window earned them.
 */
/**
 * Whether a holiday-pay rule depends on the standing occupation answer — the
 * one predicate every consumer of occupation arms reads, so "declares arms"
 * never drifts between the resolver, the cap, and the profile UI.
 */
export function ruleDeclaresOccupationArms(rule: PayrollHolidayPayRule): boolean {
  return (
    rule.occupationClasses !== undefined ||
    rule.weeklyCap !== undefined ||
    (rule.excludedOccupations !== undefined && Object.keys(rule.excludedOccupations).length > 0)
  );
}

/**
 * Fail-closed gate for the presented occupation class, shared by the weekly
 * cap and the excluded-occupation denial so both enforce the identical gate.
 * Pure (no database) so the goldens pin it directly; the resolver calls it
 * before pricing each holiday.
 *
 * A rule with occupation-specific pay requires a stored class from its
 * declared vocabulary. Rules without occupation-specific pay need no class.
 */
export function assertOccupationClass(
  rule: PayrollHolidayPayRule,
  country: string,
  occupationClass: string | null | undefined,
  employeeName: string,
): void {
  if (!ruleDeclaresOccupationArms(rule)) return;
  if (occupationClass == null) {
    throw new PayrollHolidayError(
      `${employeeName} may be priced under an occupation holiday-pay arm, but their statutory ` +
        "occupation class is not recorded — the run will not guess whether an arm applies. " +
        "Record it on the employee's payroll profile, then recalculate",
    );
  }
  const vocabulary = rule.occupationClasses
    ? Object.keys(rule.occupationClasses)
    : occupationCapValues(country);
  if (!vocabulary.includes(occupationClass)) {
    throw new PayrollHolidayError(
      `${employeeName} carries unrecognized occupation class "${occupationClass}" — ` +
        `record one of ${vocabulary.join(", ")} on the employee's payroll profile, then recalculate`,
    );
  }
}

/**
 * An occupation weekly cap (New Brunswick ESA s. 21(2)): a route
 * salesperson's pay for an UNWORKED holiday shall not push the week's
 * earnings above their average weekly wages for the preceding four weeks.
 *
 * Both terms are day-count pro-rata allocations — the engine's established
 * method for straddling periods, applied here to the Sunday week (the Act
 * states no employer election) and to the trailing 28 days. "Wages" is read
 * unqualified: every earning bucket counts, unlike the s. 21(1) base that
 * excludes overtime, vacation, and holiday pay. The current stub's lines are
 * sliced to the week∩period overlap; non-periodic (retro) lines are excluded
 * because they belong to other periods, not this week. The result floors at
 * zero: a week already above the average earns no holiday pay, it never earns
 * negative pay.
 *
 * Skips (returns the computed pay) where the rule declares no cap, where the
 * caller never presented the occupation question, where the occupation is not
 * the capped one, or where the holiday was worked. The presented-answer gate
 * (`assertOccupationClass`) runs in the resolver before pricing, so this
 * function meets only answered, vocabulary-valid classes. Exported for the
 * week-total goldens.
 */
export async function applyOccupationWeeklyCap(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    employeePartyId: string;
    excludeDocumentId: string;
    employeeName: string;
    rule: PayrollHolidayPayRule;
    holidayDate: string;
    occupationClass: string | null | undefined;
    hoursWorked: string;
    computedPay: string;
    periodStart: string;
    periodEnd: string;
    currentLines:
      | readonly {
          amount: string;
          kind: string;
          nonPeriodic?: boolean | null;
        }[]
      | undefined;
  },
): Promise<{ pay: string; note: string | null }> {
  const unchanged = { pay: args.computedPay, note: null };
  const cap = args.rule.weeklyCap;
  if (!cap) return unchanged;
  if (cmp(args.hoursWorked, "0") > 0) return unchanged;
  // The resolver's `assertOccupationClass` gate already refused unrecorded
  // and out-of-vocabulary answers; a vocabulary value this rule does not
  // name runs the general rule below.
  if (args.occupationClass !== cap.cappedValue) return unchanged;

  const stubInput = {
    orgId: args.orgId,
    employeePartyId: args.employeePartyId,
    excludeDocumentId: args.excludeDocumentId,
  };
  const intoWeek = weekdayOf(args.holidayDate) % 7;
  const weekStart = addCalendarDays(args.holidayDate, -intoWeek);
  const weekEnd = addCalendarDays(weekStart, 6);
  const total = (earnings: HolidayLookbackEarnings): string =>
    sum([earnings.regular, earnings.overtime, earnings.vacationPay, earnings.holidayPay]);
  const average = fromUnits(
    roundDiv(
      toUnits(
        total(
          (
            await lookbackEarnings(tx, stubInput, {
              from: addCalendarDays(weekStart, -(cap.lookbackWeeks * 7)),
              to: addCalendarDays(weekStart, -1),
            })
          ).earnings,
        ),
      ),
      BigInt(cap.lookbackWeeks),
    ),
  );
  const committed = total(
    (await lookbackEarnings(tx, stubInput, { from: weekStart, to: weekEnd })).earnings,
  );
  const periodDays = calendarDaysBetween(args.periodStart, args.periodEnd) + 1;
  const overlapFrom = args.periodStart > weekStart ? args.periodStart : weekStart;
  const overlapTo = args.periodEnd < weekEnd ? args.periodEnd : weekEnd;
  const overlapDays = calendarDaysBetween(overlapFrom, overlapTo) + 1;
  const currentTotal = sum(
    (args.currentLines ?? [])
      .filter((line) => line.kind === "earning" && !line.nonPeriodic)
      .map((line) => line.amount),
  );
  const weekBase = add(committed, prorateDays(currentTotal, Math.max(0, overlapDays), periodDays));
  const allowed =
    cmp(fromUnits(toUnits(average) - toUnits(weekBase)), "0") < 0
      ? "0"
      : fromUnits(toUnits(average) - toUnits(weekBase));
  if (cmp(args.computedPay, allowed) <= 0) return unchanged;
  return {
    pay: allowed,
    note: `occupation weekly cap: week earnings ${weekBase} against a ${average} average — paid ${allowed} of ${args.computedPay}`,
  };
}

interface HolidayEmploymentSpell {
  from: string;
  /** Native employment windows have an exclusive end. */
  to: string | null;
}

export type StatutoryHolidayEmploymentSource = {
  orgId: string;
  employeePartyId: string;
  employmentId: string;
  subsidiaryId: string;
  employmentRevision: number;
  versionId: string | null;
  versionNo: number | null;
  status: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  recordedAt: string | null;
};

/** Exact selected legal-employment history shared by calculation and its
 * retained source evidence. Closed recorded versions cannot govern pay. */
export async function statutoryHolidayEmploymentSource(
  tx: Pick<typeof db, "execute">,
  input: Pick<
    StatutoryHolidayPayInput,
    "orgId" | "employeePartyId" | "employmentId" | "subsidiaryId" | "employeeName"
  >,
): Promise<StatutoryHolidayEmploymentSource[]> {
  if (!isUuid(input.employmentId) || !isUuid(input.subsidiaryId)) {
    throw new PayrollHolidayError(
      `${input.employeeName}: statutory holiday pay needs the selected native employment and paying legal employer — review the payroll employment link and assign the run to its legal employer before calculating`,
    );
  }
  const rows = await tx.execute<StatutoryHolidayEmploymentSource>(
    sql`
    select e.org_id::text as "orgId", e.worker_party_id::text as "employeePartyId",
           e.id::text as "employmentId", e.employer_subsidiary_id::text as "subsidiaryId",
           e.revision as "employmentRevision", v.id::text as "versionId", v.version_no as "versionNo",
           v.status, v.effective_from::text as "effectiveFrom", v.effective_to::text as "effectiveTo",
           to_char(v.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
      from worker_employments e
      left join worker_employment_versions v
        on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
     where e.org_id = ${input.orgId} and e.id = ${input.employmentId}
       and e.worker_party_id = ${input.employeePartyId}
       and e.employer_subsidiary_id = ${input.subsidiaryId}
     order by v.effective_from, v.version_no
  `,
    "objects",
  );
  if (rows.length === 0) {
    throw new PayrollHolidayError(
      `${input.employeeName}: the selected holiday-pay employment does not belong to this employee, organization and paying legal employer — review the payroll employment link before calculating`,
    );
  }
  return rows;
}

/** Continuous employed statuses share tenure; gaps and ended states do not. */
export function holidayEmploymentSpells(
  rows: readonly StatutoryHolidayEmploymentSource[],
  employeeName: string,
): HolidayEmploymentSpell[] {
  const spells: HolidayEmploymentSpell[] = [];
  let previousEnd: string | null | undefined;
  for (const row of rows) {
    if (
      !row.status ||
      !isIsoCalendarDate(row.effectiveFrom) ||
      (row.effectiveTo !== null &&
        (!isIsoCalendarDate(row.effectiveTo) || row.effectiveTo <= row.effectiveFrom))
    ) {
      throw new PayrollHolidayError(
        `${employeeName}: the selected employment has no usable effective holiday-pay history — record or correct its dated status through an HRM employment change request before calculating`,
      );
    }
    if (previousEnd === null || (previousEnd !== undefined && previousEnd > row.effectiveFrom)) {
      throw new PayrollHolidayError(
        `${employeeName}: the selected employment has overlapping holiday-pay status windows — correct its dated HRM employment history before calculating`,
      );
    }
    previousEnd = row.effectiveTo;
    if (!["active", "on_leave", "suspended"].includes(row.status)) continue;
    const previousSpell = spells.at(-1);
    if (previousSpell?.to === row.effectiveFrom) previousSpell.to = row.effectiveTo;
    else spells.push({ from: row.effectiveFrom, to: row.effectiveTo });
  }
  return spells;
}
