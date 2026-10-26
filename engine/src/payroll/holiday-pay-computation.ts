import { add, cmp, fromUnits, mul, mulDecimal, mulPercent, mulRatio, roundDiv, roundMoney, sum, toUnits } from "../money/money.ts";
import { holidayPayLookbackBasis, payrollJurisdiction, type PayrollHolidayDayCounting, type PayrollHolidayPayEdition, type PayrollHolidayPayRule, type PayrollWorkTriggeredHoliday } from "./packs.ts";
import { describeWorkSchedule, normalWorkdayHours, scheduledHoursPerWeek, type ResolvedWorkSchedule } from "./work-schedules.ts";
import { PayrollHolidayError, at, type ObservedHoliday } from "./holiday-calendar.ts";

/** Pure statutory holiday-pay computation over a resolved lookback context. */

/**
 * The jurisdiction's holiday-pay rule AS IT STOOD ON `onDate`, or `null` where
 * the jurisdiction genuinely mandates none (the United States).
 *
 * Three distinct answers, and no two of them may collapse:
 *
 *  - a RULE — the edition in force on the date;
 *  - `null` — the law requires nothing;
 *  - a THROW — either nobody has transcribed the jurisdiction at all (out of
 *    `payrollJurisdiction`), or nobody has transcribed the statute that
 *    governed this particular date. The second is the Prince Edward Island
 *    case: SPEI 2024 c 66 came into force on 2026-06-30 and replaced a regular
 *    day's pay with a percentage, so a June 2026 PEI period is governed by a
 *    repealed Act this pack does not carry. Computing it on the new formula
 *    would be wrong money nobody would ever see; refusing names the Act.
 *
 * `onDate` is the WORK DATE — the holiday's own date — never today. Re-running
 * a 2019 period must reproduce the 2019 formula, exactly as re-running it
 * reproduces the 2019 calendar and the 2019 withholding tables.
 */
export function statutoryHolidayPayRule(
  jurisdiction: string,
  onDate: string,
): PayrollHolidayPayRule | null {
  const declaration = payrollJurisdiction(jurisdiction);
  const editions = declaration.holidayPay;
  if (editions === null) return null;
  if (editions.length === 0) {
    throw new PayrollHolidayError(
      `${declaration.name}: the public-holiday calendar and statutory holiday-pay rule under ${declaration.citation} are not transcribed — this jurisdiction is not yet supported by the holiday-pay calendar; contact support before calculating payroll`,
    );
  }
  const date = onDate.slice(0, 10);
  // Latest in-force edition wins, so a correction issued with a later
  // `effectiveFrom` supersedes rather than ties. `effectiveFrom: null` sorts
  // first because it is the unbounded-before edition.
  let best: PayrollHolidayPayEdition | null = null;
  for (const edition of editions) {
    if (edition.effectiveFrom !== null && edition.effectiveFrom > date) continue;
    if (edition.effectiveTo !== null && edition.effectiveTo < date) continue;
    if (
      best === null
      || (best.effectiveFrom ?? "") < (edition.effectiveFrom ?? "")
    ) best = edition;
  }
  if (best === null) {
    const known = editions
      .map((edition) =>
        `${edition.effectiveFrom ?? "the beginning"} – ${edition.effectiveTo ?? "current"}`)
      .join("; ");
    throw new PayrollHolidayError(
      `${declaration.name} declares no statutory holiday-pay formula in force on ${date} — `
      + `the statute governing that date has not been transcribed (transcribed: ${known}). `
      + "This date is not yet supported by the holiday-pay calendar; contact support, or run "
      + "the period against a date the pack covers. This calculation will not apply a formula "
      + "that was not the law at the time",
    );
  }
  return best.rule;
}

/** Earnings inside a lookback window, split by what the statutes include. */
export interface HolidayLookbackEarnings {
  /** Regular wages — everything that is not one of the categories below. */
  regular: string;
  overtime: string;
  vacationPay: string;
  /** Statutory holiday pay already paid inside the window. */
  holidayPay: string;
}

