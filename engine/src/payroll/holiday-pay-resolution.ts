import { approvedHolidayOccurrenceDates } from "./holiday-obligation-source.ts";
import { db } from "../platform/db.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import { addCalendarDays, calendarDaysBetween } from "../platform/business-date.ts";
import { cmp } from "../money/money.ts";
import {
  countryOfJurisdiction,
  holidayPayLookbackBasis,
  payrollJurisdiction,
  type PayrollHolidayDayCounting,
} from "./packs.ts";
import { resolveWorkSchedule } from "./work-schedules.ts";
import {
  PayrollHolidayError,
  resolveHolidayRule,
  resolveObservedHolidays,
  loadHolidayOverrides,
  type ObservedHoliday,
} from "./holiday-calendar.ts";
import {
  lookbackWindow,
  commissionWindowOf,
  lookbackEarnings,
  countHolidayQualifyingDays,
  loadHolidayDayEvidence,
  hoursOn,
  hoursWorkedInLookback,
} from "./holiday-lookback-evidence.ts";
import {
  statutoryHolidayPayRule,
  computeStatutoryHolidayPay,
  computeWorkTriggeredHolidayPay,
} from "./holiday-pay-computation.ts";
import {
  resolveMbConstructionHolidayPay,
  assertOccupationClass,
  applyOccupationWeeklyCap,
  statutoryHolidayEmploymentSource,
  holidayEmploymentSpells,
  type StatutoryHolidayEarningLine,
  type StatutoryHolidayPayInput,
} from "./holiday-pay-eligibility.ts";

