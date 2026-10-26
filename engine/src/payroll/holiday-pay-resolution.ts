import { approvedHolidayOccurrenceDates } from "./holiday-obligation-source.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import { MB_CONSTRUCTION_HOLIDAY } from "./canada/employment-standards.ts";
import { addCalendarDays, calendarDaysBetween } from "../platform/business-date.ts";
import { add, cmp, fromUnits, mul, mulDecimal, mulPercent, prorateDays, roundDiv, roundMoney, sum, toUnits } from "../money/money.ts";
import { countryOfJurisdiction, holidayPayLookbackBasis, occupationCapValues, payrollJurisdiction, type PayrollHolidayDayCounting, type PayrollHolidayPayRule } from "./packs.ts";
import { resolveWorkSchedule } from "./work-schedules.ts";
import { PayrollHolidayError, at, weekdayOf, resolveHolidayRule, resolveObservedHolidays, loadHolidayOverrides, type ObservedHoliday } from "./holiday-calendar.ts";
import { lookbackWindow, commissionWindowOf, lookbackEarnings, countHolidayQualifyingDays, loadHolidayDayEvidence, hoursOn, hoursWorkedInLookback } from "./holiday-lookback-evidence.ts";
import { statutoryHolidayPayRule, computeStatutoryHolidayPay, computeWorkTriggeredHolidayPay, type HolidayLookbackEarnings } from "./holiday-pay-computation.ts";

/** Pay-run resolution of statutory holiday pay: eligibility, occupation arms, and earning lines. */

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
async function resolveMbConstructionHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
  holidays: ObservedHoliday[],
): Promise<StatutoryHolidayEarningLine[]> {
  if (input.periodRegularEarnings === undefined) {
    throw new PayrollHolidayError(
      `${input.employeeName}: Manitoba construction holiday pay needs the period's regular wages — `
      + "the caller must supply periodRegularEarnings from the period's earning lines",
    );
  }
  const lines: StatutoryHolidayEarningLine[] = [];
  const fourPercent = mulPercent(input.periodRegularEarnings, MB_CONSTRUCTION_HOLIDAY.percent, 2);
  lines.push({
    componentId: input.holidayComponentId, kind: "earning",
    description: "Manitoba construction general holiday pay (4% of regular wages, s. 30)",
    amount: fourPercent, sequence: 45,
    holidayKey: "mb-construction-holiday-pay", holidayDate: input.periodEnd, periodWide: true,
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
          componentId: input.premiumComponentId, kind: "earning",
          description: `${holiday.name} — premium for hours worked (construction)`,
          amount: premium, sequence: sequence++,
          holidayKey: holiday.key, holidayDate: holiday.date,
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
  return rule.occupationClasses !== undefined || rule.weeklyCap !== undefined
    || (rule.excludedOccupations !== undefined && Object.keys(rule.excludedOccupations).length > 0);
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
      `${employeeName} may be priced under an occupation holiday-pay arm, but their statutory `
      + "occupation class is not recorded — the run will not guess whether an arm applies. "
      + "Record it on the employee's payroll profile, then recalculate",
    );
  }
  const vocabulary = rule.occupationClasses ? Object.keys(rule.occupationClasses) : occupationCapValues(country);
  if (!vocabulary.includes(occupationClass)) {
    throw new PayrollHolidayError(
      `${employeeName} carries unrecognized occupation class "${occupationClass}" — `
      + `record one of ${vocabulary.join(", ")} on the employee's payroll profile, then recalculate`,
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
    currentLines: readonly {
      amount: string;
      kind: string;
      nonPeriodic?: boolean | null;
    }[] | undefined;
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
      toUnits(total((await lookbackEarnings(tx, stubInput, {
        from: addCalendarDays(weekStart, -(cap.lookbackWeeks * 7)),
        to: addCalendarDays(weekStart, -1),
      })).earnings)),
      BigInt(cap.lookbackWeeks),
    ),
  );
  const committed = total((await lookbackEarnings(tx, stubInput, { from: weekStart, to: weekEnd })).earnings);
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
  const allowed = cmp(fromUnits(toUnits(average) - toUnits(weekBase)), "0") < 0
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
}

/** Exact selected legal-employment history shared by calculation and its
 * retained source evidence. Closed recorded versions cannot govern pay. */