export const emptyLookbackEarnings = (): HolidayLookbackEarnings => ({
  regular: "0", overtime: "0", vacationPay: "0", holidayPay: "0",
});

export interface HolidayPayContext {
  /** Named in every refusal, so an operator knows which stub stopped. */
  employee: string;
  holiday: ObservedHoliday;
  /** Earnings over the rule's own lookback window. */
  earnings: HolidayLookbackEarnings;
  /**
   * The denominator of an `average_day` rule: how many days of the PAY window
   * satisfy that basis's own `counting` predicate. Not always "days worked" —
   * British Columbia divides by the days the employee worked OR EARNED WAGES
   * (ESA s. 45(1)), Alberta and New Brunswick by days worked.
   * `countHolidayQualifyingDays` is what produces it.
   */
  daysWorked: number;
  /** Approved hours actually worked in the pay basis window. */
  hoursWorkedInLookback?: string;
  /**
   * The same count over the QUALIFYING window, when the rule declares one that
   * is a different length from the pay window (BC: 15 of the 30 days before) —
   * and, in Nova Scotia, under a different predicate as well (s. 42(1)'s
   * "entitled to receive pay" against the averaging arm's "worked").
   */
  daysWorkedInQualifyingWindow?: number;
  /** Calendar days between the hire date and the holiday; null when unknown. */
  employmentDays: number | null;
  /** The employee is paid in whole or in part on commission. */
  paidOnCommission?: boolean;
  /**
   * The employee's standing statutory occupation class (the profile column's
   * raw value), read only where the rule declares an occupation arm — a
   * weekly cap or an excluded occupation. A named excluded class denies the
   * day outright; any other class runs the general rule below. Undefined
   * (probes, callers that never present the question) skips the arms; the
   * resolver refuses a presented-but-unrecorded null by name first, so the
   * pure calculation never answers the general rule on a guess.
   */
  occupationClass?: string | null;
  /** Complete weeks of continuous employment, for the commission windows. */
  employmentWeeks?: number | null;
  /** Earnings over the commission lookback, when the rule declares one. */
  commissionEarnings?: HolidayLookbackEarnings;
  /** Hours actually worked ON the holiday. */
  hoursWorked: string;
  /**
   * True when the stub pays this employee a full periodic salary rather than
   * priced timesheet hours. Read only where the rule declares a
   * `salariedTreatment`; everywhere else it is ignored. The run presents it
   * straight off the employment's pay basis — never inferred from the rate's
   * shape, because an annualized hourly-equivalent rate and a salary price
   * the same hours differently.
   */
  salaried?: boolean;
  /** Regular hourly rate, for the premium and for a `normal_day` basis. */
  hourlyRate: string;
  /**
   * The employee's normal work pattern on the day of the holiday
   * (engine/src/payroll/work-schedules.ts), or null when none is recorded.
   *
   * Only a `normal_day` basis reads it, and only that basis is affected by its
   * absence — every lookback rule computes from committed stubs exactly as it
   * always did, whether or not a schedule exists. `null` and "not supplied"
   * both mean UNKNOWN, and a rule that needs it refuses by name rather than
   * assuming a working day of any length.
   */
  schedule?: ResolvedWorkSchedule | null;
  /**
   * The employer asserting the last-and-first test was failed — the employee
   * was absent WITHOUT consent on the last scheduled shift before or the first
   * after. Only ever supplied deliberately; see `computeStatutoryHolidayPay`.
   */
  absentWithoutConsent?: boolean;
  /**
   * The employer asserting the employee worked under an averaging agreement in
   * the qualifying window (BC ESA s. 37). Read only where the rule declares
   * `averagingAgreementAlternative`; everywhere else it is ignored. Never
   * inferred from hours or schedules — an agreement is a legal fact, and a
   * pattern that looks like one is not one.
   */
  averagingAgreement?: boolean;
}