/** Pay-run resolution of statutory holiday pay into earning lines. */

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

  const periodHolidays =
    jurisdiction.holidayPay === null
      ? []
      : observedIn(input.periodStart, input.periodEnd).filter((holiday) => holiday.paid);
  if (input.jurisdiction === "CA-MB") {
    const rule = statutoryHolidayPayRule(input.jurisdiction, input.periodStart);
    if (rule)
      assertOccupationClass(
        rule,
        countryOfJurisdiction(input.jurisdiction),
        input.occupationClass,
        input.employeeName,
      );
  }
  const mbConstruction = input.jurisdiction === "CA-MB" && input.occupationClass === "construction";
  if (!mbConstruction && periodHolidays.length === 0 && workTriggeredHolidays.length === 0)
    return [];
  const employmentSource = await statutoryHolidayEmploymentSource(tx, input);
  const spells = holidayEmploymentSpells(employmentSource, input.employeeName);
  const spellOn = (date: string) =>
    spells.find((spell) => spell.from <= date && (spell.to === null || date < spell.to));
  // The pay period admits a worker, but only employment on the observed
  // holiday admits that occurrence and its eligibility questions.
  const holidays = periodHolidays.filter((holiday) => spellOn(holiday.date) !== undefined);
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
    orgId: input.orgId,
    employeePartyId: input.employeePartyId,
    employmentId: input.employmentId,
    subsidiaryId: input.subsidiaryId,
    from: input.periodStart,
    to: input.periodEnd,
  });
  for (const holiday of holidays) {
    const hiredOn = spellOn(holiday.date)!.from;
    // An independently adjudicated unpaid entitlement owns the ordinary
    // day's payment. Work on that date still follows the native premium
    // calculation and its eligibility facts; zero work needs no premium.
    if (
      ownedEntitlementDates.has(holiday.date) &&
      cmp(await hoursOn(tx, input, holiday.date), "0") === 0
    )
      continue;
    // The edition of the statute IN FORCE ON THE HOLIDAY — never today's, and
    // never the current one applied backwards. Refuses by name where the
    // governing statute has not been transcribed.
    const rule = statutoryHolidayPayRule(input.jurisdiction, holiday.date)!;
    let employerWeekStartsOn: string | null = null;
    if (rule.lookbackEnds.kind === "week_before" && rule.lookbackEnds.employerWeekStartsOnFact) {
      if (!input.country || !input.subsidiaryId) {
        throw new PayrollHolidayError(
          `${input.employeeName}: ${holiday.name} needs the paying legal employer to resolve its selected work week — ` +
            "assign the run to its legal employer, then set the work-week start in Payroll Setup → Employer facts",
        );
      }
      employerWeekStartsOn = await resolveStoredEmployerFact({
        tx,
        orgId: input.orgId,
        subsidiaryId: input.subsidiaryId,
        country: input.country,
        factKey: rule.lookbackEnds.employerWeekStartsOnFact,
        asOf: holiday.date,
      });
    }
    const selectedWeekStartsOn =
      employerWeekStartsOn === null ? undefined : Number(employerWeekStartsOn);
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
      lookbackBasis?.kind === "fixed_divisor" &&
      lookbackBasis.commission &&
      input.paidOnCommission === undefined
    ) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit commission-pay status ` +
          "for the statutory holiday calculation — record whether the employee is paid " +
          "in whole or in part on commission",
      );
    }
    const absentWithoutConsent =
      input.absentWithoutConsentByHoliday?.[`${holiday.key}|${holiday.date}`];
    if (rule.qualifying.lastAndFirstScheduledShift && absentWithoutConsent === undefined) {
      throw new PayrollHolidayError(
        `${input.employeeName}: ${holiday.name} needs an explicit last-and-first-shift ` +
          "absence assertion for the statutory holiday calculation — record whether " +
          "the employee was absent without the employer's consent",
      );
    }
    const commissionWindow =
      lookbackBasis?.kind === "fixed_divisor" && lookbackBasis.commission
        ? commissionWindowOf(
            rule,
            holiday.date,
            lookbackBasis.commission.lookbackWeeks,
            selectedWeekStartsOn,
          )
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
    const schedule =
      rule.basis.kind === "normal_day" || needsPaidDays
        ? await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, holiday.date)
        : null;

    const evidenceWindow = {
      from: window.from < qualifyingWindow.from ? window.from : qualifyingWindow.from,
      to: window.to > qualifyingWindow.to ? window.to : qualifyingWindow.to,
    };
    const evidence = await loadHolidayDayEvidence(
      tx,
      input,
      evidenceWindow,
      needsPaidDays ? observedIn(evidenceWindow.from, evidenceWindow.to) : [],
      needsPaidDays,
    );
    const daysWorked = countHolidayQualifyingDays({
      employee: input.employeeName,
      window,
      counting: payCounting,
      evidence,
      schedule,
    });
    const daysWorkedInQualifyingWindow = rule.qualifying.minDaysWorkedInWindow
      ? countHolidayQualifyingDays({
          employee: input.employeeName,
          window: qualifyingWindow,
          counting: qualifyingCounting,
          evidence,
          schedule,
        })
      : daysWorked;
    const dayQualifier = rule.qualifying.minDaysWorkedInWindow;
    if (
      dayQualifier?.counting === "entitled_to_pay" &&
      daysWorkedInQualifyingWindow < dayQualifier.days
    ) {
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
      hoursWorkedInLookback:
        lookbackBasis?.kind === "average_hours_day"
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
    const estimatedSpans = [
      ...new Set([...proratedPeriods, ...(commissionLookback?.proratedPeriods ?? [])]),
    ];
    const estimatedNote =
      estimatedSpans.length > 0
        ? `; lookback earnings from ${estimatedSpans.join(", ")} attributed by calendar-day overlap (those stubs carry no dated earning evidence)`
        : "";
    if (!ownedEntitlementDates.has(holiday.date) && cmp(capped.pay, "0") !== 0) {
      lines.push({
        componentId: input.holidayComponentId,
        kind: "earning",
        description: `${holiday.name} — statutory holiday pay`,
        amount: capped.pay,
        sequence: sequence++,
        holidayKey: holiday.key,
        holidayDate: holiday.date,
        basis: `${result.basis}${capped.note ? `; ${capped.note}` : ""}${estimatedNote}`,
      });
    }
    if (cmp(result.premiumPay, "0") !== 0) {
      lines.push({
        componentId: input.premiumComponentId,
        kind: "earning",
        description: `${holiday.name} — premium for hours worked`,
        amount: result.premiumPay,
        sequence: sequence++,
        holidayKey: holiday.key,
        holidayDate: holiday.date,
        basis: `${rule.premium.multiplier}× the regular rate for hours worked on the holiday`,
      });
    }
  }
  for (const event of workTriggeredHolidays) {
    const firstYear = Number(input.periodStart.slice(0, 4));
    const lastYear = Number(input.periodEnd.slice(0, 4));
    for (let year = firstYear; year <= lastYear; year += 1) {
      const date = resolveHolidayRule(event.rule, year);
      if (
        date < input.periodStart ||
        date > input.periodEnd ||
        (event.effectiveFrom !== null && date < event.effectiveFrom) ||
        (event.effectiveTo !== null && date > event.effectiveTo)
      )
        continue;
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
          tx,
          orgId: input.orgId,
          subsidiaryId: input.subsidiaryId,
          country: input.country,
          factKey: event.employerExemptionFact,
          asOf: date,
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
        jurisdiction: input.jurisdiction,
        key: event.key,
        name: event.name,
        statutoryDate: date,
        date,
        source: "pack",
        elected: false,
        paid: true,
      };
      const window = lookbackWindow(rule, date);
      const { earnings, proratedPeriods: workTriggeredProrated } = await lookbackEarnings(
        tx,
        input,
        window,
      );
      const schedule = await resolveWorkSchedule(tx, input.orgId, input.employeePartyId, date);
      const result = computeWorkTriggeredHolidayPay(rule, event, {
        employee: input.employeeName,
        holiday,
        earnings,
        daysWorked: 0,
        employmentDays: calendarDaysBetween(spell.from, date),
        hoursWorked,
        hourlyRate: input.hourlyRate,
        schedule,
      });
      if (!result.qualified) continue;
      const workEstimatedNote =
        workTriggeredProrated.length > 0
          ? `; lookback earnings from ${workTriggeredProrated.join(", ")} attributed by calendar-day overlap (those stubs carry no dated earning evidence)`
          : "";
      if (cmp(result.holidayPay, "0") !== 0) {
        lines.push({
          componentId: input.holidayComponentId,
          kind: "earning",
          description: `${event.name} — statutory holiday pay`,
          amount: result.holidayPay,
          sequence: sequence++,
          holidayKey: event.key,
          holidayDate: date,
          basis: `${result.basis}${workEstimatedNote}`,
        });
      }
      if (cmp(result.premiumPay, "0") !== 0) {
        lines.push({
          componentId: input.premiumComponentId,
          kind: "earning",
          description: `${event.name} — work-triggered overtime minimum`,
          amount: result.premiumPay,
          sequence: sequence++,
          holidayKey: event.key,
          holidayDate: date,
          basis: `${result.basis}${workEstimatedNote}`,
        });
      }
    }
  }
  return lines;
}