export async function statutoryHolidayEmploymentSource(
  tx: Pick<typeof db, "execute">,
  input: Pick<StatutoryHolidayPayInput, "orgId" | "employeePartyId" | "employmentId" | "subsidiaryId" | "employeeName">,
): Promise<StatutoryHolidayEmploymentSource[]> {
  if (!isUuid(input.employmentId) || !isUuid(input.subsidiaryId)) {
    throw new PayrollHolidayError(
      `${input.employeeName}: statutory holiday pay needs the selected native employment and paying legal employer — review the payroll employment link and assign the run to its legal employer before calculating`,
    );
  }
  const rows = await tx.execute<StatutoryHolidayEmploymentSource>(sql`
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
  `, "objects");
  if (rows.length === 0) {
    throw new PayrollHolidayError(
      `${input.employeeName}: the selected holiday-pay employment does not belong to this employee, organization and paying legal employer — review the payroll employment link before calculating`,
    );
  }
  return rows;
}

/** Continuous employed statuses share tenure; gaps and ended states do not. */
function holidayEmploymentSpells(
  rows: readonly StatutoryHolidayEmploymentSource[], employeeName: string,
): HolidayEmploymentSpell[] {
  const spells: HolidayEmploymentSpell[] = [];
  let previousEnd: string | null | undefined;
  for (const row of rows) {
    if (!row.status || !isIsoCalendarDate(row.effectiveFrom)
      || row.effectiveTo !== null && (!isIsoCalendarDate(row.effectiveTo) || row.effectiveTo <= row.effectiveFrom)) {
      throw new PayrollHolidayError(
        `${employeeName}: the selected employment has no usable effective holiday-pay history — record or correct its dated status through an HRM employment change request before calculating`,
      );
    }
    if (previousEnd === null || previousEnd !== undefined && previousEnd > row.effectiveFrom) {
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

export async function resolveStatutoryHolidayPay(
  tx: Pick<typeof db, "execute">,
  input: StatutoryHolidayPayInput,
): Promise<StatutoryHolidayEarningLine[]> {
  const jurisdiction = payrollJurisdiction(input.jurisdiction);
  // Whether a jurisdiction mandates holiday pay AT ALL is date-independent, so
  // it is asked once and before anything is loaded. WHICH formula is in force
  // is a per-holiday question and is asked below, against the holiday's date.
  const workTriggeredHolidays = jurisdiction.workTriggeredHolidays ?? [];
  if (jurisdiction.holidayPay === null && workTriggeredHolidays.length === 0) return [];
  if (jurisdiction.holidayPay !== null && jurisdiction.holidayPay.length === 0) {
    statutoryHolidayPayRule(input.jurisdiction, input.periodStart);
  }

  const overrides = await loadHolidayOverrides(tx, input.orgId, input.jurisdiction);
  const observedIn = (from: string, to: string) =>
    resolveObservedHolidays({ jurisdiction: input.jurisdiction, from, to, overrides });

  const periodHolidays = jurisdiction.holidayPay === null ? [] : observedIn(input.periodStart, input.periodEnd)
    .filter((holiday) => holiday.paid);
  if (input.jurisdiction === "CA-MB") {
    const rule = statutoryHolidayPayRule(input.jurisdiction, input.periodStart);
    if (rule) assertOccupationClass(rule, countryOfJurisdiction(input.jurisdiction), input.occupationClass, input.employeeName);
  }
  const mbConstruction = input.jurisdiction === "CA-MB" && input.occupationClass === "construction";
  if (!mbConstruction && periodHolidays.length === 0 && workTriggeredHolidays.length === 0) return [];
  const employmentSource = await statutoryHolidayEmploymentSource(tx, input);
  const spells = holidayEmploymentSpells(employmentSource, input.employeeName);
  const spellOn = (date: string) => spells.find(spell =>
    spell.from <= date && (spell.to === null || date < spell.to));
  // The pay period admits a worker, but only employment on the observed
  // holiday admits that occurrence and its eligibility questions.
  const holidays = periodHolidays.filter(holiday => spellOn(holiday.date) !== undefined);
  // Manitoba construction (CCSM c E110, s. 30) replaces the whole general
  // per-holiday rule for the stored class — including on a pay with no
  // holiday in it, where the 4% still accrues, so this dispatch precedes
  // the no-holiday early return. Only the stored class takes this path;
  // everyone else runs the general rule below.
  if (mbConstruction) {
    return resolveMbConstructionHolidayPay(tx, input, holidays);
  }
  if (holidays.length === 0 && workTriggeredHolidays.length === 0) return [];

  const lines: StatutoryHolidayEarningLine[] = [];
  let sequence = 45;
  const ownedEntitlementDates = await approvedHolidayOccurrenceDates(tx, {
    orgId: input.orgId, employeePartyId: input.employeePartyId, employmentId: input.employmentId, subsidiaryId: input.subsidiaryId,
    from: input.periodStart, to: input.periodEnd,
  });
  for (const holiday of holidays) {
    const hiredOn = spellOn(holiday.date)!.from;
    // An independently adjudicated unpaid entitlement owns the ordinary
    // day's payment. Work on that date still follows the native premium
    // calculation and its eligibility facts; zero work needs no premium.
    if (ownedEntitlementDates.has(holiday.date) && cmp(await hoursOn(tx, input, holiday.date), "0") === 0) continue;
    // The edition of the statute IN FORCE ON THE HOLIDAY — never today's, and
    // never the current one applied backwards. Refuses by name where the
    // governing statute has not been transcribed.
    const rule = statutoryHolidayPayRule(input.jurisdiction, holiday.date)!;
    let employerWeekStartsOn: string | null = null;
    if (rule.lookbackEnds.kind === "week_before" && rule.lookbackEnds.employerWeekStartsOnFact) {
      if (!input.country || !input.subsidiaryId) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${holiday.name} needs the paying legal employer to resolve its selected work week — `
          + "assign the run to its legal employer, then set the work-week start in Payroll Setup → Employer facts",
        );
      }
      employerWeekStartsOn = await resolveStoredEmployerFact({
        tx, orgId: input.orgId, subsidiaryId: input.subsidiaryId, country: input.country,
        factKey: rule.lookbackEnds.employerWeekStartsOnFact, asOf: holiday.date,
      });
    }
    const selectedWeekStartsOn = employerWeekStartsOn === null ? undefined : Number(employerWeekStartsOn);
    const window = lookbackWindow(rule, holiday.date, selectedWeekStartsOn);
    const { earnings, proratedPeriods } = await lookbackEarnings(tx, input, window);
    // The QUALIFYING window is day-based in every statute that declares one
    // ("the 30 calendar days preceding the statutory holiday"; "30 days worked
    // in the preceding 12 months"), including the jurisdictions whose PAY
    // window ends at the preceding week. The two boundaries are separate
    // sentences and are kept separate.
    const qualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? {
          from: addCalendarDays(holiday.date, -rule.qualifying.minDaysWorkedInWindow.ofDays),
          to: addCalendarDays(holiday.date, -1),
        }
      : window;
    const lookbackBasis = holidayPayLookbackBasis(rule.basis);
    // A commission window changes the lookback's shape, and the
    // last-and-first scheduled-shift test is an entitlement condition
    // wherever the rule declares it. Neither fact is inferable from earnings
    // or a missing time entry, so a real pay run must provide an explicit
    // assertion and stops when it cannot. Both demands follow the rule's own
    // declaration, never a list of jurisdiction keys — gating them on two
    // keys let every other declaring province pay the holiday without ever
    // asking the question its statute requires.
    if (
      lookbackBasis?.kind === "fixed_divisor"
      && lookbackBasis.commission
      && input.paidOnCommission === undefined
    ) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit commission-pay status `
        + "for the statutory holiday calculation — record whether the employee is paid "
        + "in whole or in part on commission",
      );
    }
    const absentWithoutConsent = input.absentWithoutConsentByHoliday?.[`${holiday.key}|${holiday.date}`];
    if (
      rule.qualifying.lastAndFirstScheduledShift
      && absentWithoutConsent === undefined
    ) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit last-and-first-shift `
        + "absence assertion for the statutory holiday calculation — record whether "
        + "the employee was absent without the employer's consent",
      );
    }
    const commissionWindow = lookbackBasis?.kind === "fixed_divisor" && lookbackBasis.commission
      ? commissionWindowOf(rule, holiday.date, lookbackBasis.commission.lookbackWeeks, selectedWeekStartsOn)
      : null;

    // Which days count is the rule's own declaration, twice over: the
    // denominator of an average-day basis and the numerator of a days-in-window
    // qualifier are separate sentences in separate sections, and British
    // Columbia is the jurisdiction where they happen to be the same one.
    const payCounting: PayrollHolidayDayCounting =
      lookbackBasis?.kind === "average_day" ? lookbackBasis.counting : "worked";
    const qualifyingCounting = rule.qualifying.minDaysWorkedInWindow?.counting ?? payCounting;
    /** True only where a statute counts more than the days actually worked. */
    const needsPaidDays = payCounting !== "worked" || qualifyingCounting !== "worked";

    // Resolved as at the HOLIDAY's date, never today: an employee who moved
    // from full-time to part-time in March must still have January's holiday
    // paid on January's pattern. Loaded only where a declaration actually reads
    // it — a `normal_day` basis, or a day count broader than "worked" — so a
    // jurisdiction that divides a lookback by days worked does no work here.
    const schedule = rule.basis.kind === "normal_day" || needsPaidDays
      ? await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, holiday.date)
      : null;

    const evidenceWindow = {
      from: window.from < qualifyingWindow.from ? window.from : qualifyingWindow.from,
      to: window.to > qualifyingWindow.to ? window.to : qualifyingWindow.to,
    };
    const evidence = await loadHolidayDayEvidence(
      tx, input, evidenceWindow,
      needsPaidDays ? observedIn(evidenceWindow.from, evidenceWindow.to) : [],
      needsPaidDays,
    );
    const daysWorked = countHolidayQualifyingDays({
      employee: input.employeeName, window, counting: payCounting, evidence, schedule,
    });
    const daysWorkedInQualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? countHolidayQualifyingDays({
          employee: input.employeeName, window: qualifyingWindow,
          counting: qualifyingCounting, evidence, schedule,
        })
      : daysWorked;
    const dayQualifier = rule.qualifying.minDaysWorkedInWindow;
    if (dayQualifier?.counting === "entitled_to_pay"
        && daysWorkedInQualifyingWindow < dayQualifier.days) {
      const occurrence = `${holiday.key}|${holiday.date}`;
      const attestedCount = input.entitledDayAttestations?.[occurrence];
      if (attestedCount !== daysWorkedInQualifyingWindow) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${holiday.name} (${holiday.date}) has ${daysWorkedInQualifyingWindow} evidenced days entitled to pay in the preceding ${dayQualifier.ofDays}; approve or correct owed paid-leave days, then attest that this run's entitlement-day evidence is complete for this holiday before calculating`,
        );
      }
    }

    // A rule that names an occupation arm depends on the answer, exactly
    // like a commission window depends on commission status: a presented
    // but unrecorded (or out-of-vocabulary) class fails closed by name
    // rather than running the general rule. The demand follows the rule's
    // own declaration, never a list of jurisdiction keys.
    assertOccupationClass(
      rule,
      countryOfJurisdiction(input.jurisdiction),
      input.occupationClass,
      input.employeeName,
    );
    const hoursWorked = await hoursOn(tx, input, holiday.date);
    // One read serves both the commission pricing and the trace: any
    // estimated span behind this stub is named on the day's pay line.
    const commissionLookback = commissionWindow
      ? await lookbackEarnings(tx, input, commissionWindow)
      : undefined;
    const result = computeStatutoryHolidayPay(rule, {
      employee: input.employeeName,
      holiday,
      earnings,
      daysWorked,
      hoursWorkedInLookback: lookbackBasis?.kind === "average_hours_day"
        ? await hoursWorkedInLookback(tx, input, window)
        : undefined,
      daysWorkedInQualifyingWindow,
      employmentDays: calendarDaysBetween(hiredOn, holiday.date),
      employmentWeeks: Math.floor(calendarDaysBetween(hiredOn, holiday.date) / 7),
      commissionEarnings: commissionLookback?.earnings,
      paidOnCommission: input.paidOnCommission,
      absentWithoutConsent,
      occupationClass: input.occupationClass,
      averagingAgreement: input.averagingAgreement,
      hoursWorked,
      salaried: input.salaried,
      hourlyRate: input.hourlyRate,
      schedule,
    });
    if (!result.qualified) continue;

    // An occupation weekly cap (New Brunswick s. 21(2)) clamps the PRICED day
    // after the basis answers — never inside the pure arithmetic, which knows
    // no database. The trace names the clamp so the stub line explains itself.
    const capped = await applyOccupationWeeklyCap(tx, {
      orgId: input.orgId,
      employeePartyId: input.employeePartyId,
      excludeDocumentId: input.excludeDocumentId,
      employeeName: input.employeeName,
      rule,
      holidayDate: holiday.date,
      occupationClass: input.occupationClass,
      hoursWorked,
      computedPay: result.holidayPay,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currentLines: input.currentEarningLines,
    });
    // Estimated lookback spans are named on the day's pay line: with no dated
    // earning evidence the window sum spreads those stubs evenly across their
    // pay periods, and the stub must say so.
    const estimatedSpans = [...new Set([...proratedPeriods, ...(commissionLookback?.proratedPeriods ?? [])])];
    const estimatedNote = estimatedSpans.length > 0
      ? `; lookback earnings from ${estimatedSpans.join(", ")} attributed by calendar-day overlap (those stubs carry no dated earning evidence)`
      : "";
    if (!ownedEntitlementDates.has(holiday.date) && cmp(capped.pay, "0") !== 0) {
      lines.push({
        componentId: input.holidayComponentId, kind: "earning",
        description: `${holiday.name} — statutory holiday pay`,
        amount: capped.pay, sequence: sequence++,
        holidayKey: holiday.key, holidayDate: holiday.date,
        basis: `${result.basis}${capped.note ? `; ${capped.note}` : ""}${estimatedNote}`,
      });
    }
    if (cmp(result.premiumPay, "0") !== 0) {
      lines.push({
        componentId: input.premiumComponentId, kind: "earning",
        description: `${holiday.name} — premium for hours worked`,
        amount: result.premiumPay, sequence: sequence++,
        holidayKey: holiday.key, holidayDate: holiday.date,
        basis: `${rule.premium.multiplier}× the regular rate for hours worked on the holiday`,
      });
    }
  }
  for (const event of workTriggeredHolidays) {
    const firstYear = Number(input.periodStart.slice(0, 4));
    const lastYear = Number(input.periodEnd.slice(0, 4));
    for (let year = firstYear; year <= lastYear; year += 1) {
      const date = resolveHolidayRule(event.rule, year);
      if (date < input.periodStart || date > input.periodEnd
        || (event.effectiveFrom !== null && date < event.effectiveFrom)
        || (event.effectiveTo !== null && date > event.effectiveTo)) continue;
      const spell = spellOn(date);
      if (!spell) continue;
      const hoursWorked = await hoursOn(tx, input, date);
      if (cmp(hoursWorked, "0") <= 0) continue;
      if (event.employerExemptionFact) {
        if (!input.country || !input.subsidiaryId) {
          throw new PayrollHolidayError(
            `${input.employeeName}: ${event.name} needs the legal employer's exemption status — assign the payroll run to its legal employer and record the exemption in Payroll Setup → Employer facts`,
          );
        }
        const exempt = await resolveStoredEmployerFact({
          tx, orgId: input.orgId, subsidiaryId: input.subsidiaryId,
          country: input.country, factKey: event.employerExemptionFact, asOf: date,
        });
        if (exempt === null) {
          throw new PayrollHolidayError(
            `${input.employeeName}: ${event.name} needs the employer's statutory exemption status — record it in Payroll Setup → Employer facts`,
          );
        }
        if (exempt === "true") continue;
      }
      const rule = statutoryHolidayPayRule(input.jurisdiction, date);
      if (!rule) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${event.name} has no holiday-pay formula in force on ${date}`,
        );
      }
      const holiday: ObservedHoliday = {
        jurisdiction: input.jurisdiction, key: event.key, name: event.name,
        statutoryDate: date, date, source: "pack", elected: false, paid: true,
      };
      const window = lookbackWindow(rule, date);
      const { earnings, proratedPeriods: workTriggeredProrated } = await lookbackEarnings(tx, input, window);
      const schedule = await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, date);
      const result = computeWorkTriggeredHolidayPay(rule, event, {
        employee: input.employeeName, holiday, earnings, daysWorked: 0,
        employmentDays: calendarDaysBetween(spell.from, date),
        hoursWorked, hourlyRate: input.hourlyRate, schedule,
      });
      if (!result.qualified) continue;
      const workEstimatedNote = workTriggeredProrated.length > 0
        ? `; lookback earnings from ${workTriggeredProrated.join(", ")} attributed by calendar-day overlap (those stubs carry no dated earning evidence)`
        : "";
      if (cmp(result.holidayPay, "0") !== 0) {
        lines.push({
          componentId: input.holidayComponentId, kind: "earning",
          description: `${event.name} — statutory holiday pay`,
          amount: result.holidayPay, sequence: sequence++,
          holidayKey: event.key, holidayDate: date, basis: `${result.basis}${workEstimatedNote}`,
        });
      }
      if (cmp(result.premiumPay, "0") !== 0) {
        lines.push({
          componentId: input.premiumComponentId, kind: "earning",
          description: `${event.name} — work-triggered overtime minimum`,
          amount: result.premiumPay, sequence: sequence++,
          holidayKey: event.key, holidayDate: date, basis: `${result.basis}${workEstimatedNote}`,
        });
      }
    }
  }
  return lines;
}