export interface HolidayPayResult {
  holidayKey: string;
  holidayName: string;
  date: string;
  qualified: boolean;
  /** Present exactly when `qualified` is false. */
  disqualifiedReason?: string;
  /** The day's pay. */
  holidayPay: string;
  /** The ADDITIONAL amount owed for hours worked on the day — see below. */
  premiumPay: string;
  /** Plain-language derivation, carried onto the stub line for the audit
   *  trail: an employee who queries their holiday pay gets the arithmetic. */
  basis: string;
}

/** The statute's own words for a day-counting predicate, for the stub trace and
 *  for a refusal an employee will read. */
export function describeDayCounting(counting: PayrollHolidayDayCounting): string {
  switch (counting) {
    case "worked": return "worked";
    case "worked_or_earned_wages": return "worked or earned wages";
    case "entitled_to_pay": return "was paid, or entitled to be paid";
  }
}

/** Exact `amount ÷ divisor`, rounded once, in BigInt from end to end. */
function divideExact(amount: string, divisor: number): string {
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new PayrollHolidayError(`cannot divide holiday pay by ${divisor}`);
  }
  // roundDiv is money.ts's half-away-from-zero integer division; scaling by
  // 100 and back rounds exactly once, at cents.
  return fromUnits(roundDiv(toUnits(amount) * 100n, BigInt(divisor) * 100n * 100n) * 100n);
}

/** The lookback base a rule's inclusions produce. */
export function holidayPayBase(
  earnings: HolidayLookbackEarnings,
  include: PayrollHolidayPayRule["include"],
): string {
  return sum([
    earnings.regular,
    include.overtime ? earnings.overtime : "0",
    include.vacationPay ? earnings.vacationPay : "0",
    include.holidayPay ? earnings.holidayPay : "0",
  ]);
}

/**
 * A day's statutory holiday pay and the premium for working it — PURE, so
 * every jurisdiction's arithmetic is verifiable against the statute's own
 * worked example with no database.
 *
 * On the premium: the returned `premiumPay` is the amount owed IN ADDITION to
 * the regular wages the hours already earn. Time worked on the holiday is
 * already on the stub at 1.0× from the timesheet, so a jurisdiction that
 * requires time and a half is owed the remaining 0.5×. Emitting the full 1.5×
 * here would pay the hours twice. Quebec, which requires the indemnity plus
 * ordinary wages and no premium at all, declares a multiplier of 1 and
 * therefore correctly produces nothing.
 *
 * On the last-and-first test: the engine never INFERS it. The statutes
 * disqualify an employee absent without the employer's CONSENT, and consent is
 * not a fact any timesheet records — an absence in the data is as likely to be
 * approved leave. Inferring it would deny statutory pay on a guess, so the
 * denial has to be asserted (`absentWithoutConsent`), and the rule's
 * declaration of the test is what makes that field meaningful rather than a
 * free-text note.
 */
export function computeStatutoryHolidayPay(
  rule: PayrollHolidayPayRule,
  context: HolidayPayContext,
): HolidayPayResult {
  const shell = {
    holidayKey: context.holiday.key,
    holidayName: context.holiday.name,
    date: context.holiday.date,
  };
  const deny = (reason: string): HolidayPayResult => ({
    ...shell, qualified: false, disqualifiedReason: reason,
    holidayPay: "0", premiumPay: "0", basis: reason,
  });

  if (!context.holiday.paid) {
    return deny("the day is configured as an unpaid closure");
  }

  // The statute's own excluded occupation. A named class is not entitled to
  // the day at all — denied before qualifying, pricing, and premium alike,
  // so a member never receives the day's pay in any form. A class the rule
  // does not name runs the general rule below; the arms are special cases,
  // never a second general rule. (An UNANSWERED class never reaches here
  // from a real run: the resolver refuses it by name first.)
  const excluded = context.occupationClass == null
    ? undefined
    : rule.excludedOccupations?.[context.occupationClass];
  if (excluded !== undefined) {
    return deny(`${excluded.reason} (${excluded.citation})`);
  }

  const { qualifying } = rule;
  /**
   * Set when the day-count arm fails but the rule's own averaging-agreement
   * alternative carries the employee. Recorded here so the derivation below
   * names the arm that qualified them — a stub that says "15 of 30" for an
   * employee with 10 counted days is a lie the audit trail must not tell.
   */
  let averagingAgreementApplied = false;
  if (
    qualifying.minEmploymentDays !== undefined
    && !(qualifying.minEmploymentDaysWhenUnworked && cmp(context.hoursWorked, "0") > 0)
  ) {
    if (context.employmentDays === null) {
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} needs a hire date to test the `
        + `${qualifying.minEmploymentDays}-day qualifying period — set it on the employee record`,
      );
    }
    if (context.employmentDays < qualifying.minEmploymentDays) {
      return deny(
        `employed ${context.employmentDays} of the ${qualifying.minEmploymentDays} calendar days `
        + "the jurisdiction requires before the holiday",
      );
    }
  }
  if (qualifying.minDaysWorkedInWindow) {
    const { days, ofDays, counting } = qualifying.minDaysWorkedInWindow;
    const worked = context.daysWorkedInQualifyingWindow ?? context.daysWorked;
    if (worked < days) {
      // A statute's own alternative to the count (BC ESA s. 44(b): an averaging
      // agreement in the window) qualifies despite the short count — but only
      // where the rule declares it AND the caller asserts the agreement. An
      // unasserted agreement keeps the denial: the count is what the engine can
      // see, and the agreement is what it cannot.
      if (qualifying.averagingAgreementAlternative === true && context.averagingAgreement === true) {
        averagingAgreementApplied = true;
      } else {
        // The reason quotes the jurisdiction's OWN sentence. An employee refused
        // in Nova Scotia was not "not working enough"; they were not entitled to
        // pay on enough days, which is a different fact and a different appeal.
        return deny(
          `${describeDayCounting(counting)} on ${worked} of the ${ofDays} days before the `
          + `holiday; ${days} are required`,
        );
      }
    }
  }
  if (qualifying.lastAndFirstScheduledShift && context.absentWithoutConsent === true) {
    return deny(
      "absent without the employer's consent on the last scheduled shift before or the first after",
    );
  }

  // --- the day's pay -------------------------------------------------------
  let holidayPay: string | null = null;
  let basis = "";
  /** Set when a `normal_day` rule fell through to the statute's own
   *  varying-hours arm, so the derivation says WHY it took the average. */
  let irregularBecause: string | null = null;

  // A `normal_day` basis pays the wages the employee would have earned on the
  // day itself, from their work schedule (engine/src/payroll/work-schedules.ts) — not
  // from any quantity of prior earnings. It is tried first, and where the
  // statute's own condition for it fails ("where the hours of work or wages
  // vary") it falls through to the lookback arm the same statute declares.
  if (rule.basis.kind === "normal_day") {
    const schedule = context.schedule ?? null;
    if (!schedule) {
      // The one refusal this basis exists to make. There is no default working
      // day: eight hours, or a fifth of forty, is a number indistinguishable on
      // the stub from a correct one and wrong in the bank. Note that "their
      // hours vary" is a RECORDABLE answer, not a missing one — which is why
      // this refusal is always actionable.
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays the wages of the employee's normal `
        + `working day, and no work schedule is in force on ${context.holiday.date} — record the `
        + "hours and days they are normally scheduled to work, or record that their hours vary. "
        + "This calculation will not assume a working day it has not been told about",
      );
    }
    const perWeek = scheduledHoursPerWeek(schedule);
    const belowStandard = rule.basis.minWeeklyHours !== undefined
      && (perWeek === null || cmp(perWeek, String(rule.basis.minWeeklyHours)) < 0);
    const normalHours = normalWorkdayHours(schedule);
    if (belowStandard) {
      irregularBecause = `the employee works ${perWeek ?? "irregular"} hours a week, less than the `
        + `${rule.basis.minWeeklyHours} the jurisdiction treats as standard`;
    } else if (normalHours === null) {
      irregularBecause = `the employee's hours vary (${describeWorkSchedule(schedule)})`;
    } else if (context.paidOnCommission === true) {
      irregularBecause = "the employee is paid on commission, so their daily wages vary";
    } else if (cmp(context.hourlyRate, "0") <= 0) {
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays the wages of their normal working day `
        + "but no regular rate of pay is recorded — set the employee's pay rate before calculating",
      );
    } else {
      // ONE normal working day, not the calendar day the holiday landed on: a
      // holiday falling on the employee's day off is a substitute day off with
      // pay, so the same day's wages are owed either way.
      holidayPay = roundMoney(mul(context.hourlyRate, normalHours), 2);
      basis = `${normalHours} hours — one normal working day (${describeWorkSchedule(schedule)}) `
        + `— × ${context.hourlyRate} regular rate`;
    }
  }

  // The lookback arm: the rule's own basis, or a `normal_day` rule's declared
  // fallback for an employee with no normal day. Absent only where the
  // statute states no fallback at all — then a fall-through refuses by name
  // below instead of pricing a formula the law never wrote.
  const basisRule = holidayPayLookbackBasis(rule.basis);
  const commission = basisRule?.kind === "fixed_divisor" ? basisRule.commission : undefined;
  const useCommission = Boolean(
    commission
    && context.paidOnCommission
    && (context.employmentWeeks ?? 0) >= commission.minWeeksEmployed,
  );

  if (holidayPay !== null) {
    // Already settled by the normal-day arm.
  } else if (!basisRule) {
    throw new PayrollHolidayError(
      `${context.employee}: ${context.holiday.name} pays the wages of a normal working day, `
      + "but this employee has no normal day and the governing statute states no fallback "
      + "measure for that case — the run refuses rather than inventing a rate. Settle the day's "
      + "pay as the statute provides, then file the answer",
    );
  } else if (basisRule.kind === "fixed_divisor" && useCommission && commission) {
    const earnings = context.commissionEarnings ?? context.earnings;
    const base = holidayPayBase(earnings, rule.include);
    holidayPay = divideExact(base, commission.divisor);
    basis = `${base} earned in the ${commission.lookbackWeeks} weeks before the holiday `
      + `÷ ${commission.divisor} (commission basis)`;
  } else if (basisRule.kind === "fixed_divisor") {
    const base = holidayPayBase(context.earnings, rule.include);
    holidayPay = divideExact(base, basisRule.divisor);
    basis = `${base} earned in the ${basisRule.lookbackWeeks} weeks before the holiday `
      + `÷ ${basisRule.divisor}`;
  } else if (basisRule.kind === "percent_of_earnings") {
    const base = holidayPayBase(context.earnings, rule.include);
    holidayPay = mulPercent(base, basisRule.percent, 2);
    basis = `${basisRule.percent}% of ${base} earned in the `
      + `${basisRule.lookbackWeeks} weeks before the holiday`;
  } else {
    const base = holidayPayBase(context.earnings, rule.include);
    const window = basisRule.kind === "average_day" && basisRule.lookbackDays !== undefined
      ? `${basisRule.lookbackDays} days`
      : `${basisRule.lookbackWeeks ?? 4} weeks`;
    const counted = basisRule.kind === "average_hours_day"
      ? "worked"
      : describeDayCounting(basisRule.counting);
    if (context.daysWorked <= 0) {
      // An average-day jurisdiction with a zero denominator is undefined, not
      // zero. Paying nothing here would be a real entitlement quietly lost, so
      // it stops the run and names the employee.
      if (
        basisRule.kind === "average_hours_day"
          ? cmp(context.hoursWorkedInLookback ?? "0", "0") === 0 && cmp(base, "0") === 0
          : cmp(base, "0") === 0
      ) {
        return deny(`no wages were earned in the ${window} before the holiday`);
      }
      throw new PayrollHolidayError(
        `${context.employee}: ${context.holiday.name} pays an average day's wage but no days `
        + `on which the employee ${counted} are recorded in the ${window} before it, while `
        + `${base} was earned — the average is undefined; correct the timesheet before `
        + "calculating",
      );
    }
    if (basisRule.kind === "average_hours_day") {
      if (context.hoursWorkedInLookback === undefined) {
        throw new PayrollHolidayError(
          `${context.employee}: ${context.holiday.name} needs approved hours worked in the `
          + `${window} before the holiday to calculate the statutory average — correct the `
          + "approved timesheets before calculating",
        );
      }
      if (cmp(context.hourlyRate, "0") <= 0) {
        throw new PayrollHolidayError(
          `${context.employee}: ${context.holiday.name} uses the current hourly rate for its `
          + "average-hours holiday pay, but no current regular rate is recorded — set the "
          + "employee's pay rate before calculating",
        );
      }
      holidayPay = roundMoney(
        mulRatio(
          context.hourlyRate,
          toUnits(context.hoursWorkedInLookback),
          BigInt(context.daysWorked) * 10_000n,
        ),
        2,
      );
      basis = `${context.hourlyRate} current hourly rate × ${context.hoursWorkedInLookback} hours `
        + `worked in the ${window} before the holiday ÷ ${context.daysWorked} days worked`;
    } else {
      holidayPay = divideExact(base, context.daysWorked);
      basis = `${base} earned in the ${window} before the holiday ÷ ${context.daysWorked} `
        + `days ${counted}`;
    }
  }
  if (irregularBecause !== null) basis = `${irregularBecause}, so ${basis}`;
  if (averagingAgreementApplied) {
    basis = `${basis} — qualified under the averaging-agreement alternative, not the day count`;
  }

  // --- premium for hours actually worked -----------------------------------
  let premiumPay = "0";
  if (cmp(context.hoursWorked, "0") > 0 && cmp(context.hourlyRate, "0") > 0) {
    const { premium } = rule;
    const cap = premium.overtimeAfterHours;
    const hoursAtBase = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
      ? String(cap)
      : context.hoursWorked;
    const hoursAbove = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
      ? fromUnits(toUnits(context.hoursWorked) - toUnits(String(cap)))
      : "0";
    // (multiplier − 1): the hours are already paid at 1.0× by the timesheet.
    const uplift = (multiplier: string) => fromUnits(toUnits(multiplier) - toUnits("1"));
    premiumPay = roundMoney(
      add(
        mulDecimal(mul(context.hourlyRate, hoursAtBase), uplift(premium.multiplier)),
        cmp(hoursAbove, "0") > 0 && premium.overtimeMultiplier
          ? mulDecimal(mul(context.hourlyRate, hoursAbove), uplift(premium.overtimeMultiplier))
          : "0",
      ),
      2,
    );
    if (!premium.plusHolidayPay) holidayPay = "0";
  }

  // --- the salary-satisfied day --------------------------------------------
  // Where the jurisdiction's own guidance lets a full periodic salary satisfy
  // the day (see PayrollSalariedHolidayTreatment), a salaried employee's stub
  // needs no holiday-pay line: the salary already paid the day, so pricing it
  // again pays it twice. Hours actually worked on the day reprice at the
  // rule's FULL premium multiple — not the uplift above — because the salary
  // never paid a 1.0× base for them; the hourly uplift here would leave those
  // hours nearly unpaid.
  const treatment = rule.salariedTreatment;
  if (treatment && context.salaried === true) {
    if (cmp(context.hoursWorked, "0") > 0 && cmp(context.hourlyRate, "0") > 0) {
      const { premium } = rule;
      const cap = premium.overtimeAfterHours;
      const hoursAtBase = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
        ? String(cap)
        : context.hoursWorked;
      const hoursAbove = cap !== undefined && cmp(context.hoursWorked, String(cap)) > 0
        ? fromUnits(toUnits(context.hoursWorked) - toUnits(String(cap)))
        : "0";
      premiumPay = roundMoney(
        add(
          mulDecimal(mul(context.hourlyRate, hoursAtBase), premium.multiplier),
          cmp(hoursAbove, "0") > 0 && premium.overtimeMultiplier
            ? mulDecimal(mul(context.hourlyRate, hoursAbove), premium.overtimeMultiplier)
            : "0",
        ),
        2,
      );
      holidayPay = "0";
      basis = `${basis}; the period salary satisfies the day's pay, so only the premium is owed — `
        + `${context.hoursWorked} hours worked at the full ${premium.multiplier}× statutory multiple `
        + `(no 1.0× base was paid for these hours) (${treatment.citation})`;
    } else {
      holidayPay = "0";
      basis = `${basis}; satisfied by the period salary — no additional general holiday pay is owed `
        + `to a salaried employee who did not work the holiday (${treatment.citation})`;
    }
  }

  return { ...shell, qualified: true, holidayPay, premiumPay, basis };
}

/** Compute a separate statutory payment whose trigger is working a dated event. */
export function computeWorkTriggeredHolidayPay(
  rule: PayrollHolidayPayRule,
  event: PayrollWorkTriggeredHoliday,
  context: HolidayPayContext,
): HolidayPayResult {
  if (cmp(context.hoursWorked, "0") <= 0) {
    throw new PayrollHolidayError(`${context.employee}: ${event.name} payment requires hours worked on the date`);
  }
  const result = computeStatutoryHolidayPay({
    ...rule,
    qualifying: {
      ...rule.qualifying,
      ...event.qualifying,
    },
  }, { ...context, hoursWorked: "0", absentWithoutConsent: false });
  if (!result.qualified || event.payment.kind === "alternate_paid_day") return result;
  if (!context.schedule) {
    throw new PayrollHolidayError(
      `${context.employee}: ${event.name} needs the employee's normal daily hours to apply its half-day work minimum — record the work schedule`,
    );
  }
  const normalHours = normalWorkdayHours(context.schedule);
  if (normalHours === null) {
    throw new PayrollHolidayError(
      `${context.employee}: ${event.name} needs a regular workday to apply its half-day work minimum — record the normal schedule or resolve the statutory hours`,
    );
  }
  const halfNormalDay = mulRatio(normalHours, 1n, 2n);
  const overtimeHours = cmp(context.hoursWorked, halfNormalDay) >= 0
    ? context.hoursWorked : halfNormalDay;
  const requiredOvertimeWages = mulDecimal(
    mul(context.hourlyRate, overtimeHours), event.payment.overtimeRate,
  );
  const ordinaryWagesAlreadyPaid = mul(context.hourlyRate, context.hoursWorked);
  const premiumPay = cmp(requiredOvertimeWages, ordinaryWagesAlreadyPaid) > 0
    ? roundMoney(add(requiredOvertimeWages, fromUnits(-toUnits(ordinaryWagesAlreadyPaid))), 2)
    : "0";
  return {
    ...result,
    premiumPay,
    basis: `${result.basis}; work-triggered overtime minimum ${event.payment.overtimeRate}× ${overtimeHours} hours (the greater of hours worked and half a normal day)`,
  };
}

// ---------------------------------------------------------------------------
// Pay-run input: phase 2 of the pipeline contract
// ---------------------------------------------------------------------------
