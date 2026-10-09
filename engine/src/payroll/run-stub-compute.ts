import { historicalWithholdingProfile } from './historical-withholding.ts';
import { prepareCompensationPackages, appendCompensationPackageStage, persistCompensationPackageCalculations } from './compensation-package-payroll.ts';
import { ONE_OFF_RUN_TYPES } from "./run-contracts.ts";
/**
 * Single-stub computation orchestrating the earning phases, statutory passes, and protection.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { aggregateUsSupplementalWageAmounts } from "./supplemental-wages.ts";
import { aggregateUsStatutoryExemptionAmounts } from "./statutory-exemptions.ts";
import { cmp, sum } from "../money/money.ts";
import { payrollCertificate, resolveCertificate, revalidateStoredCertificates, type ResolvedCertificate } from "./certificates.ts";
import { packRates, PayrollPackError, assertPayrollRegionSupported, type EmployeePayrollContext, type PayrollRunContext, type PayrollTaxBaseKey, type SupplementalTaxMethod } from "./packs.ts";
import type { PayPeriodPriors } from "./period-priors.ts";
import { assertConfiguredStatutoryRates, type StatutoryRateResolution } from "./statutory-rates.ts";
import { createPushStatutory } from "./push-statutory.ts";
import { assessStubAggregateLevies } from "./employer-aggregate-priors.ts";
import { assertSettlementFactorsMergeable, settleAnnualSettlement } from "./annual-settlement-run.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "./statutory-context.ts";
import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";
import { payRateIsUsable, payrollHourlyWage } from "./rate.ts";
import { alternateDayPlanOf, assertComponentServiceEligibility, entitlementPlans, planMovementsForStub, resolveVacationTerms, resolveServiceTier, vacationPlanOf, type EntitlementWarning } from "./entitlements.ts";
import { grantRemembranceAlternateDay } from "./remembrance-grants.ts";
import { resolvePayrollPaymentMethod } from "./payment-method.ts";
import { assertEarningsAssessedStable, dropIncomeAssessedLines, type EarningsAssessedLine } from "./limits.ts";
import { reduceTaxBases } from "./treatment-bases.ts";
import { assertVacationPlanResolved } from "./run-setup.ts";
import { type StubComputation, storedTaxCertificates, resolvePayRate, resolveStubStatutoryHours } from "./run-calculation-support.ts";
import { type Line, installablePackOrThrow, insertPayStubRow, insertPayStubLineRows, persistEntitlementMovements, earningsAssessedSnapshot, resolveEmployeeJurisdiction, stampDepartmentExpenseAccounts } from "./run-stub-records.ts";
import { appendPeriodicEarnings, appendRetroSettlementLines, appendDerivedEarningLines, appendStatutoryHolidayEarningLines, applyAssignedComponentLines, applyRunLineAdjustments, appendUnionFringeLines, applyEntitlementPlanMovements } from "./run-earning-lines.ts";
import { applyBankDrawdown } from "./run-bank-drawdown.ts";
import { settleTerminationBankPayouts, appendCashVacationPay } from "./run-final-payouts.ts";
import { assignmentOverlapsPeriod } from "./assignment-windows.ts";
import { settleDeductionProtection, recordProtectionShortfalls } from "./run-protection.ts";
import { resolveProtectionExemptFloors } from "./protection-classes.ts";
import { applyEarningPaymentKinds, payableStubTotals } from "./non-cash-earnings.ts";
import { appendRecurringBenefitLines } from './benefit-plan-inputs.ts';
export async function calculateStub(
  tx: Pick<typeof db, "execute">,
  ctx: {
    orgId: string; actorId: string; documentId: string;
    run: Record<string, string>; emp: Record<string, string | null>;
    /** The run's resolved jurisdiction — one country, entity, currency, year. */
    runContext: PayrollRunContext;
    /** This employee's place in it, already asserted to agree with the run's. */
    jurisdiction: EmployeePayrollContext;
    periodsPerYear: number | undefined;
    employerEmployeeCount: number;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    components: Record<string, unknown>[];
    /** Org wage expense default, read once per calculate: the last rung of
     * time-driven earning line expense resolution. */
    wageExpenseAccountId: string | null;
    /**
     * The run's statutory-rate resolution per (country, year), built once and
     * shared by every stub — never a query per employee.
     */
    statutoryRatesFor: (country: string, taxYear: number) => Promise<StatutoryRateResolution>;
    /** orgs.settings.payroll.eftFallbackToCheque, read once for the run. */
    eftFallbackToCheque: boolean;
    /** orgs.settings.payroll.statutoryHolidayPay, read once for the run. */
    statHolidayPay: boolean;
    /** Authoritative statutory holiday eligibility facts by employee. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
    /** Rolled-back re-derivation of a COMMITTED run; writes no ledger rows. */
    simulate: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    /**
     * This employee's period-to-date priors from earlier runs of the same
     * period and schedule (undefined for the period's first run), resolved
     * once per run by the calculation driver.
     */
    periodPriors?: PayPeriodPriors;
    /** The org's supplemental income-tax method, resolved once per run. */
    supplementalTaxMethod?: SupplementalTaxMethod;
  },
): Promise<StubComputation> {
  const { orgId, actorId, documentId, run, emp: storedEmp, jurisdiction } = ctx;
  let emp = storedEmp;
  const employeePartyId = emp.party_id!;
  const employmentId = emp.employment_id;
  if (!employmentId) {
    throw new PayrollError(
      `payroll cannot calculate a stub for ${employeePartyId} without an HRM employment — create or resolve the worker's employment before running payroll`,
    );
  }
  const schedule = (await tx.execute<{ periods_per_year: number }>(sql`
    select periods_per_year from pay_schedules
     where org_id = ${orgId} and id = ${run.pay_schedule_id}
  `));
  const P = schedule.rows[0]!.periods_per_year;
  // Every one of these comes from the resolved context, not from re-reading
  // `emp` and defaulting. `country` decides which statutory engine runs;
  // `region` is the province or state it runs for; both were asserted against
  // the paying legal entity before this function was called.
  const { country, region: province } = jurisdiction;
  const taxYear = jurisdiction.taxYear;
  const pack = installablePackOrThrow(country);

  // ---- Live-but-unconfigured `refuse` slots stop the employee BY NAME -----
  // BEFORE any money is computed: a misconfiguration (rates on file, none
  // resolving for this employee's region and assigned filing account) must be
  // loud, because a silent zero still balances. The sentence is the readiness
  // detector's own — the run and the warning cannot disagree. Packs with no
  // rate declaration, or none declaring `refuse`, cost no query here.
  let packRefuses = false;
  try {
    packRefuses = packRates(country).slots.some((slot) => slot.whenUnconfigured === "refuse");
  } catch (error) {
    if (!(error instanceof PayrollPackError)) throw error;
  }
  if (packRefuses) {
    const resolution = await ctx.statutoryRatesFor(country, taxYear);
    // A pack-recorded waiver stands its slots down from the requirement (US
    // SUI for a recorded non-contributory account, which prices no SUI).
    // Nothing recorded waives nothing, so every other scope point keeps
    // today's gate byte-for-byte.
    const waived = pack.waivedRateSlots
      ? await pack.waivedRateSlots(tx, {
        orgId, region: province, filingAccountId: jurisdiction.filingAccountId, payDate: run.pay_date!,
        employeePartyId,
      })
      : [];
    assertConfiguredStatutoryRates(
      waived.length === 0
        ? resolution
        : { ...resolution, slots: resolution.slots.filter((slot) => !waived.includes(slot.key)) },
      { region: province, filingAccountId: jurisdiction.filingAccountId },
      emp.display_name ?? employeePartyId,
    );
  }

  const lines: Line[] = [];
  // Entitlement movements are written to the ledger only after the stub rows
  // exist, so they can carry the stub_line_id that produced them.
  const entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"] = [];
  const entitlementWarnings: EntitlementWarning[] = [];

  const payRate = await resolvePayRate(
    tx, orgId, employeePartyId, run.period_end!, run.doc_currency ?? null,
  );
  const baseComponent = ctx.need("base_pay", "earning");

  // Recorded withholding answers, read ONCE for the stub rather than once
  // per statutory pass: the deduction-protection fixpoint runs the pass up to
  // PROTECTION_MAX_PASSES times and the selected dated inputs do not change
  // between them.
  const filedCertificates = await storedTaxCertificates(tx, orgId, employeePartyId, country);
  // A certificate filed for another region — before the POST route scoped
  // filings to the employee's own region, or after the employee moved — must
  // not grant reciprocity by key membership nor drive another region's table
  // by its answers. It is ignored, and the run stops naming it: withholding
  // under the wrong region's rules is the silently-wrong class, and neither
  // the profile nor the filing can be trusted to pick the fallback.
  const { valid: storedCertificates, mismatched } = revalidateStoredCertificates({
    stored: filedCertificates,
    country,
    workRegion: province,
    residenceRegion: (emp.residence_region as string | null) || province,
  });
  if (mismatched.length > 0) {
    throw new PayrollError(
      `${emp.display_name ?? employeePartyId}: ${mismatched.map((entry) => entry.message).join(" ")}`,
    );
  }
  emp = historicalWithholdingProfile({ country, profile: emp, stored: storedCertificates, payDate: run.pay_date! });
  /**
   * One declared certificate, resolved against what is stored — the row the
   * employee filed or the documented historical inputs, else the current
   * profile column, else the
   * pack's declared default (a statutory fact, "no certificate on file is
   * withheld at single with zero allowances"), else null.
   *
   * Returns null for a certificate the pack does not declare at all, so a
   * caller asking for a form this country never issued gets an honest "no"
   * rather than an exception.
   */
  const certificateFor = (key: string): ResolvedCertificate | null => {
    let declared;
    try {
      declared = payrollCertificate(country, key);
    } catch {
      return null;
    }
    return resolveCertificate({
      certificate: declared,
      stored: storedCertificates,
      profile: emp as Record<string, unknown>,
      asOf: run.pay_date,
    });
  };

  // An off-cycle run pays only its one-off lines: no salary, no time, and no
  // recurring components (a bonus cheque does not re-take the period's benefit
  // deductions, and a retro cheque does not re-take them either — the source
  // periods already did). A bonus run's earnings are taxed on the pack's
  // non-periodic method; a retro run's treatment is the pack's DECLARATION
  // (payroll/packs.ts `retroactivePayTreatment`), never a constant here.
  const runType = (run.run_type as string) ?? "regular";
  const bonusRun = runType === "bonus";
  const retroRun = runType === "retro";
  const oneOffRun = ONE_OFF_RUN_TYPES.has(runType);

  // Is the effective rate row one the run can actually pay on? The rule lives
  // in engine/src/payroll/rate.ts and readiness asks it in SQL, so the
  // pre-flight and the run cannot disagree — which they did, before the
  // predicate had one owner: a salaried employee holding only an hourly rate
  // passed readiness green and then threw here.
  if (!oneOffRun && !payRateIsUsable(emp.pay_basis!, payRate)) {
    throw new PayrollError(payRate
      ? "salaried employee has only an hourly labor cost rate (employee scope); a salary needs a rate per week, two weeks, half-month, month or year"
      : "no labor cost rate covers this employee for the period");
  }

  await appendPeriodicEarnings(tx, {
    orgId, documentId, run, emp, employeePartyId, payRate,
    periodsPerYear: P, baseComponent, oneOffRun, need: ctx.need,
    wageExpenseAccountId: ctx.wageExpenseAccountId, lines,
  });

  // Phase 1b — retroactive pay. A retro run pays the differences that were
  // QUANTIFIED and REVIEWED before it existed: one earning line per
  // (component, project, department) bucket of every settled source period,
  // straight out of payroll_retro_allocations. Those rows are both the payment
  // and the audit evidence, so there is no second copy of the amount to drift.
  //
  // Landing HERE, before the recurring components and the entitlement phases,
  // is what puts retro earnings in gross: vacation and every other entitlement
  // plan then accrues on them exactly as the plan and the component's own
  // `vacationable` flag say, with no retro-specific rule anywhere.
  //
  // The pack decides the tax treatment. Dynamic import, like the union fringe
  // phase above, so the retro module can depend on this one.
  await appendRetroSettlementLines(tx, {
    orgId,
    documentId,
    employeePartyId,
    emp,
    country,
    retroRun,
    lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
  });

  // Recurring assigned components (allowances, RRSP match, dues, garnishees…).
  // Country-scoped components only apply to that country's employees; rows
  // with no country are shared across packs. `country` is the RESOLVED one
  // (see the destructure at the top of this function) — it used to be
  // re-derived right here as `emp.country === "US" ? "US" : "CA"`.
  // The window predicate is shared with readiness
  // (engine/src/payroll/assignment-windows.ts): an assignment ending
  // mid-period still applies, and a fixed_amount row covering only part of
  // the period pays its covered calendar-day fraction (a mid-period
  // amendment's two slices sum to exactly one period). Per_hour and
  // percent_of_gross scale with the period's own hours and earnings.
  //
  // Scoped to this stub's employment: the 0250 overlap guard keys on
  // coalesce(employment_id, employee_party_id), so a rehire's stale row under
  // the old employment and the current row under the new one may both be
  // active — and matching on the party alone would sum both into one stub, a
  // double pay. Rows stamped to another employment are that employment's to
  // pay; unstamped (pre-stamping legacy) rows still apply, since no backfill
  // ever attributed them.
  const rosterEmploymentId = emp.employment_id ?? null;
  const assigned = (await tx.execute<Record<string, unknown>>(sql`
    select a.value as override, a.effective_from, a.effective_to, c.*,
           ec.supplemental_wage_category, ec.statutory_reporting_category, ec.statutory_exemption_category
      from employee_pay_components a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
      join pay_component_earning_classifications ec
        on ec.org_id = c.org_id and ec.pay_component_id = c.id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId}
       and a.is_active and c.is_active and c.system_key is null
       and (c.country is null or c.country = ${country})
       and ${assignmentOverlapsPeriod(sql`a.effective_from`, sql`a.effective_to`, run.period_start!, run.period_end!)}

       and (${rosterEmploymentId}::uuid is null
            or a.employment_id is null
            or a.employment_id = ${rosterEmploymentId}::uuid)
     order by c.sequence
  `));

  // Phase 2 — derived earnings. Per diem for nights stayed, on-call days,
  // travel pay costed to the first job of the day, site and equipment
  // incentives: money produced by operational facts rather than typed in and
  // hand-corrected. Rules emit INPUTS, exactly like time and adjustments, so
  // the statutory pass still owns every computed output.
  //
  // Off-cycle bonus runs are skipped: they pay only their one-off lines, and a
  // month_end rule landing inside an already-paid period would settle twice.
  await appendDerivedEarningLines(tx, {
    orgId, documentId, run, employeePartyId, oneOffRun, lines,
  });

  // Phase 2 — statutory holiday pay. The jurisdiction gate itself — the
  // labour-jurisdiction refusal, the undeclared-jurisdiction holiday probe,
  // the hourly-rate derivation, and the pack-declared lookback formula —
  // lives in `statutoryHolidayLinesForStub`, which returns the earning lines.
  // Landing here, before phase 3, is what puts the day's pay in gross for
  // percent-of-gross components, vacation, union fringes, WCB and the
  // statutory pass.
  //
  // Gated on orgs.settings.payroll.statutoryHolidayPay (OFF for existing
  // tenants: the phase changes gross, so it is opted into, never inherited by
  // upgrade). Skipped on an off-cycle bonus run, which pays only its one-off
  // lines.
  await appendStatutoryHolidayEarningLines(tx, {
    orgId, documentId, employeePartyId, emp, country,
    subsidiaryId: ctx.runContext.subsidiaryId || null,
    province, run, payRate,
    statHolidayPay: ctx.statHolidayPay, oneOffRun, need: ctx.need, lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    holidayEligibility: ctx.holidayEligibility,
    occupationClass: emp.statutory_occupation_class,
    currentEarningLines: lines,
  });

  const compensationPackages = await prepareCompensationPackages(tx, {
    orgId, actorId, documentId, employeePartyId, employmentId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null, country, currency: run.doc_currency!,
    periodStart: run.period_start!, periodEnd: run.period_end!, taxYear,
    hourlyWage: payRate ? payrollHourlyWage(payRate) : null,
    payScheduleId: run.pay_schedule_id!, oneOffRun, terminationRun: runType === "termination", simulate: !!ctx.simulate,
    assignedRows: assigned.rows, allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    unionAgreementId: emp.union_agreement_id ?? null, unionClassificationId: emp.union_classification_id ?? null,
  }, lines);
  await appendCompensationPackageStage(tx, compensationPackages, 'earnings', lines);

  await applyAssignedComponentLines(tx, {
    orgId, employeePartyId, employmentId, taxYear, documentId,
    assignedRows: assigned.rows, oneOffRun, lines,
    periodStart: run.period_start!, periodEnd: run.period_end!,
  });

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  const replacedComponentIds = await applyRunLineAdjustments(tx, {
    orgId, documentId, employeePartyId, bonusRun, retroRun, country, lines,
    terminationRun: runType === "termination",
  });



  // Union fringes and dues (collective agreement).
  await appendUnionFringeLines(tx, { orgId, emp, country, lines });

  // Phases 6 and 7 — vacation pay plus every other entitlement plan (banked
  // time, sick banks, benefit recoup) through ONE engine; see
  // engine/src/payroll/entitlements.ts.
  //
  // Employee elections are effective-dated independently of tax setup.
  // One resolved rate applies to both banking and cash payment; annual days
  // remain a separate paid-leave entitlement.
  let vacationPercent: string | null = null;
  let vacationAccrued = "0";
  const terminationRun = runType === "termination";
  const plans = await entitlementPlans(orgId, tx);
  // Resolved on the plan's ENGINE BINDING, never on its operator-typed code.
  const vacationPlan = vacationPlanOf(plans);

  // Ordinary cash is snapshotted before derived vacation and bank payouts.
  // Vacationable non-cash premiums then enter the native entitlement basis;
  // deductions and employer contributions price final cash earnings afterward.
  await applyEarningPaymentKinds(tx, {
    orgId, subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!, components: ctx.components, lines,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
  });
  const regularCashLines = lines.slice();
  const recurringBenefitInput: Omit<Parameters<typeof appendRecurringBenefitLines>[1], "stage"> = {
    orgId, actorId, documentId, employmentId, employeePartyId, regularCashLines,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null, currency: run.doc_currency!, country,
    periodStart: run.period_start!, periodEnd: run.period_end!, periodsPerYear: P,
    hourlyWage: payRate ? payrollHourlyWage(payRate) : null,
    payBasis: emp.pay_basis!, payDate: run.pay_date!, taxYear,
    runType, oneOffRun, simulate: ctx.simulate, lines, entitlementMovements,
  };
  await appendRecurringBenefitLines(tx, { ...recurringBenefitInput, stage: "vacationable_earnings" });

  const vacationElection = emp.employment_id ? await resolveVacationTerms(tx, orgId, emp.employment_id, run.period_end!) : null;
  const vacationableEarnings = lines.some(line => line.kind === 'earning' && !line.accrualOnly &&
    (line.vacationable ?? true) && line.componentId !== vacationPlan?.payoutComponentId && cmp(line.amount, '0') !== 0);
  // No method or rate is needed to accrue zero on earnings explicitly excluded
  // from vacation. Any eligible earning, including a non-cash benefit, or a
  // final settlement still requires documented terms before calculation.
  if (vacationPlan && !vacationElection && (vacationableEarnings || terminationRun)) throw new PayrollError(`${emp.display_name ?? employeePartyId} has no effective vacation terms; configure their vacation method and entitlement in Benefits before calculating payroll.`);
  if (vacationElection && vacationElection.planId !== vacationPlan?.id) throw new PayrollError(`${emp.display_name ?? employeePartyId} has vacation terms assigned to a different or inactive program; activate their governing vacation program in Benefits before calculating payroll.`);
  vacationPercent = vacationElection?.percentFloor ?? (vacationElection ? vacationPlan?.accrualValue ?? null : null);
  const vacationMethod = vacationElection?.method ?? null;
  assertVacationPlanResolved({ ...emp, vacation_percent: vacationPercent, vacation_method: vacationMethod }, vacationPlan, terminationRun);
  const vacationTerms = vacationPlan && vacationElection ? await resolveServiceTier(tx, orgId, employeePartyId, run.period_end!, emp.employment_id ?? undefined) : null;
  const vacationTier = vacationPlan ? vacationTerms?.planAccrualValues.get(vacationPlan.id) : null;
  const paidLeave = vacationMethod === "paid_leave";
  const personalDays = vacationElection?.annualDaysFloor;
  const policyDays = vacationPlan ? vacationTerms?.planAnnualDays.get(vacationPlan.id) : null;
  const annualDays = personalDays != null && (policyDays == null || cmp(personalDays, policyDays) > 0) ? personalDays : policyDays;
  if (paidLeave && (annualDays == null || cmp(annualDays, "0") <= 0)) throw new PayrollError(`${emp.display_name ?? employeePartyId} has paid leave without an annual day allowance; enter their annual vacation days or configure the reached service tier.`);
  // Personal vacation terms are a floor: progression must never erase a
  // separately granted higher employee rate. Paid leave keeps salary running
  // and never creates a second percentage payment or money-bank accrual.
  if (paidLeave) vacationPercent = null;
  else if (vacationTier != null && (vacationPercent == null || cmp(vacationTier, vacationPercent) > 0)) vacationPercent = vacationTier;

  await settleTerminationBankPayouts(tx, {
    orgId, documentId, payDate: run.pay_date!, employeePartyId, employmentId,
    employeeName: emp.display_name ?? employeePartyId,
    terminationRun, plans, lines, entitlementMovements,
  });

  const payVacationInCash = vacationMethod === "pay_each_period" || terminationRun;
  await appendCashVacationPay({ vacationPercent, payVacationInCash, need: ctx.need, lines, replacedComponentIds });

  // Work-triggered alternate-day grants: a statutory day off
  // banked as hours, never cash on this stub. Under the same gate as the
  // holiday-pay phase, and persisted with every other movement below (which
  // skips simulation), so a simulated run grants nothing. Plan caps do not
  // gate the grant: a statutory entitlement is owed regardless of a cap, and
  // an auto_payout cap would pay it in cash — the outcome the statute refuses.
  if (!oneOffRun && ctx.statHolidayPay) {
    const grant = await grantRemembranceAlternateDay(tx, {
      orgId,
      runDocumentId: documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      // The SAME resolver the holiday phase uses — never a province-only
      // re-derivation, so the labour-jurisdiction override moves the grant
      // exactly the way it moves the holiday pay.
      jurisdiction: resolveEmployeeJurisdiction({
        country, province, emp, employeeName: emp.display_name ?? employeePartyId,
      }),
      subsidiaryId: ctx.runContext.subsidiaryId ?? null,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      plan: alternateDayPlanOf(plans),
    });
    if (grant) entitlementMovements.push(grant);
  }

  vacationAccrued = await applyEntitlementPlanMovements(tx, {
    orgId, documentId, employeePartyId, payDate: run.pay_date!,
    employeeName: emp.display_name ?? employeePartyId,
    employmentId: emp.employment_id ?? undefined, policyDate: run.period_end!, vacationPercent, payVacationInCash, excludeVacationAccrual: paidLeave || vacationElection === null, vacationPlan, plans,
    lines, entitlementMovements, entitlementWarnings,
  });

  // Bank drawdown runs after accrual by construction: the accrual basis above
  // never sees payout lines, and this run's accrual movements already sit in
  // entitlementMovements, so the overdraw check counts them as available.
  await applyBankDrawdown(tx, {
    orgId, documentId, payDate: run.pay_date!, employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    terminationRun, plans, lines, entitlementMovements,
  });

  await applyEarningPaymentKinds(tx, {
    orgId, subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!, components: ctx.components, lines,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
  });

  await appendRecurringBenefitLines(tx, { ...recurringBenefitInput, stage: "remaining" });
  await appendCompensationPackageStage(tx, compensationPackages, 'remaining', lines);

  await applyEarningPaymentKinds(tx, {
    orgId, subsidiaryId: ctx.runContext.subsidiaryId ?? null, currency: run.doc_currency!,
    components: ctx.components, lines, wageExpenseAccountId: ctx.wageExpenseAccountId,
  });

  await assertComponentServiceEligibility(tx, { orgId, employmentId, policyDate: run.period_end!,
    componentIds: lines.filter((line) => cmp(line.amount, "0") !== 0).map((line) => line.componentId).filter((id): id is string => id !== null) });

  // ---- Statutory lines: one helper, one declared recomputation class -------
  //
  // Every statutory amount the packs emit goes through `pushStatutory`, which
  // asks the country pack what the amount is ASSESSED ON (packs.ts) and records
  // the answer on the line. That declaration — not which pack emitted the line,
  // and not which helper pushed it — is what decides whether the
  // deduction-protection fixpoint has to re-derive the amount:
  //
  //   earnings       — computed from gross / pensionable / insurable earnings
  //                    or hours. Protection only ever changes DEDUCTIONS, so
  //                    the amount cannot move: it is pushed ONCE and every
  //                    later pass is a no-op (which is what keeps WCB's
  //                    project split, whose last job absorbs the rounding
  //                    remainder, from being allocated a second time).
  //   taxable_income — computed from income after pre-tax deductions, so a
  //                    pre-tax protected order moves it. Dropped before each
  //                    pass and re-derived from the deductions that pass takes.
  /** Earnings-assessed slots already emitted on this stub, `systemKey:kind`. */
  const emittedEarningsAssessed = new Set<string>();

  const pushStatutory = createPushStatutory({
    country, lines, emittedEarningsAssessed, need: ctx.need,
  });

  // ---- Phase 8: pack-declared earnings-assessed employer levies ----------
  // WCB/WSIB and provincial EHT for the CA pack, workers' compensation for
  // the AU pack; other packs omit this hook.
  // Both the per-employee WCB cap and the employer-level EHT exemption
  // consume COMMITTED stubs only (a draft may be abandoned; same-employee
  // races are caught by the ytd staleness arm, disjoint-roster races by the
  // employerLevyYtd arm, which the Phase-8 hook arms) — see the pack's
  // employer-levies module.
  const employerLevies = await pack.applyEmployerLevies?.({
    tx, orgId, documentId, employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    taxYear, region: province, lines, pushStatutory, payDate: run.pay_date!,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    ...(emp.historical_worker_comp_group_id ? { workerCompGroupId: emp.historical_worker_comp_group_id } : {}),
  }) ?? EMPTY_EMPLOYER_LEVY_FACTORS;

  // Statutory inputs from the line set. The pack's contributoryBases declaration
  // documents what pensionable and insurable accumulate for each jurisdiction.
  const earning = (predicate: (l: Line) => boolean) =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly && predicate(l)).map((l) => l.amount));
  const deduction = (treatment: string) =>
    sum(lines.filter((l) => l.kind === "deduction" && l.taxTreatment === treatment).map((l) => l.amount));

  const gross = earning(() => true);
  const income = earning((l) => (l.taxable ?? true) && !(l.nonPeriodic ?? false));
  const nonPeriodic = earning((l) => (l.taxable ?? true) && (l.nonPeriodic ?? false));
  const pensionable = earning((l) => l.pensionable ?? true);
  const insurable = earning((l) => l.insurable ?? true);
  const insurableNonPeriodic=earning((l)=>(l.insurable??true)&&(l.nonPeriodic??false));
  // The one-off share of the pensionable leg, for packs that annualise the
  // leg: annualising the whole leg and adding the one-off again counts it
  // periodsPerYear + 1 times. No taxable filter — a non-taxable erogazione
  // still contributes to the contributory base exactly once.
  const pensionableNonPeriodic = earning((l) => (l.pensionable ?? true) && (l.nonPeriodic ?? false));

  const statutoryHours = pack.statutoryHours?.basis === "contractual-plus-worked-extra"
    ? await resolveStubStatutoryHours(tx, { orgId, employeePartyId, payBasis: emp.pay_basis ?? null,
        periodStart: run.period_start!, subsidiaryId: ctx.runContext.subsidiaryId, periodsPerYear: P, lines })
    : undefined;

  // Per-program bases for contribution programs the pack declares. Each
  // program accumulates its OWN base from the per-earning-type applicability
  // carried on the lines — never from another program's base. Absent
  // applicability means included (the sibling flags' default-true), so a
  // pack that declares no program skips this loop and nothing changes.
  const programBases: Record<string, string> = {};
  const programNonPeriodicBases:Record<string,string>={};
  for (const program of pack.contributionPrograms ?? []) {
    programNonPeriodicBases[program.key]=earning((l)=>(l.programApplicability?.[program.key]??true)&&(l.nonPeriodic??false));
    programBases[program.key] =
      earning((l) => l.programApplicability?.[program.key] ?? true);
  }

  // Pack-declared pre-tax treatments, computed generically: each base less
  // the deduction lines carrying a treatment the pack declares as reducing
  // it. The pack's engine prices off the reduced legs (AU salary sacrifice
  // moves PAYG but leaves the superannuation guarantee leg whole); engines
  // that predate the channel read the raw legs plus `deduction()` and are
  // untouched by it. Recomputed per pass inside runStatutoryPass below, so
  // the protection fixpoint re-derives treatment-sensitive levies from the
  // deductions each pass actually takes.
  const packTreatments = pack.deductionTreatments;
  const reducedBases = () => {
    const stateBases = Object.fromEntries(
      [...new Set(packTreatments.flatMap((treatment) => treatment.reduces)
        .filter((base): base is PayrollTaxBaseKey => base.startsWith("state:")))]
        .map((base) => [base, base.endsWith(":nonPeriodic") ? nonPeriodic : income]),
    );
    return reduceTaxBases(
      lines,
      { income, nonPeriodic, pensionable, insurable, ...stateBases },
      packTreatments,
    );
  };

  // ---- Employer-aggregate levies: pack declares, generic computes --------
  // The pack's `employerAggregateLevies` for this tax year (absent on both
  // built-in packs today, so this whole block is inert until a pack declares
  // one). Each levy's stub share is assessed here, in calculation order, so
  // threshold room sequences across the run's own employees; the factors
  // merge into the statutory factors below, which is what the year-to-date
  // reads back. Annual-timing levies assess to zeros by construction.
  const aggregateFactors = await assessStubAggregateLevies({
    tx, orgId, documentId, employeePartyId, taxYear, country, region: province,
    gross, taxableGross: earning((l) => l.taxable ?? true),
    pensionable, periodsPerYear: P, subsidiaryId: ctx.runContext.subsidiaryId,
    lines, pushStatutory, payDate: run.pay_date!,
  });

  const clearIncomeAssessedLines = () => dropIncomeAssessedLines(lines);

  const bool = (value: string | null | undefined) =>
    value === "true" || (value as unknown) === true;
  let factors: Record<string, string> = {};
  let firstEarningsAssessed: EarningsAssessedLine[] | null = null;

  // Named, non-blocking advisories the statutory pass reports (a reciprocity
  // form to collect). Read once per stub like the certificates: the
  // deduction-protection fixpoint re-runs the pass, and the same advisory
  // reported twice is still one warning.
  const advisories: string[] = [];
  const noteAdvisory = (message: string): void => {
    if (!advisories.includes(message)) advisories.push(message);
  };

  // Work locations come from approved service dates, with HR period evidence
  // for untimed work. YTD source wages are read only from committed stubs.
  const workAllocations = pack.loadWorkAllocations
    ? await pack.loadWorkAllocations(tx, {
      orgId, employeePartyId, employmentId: emp.employment_id ?? null,
      periodStart: run.period_start!, periodEnd: run.period_end!, taxYear,
      documentId, currentWages: sum([income, nonPeriodic]),
    })
    : undefined;

  const runStatutoryPass = async (): Promise<void> => {
    clearIncomeAssessedLines();
    factors = await pack.computeStatutory({
      tx, orgId, documentId, employeePartyId,
      subsidiaryId: ctx.runContext.subsidiaryId,
      resolveStatutoryRates: () => ctx.statutoryRatesFor(country, taxYear),
      gross,
      statutoryHours,
      employmentId,
      employeeName: emp.display_name ?? employeePartyId,
      taxYear, country, region: province, run, emp,
      filingAccountId: jurisdiction.filingAccountId,
      periodsPerYear: P, employerEmployeeCount: ctx.employerEmployeeCount,
      workAllocations,
      income, nonPeriodic, pensionable, insurable, pensionableNonPeriodic,insurableNonPeriodic,programNonPeriodicBases,
      supplementalWageAmounts: aggregateUsSupplementalWageAmounts(lines),
      statutoryExemptionAmounts: aggregateUsStatutoryExemptionAmounts(lines),
      programBases,
      reducedBases: reducedBases(),
      deduction,
      pushStatutory, storedCertificates, certificateFor, noteAdvisory, bool,
      assertRegionSupported: (region) => assertPayrollRegionSupported(country, region),
      employerLevies,
      periodPriors: ctx.periodPriors,
      supplementalTaxMethod: ctx.supplementalTaxMethod,
    });
    // Per-program period bases merge here, not inside the pack pass: the
    // generic layer accumulates every declared program's base from the
    // lines, so the fact is stored durably on the stub under the pack's own
    // factor key. A pack that already set the key to something else collides
    // by name rather than merging two bases into one year-to-date.
    for (const program of pack.contributionPrograms ?? []) {
      const value = programBases[program.key]!;
      const key = program.stubFactorKey;
      if (key in factors && factors[key] !== value) {
        throw new PayrollError(
          `program factor "${key}" collides with the ${country} pack's statutory factors — `
          + "rename the program's stubFactorKey",
        );
      }
      factors[key] = value;
    }
    // Employer-aggregate factors merge here, not inside the pack pass: the
    // pack owns its factor namespace and the levies own theirs, and a key in
    // both would accumulate two levies into one year-to-date. Refused by
    // name rather than merged and misattributed.
    for (const [key, value] of Object.entries(aggregateFactors)) {
      if (key in factors && factors[key] !== value) {
        throw new PayrollError(
          `employer-aggregate factor "${key}" collides with the ${country} pack's statutory factors — `
          + "rename the levy's factorKey",
        );
      }
      factors[key] = value;
    }
    firstEarningsAssessed ??= earningsAssessedSnapshot(lines);
  };

  // ---- Deduction protection (protected earnings) --------------------------
  // A garnishment or support order may take only a configured share of the pay
  // it is measured against — so it is measured AFTER the statutory pass, whose
  // withholdings the base is net of.
  //
  // Two paths, and the difference is whether a protected order is pre-tax:
  //
  //   fast path  — every protected order is after-tax (an ordinary
  //                garnishment). The statutory pass is already final when
  //                protection runs, so one pass of each is exact.
  //   fixpoint   — a protected order is ALSO pre-tax (a court-ordered support
  //                payment is T4127 factor F2 AND the canonical 50%-of-net
  //                case). Capping it raises taxable income, which lowers net,
  //                which lowers the cap, so statutory and protection are run
  //                alternately until the pass's input equals its output.
  //
  // A protected order's class (a creditor garnishment, a support order)
  // adds its pack-declared exempt floor beside the configured percentage.
  const exemptFloors = await resolveProtectionExemptFloors({
    tx, orgId, subsidiaryId: ctx.runContext.subsidiaryId ?? null, country,
    classes: pack.protectionClasses ?? [], payDate: run.pay_date!, periodsPerYear: P,
    employeeLabel: emp.display_name ?? employeePartyId,
    lines: lines.filter((line) => line.kind === "deduction" && line.protectionBase && line.protectionBase !== "none"),
  });
  const { lastProtection, protectedLines, protectionRequested } =
    await settleDeductionProtection({
      lines, gross,
      employeeLabel: emp.display_name ?? employeePartyId,
      packTreatments,
      exemptFloors,
      runStatutoryPass,
    });

  // The loop has settled: hold the pack's `earnings` declarations to their
  // word before any of it reaches the stub. A levy that moved was recomputed
  // from something a deduction changed, which is exactly the failure the
  // declaration exists to make impossible.
  assertEarningsAssessedStable(
    emp.display_name ?? employeePartyId,
    firstEarningsAssessed ?? [],
    earningsAssessedSnapshot(lines),
  );

  recordProtectionShortfalls(factors, {
    lastProtection, protectedLines, protectionRequested,
  });

  // ---- Annual settlement: the pack's year-end recomputation ----------------
  //
  // On the final period of the pack's tax year the declared settlement prices
  // the committed year-to-date and pushes its adjustment lines here — after
  // the monthly pass and its protection fixpoint have settled, before net is
  // totalled — so the refund or collection flows into net pay, the stub, the
  // remittance, and the bank file through the existing rails. Any other
  // period, any non-regular run, or a pack declaring nothing settles nothing
  // and this block costs the stub nothing: ordinary months are byte-identical
  // with or without it.
  const settlementFactors = await settleAnnualSettlement({
    tx, orgId, documentId, pack, run, emp, country, region: province, taxYear,
    periodsPerYear: P, runType, employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    income, nonPeriodic, lines, need: ctx.need, components: ctx.components,
    filingAccountId: jurisdiction.filingAccountId,
    storedCertificates, certificateFor, bool, employerLevies,
  });
  if (settlementFactors !== null) {
    // The settlement owns its factor namespace and the monthly pass owns
    // its; a key in both would settle one levy's money under another's name.
    // Refused by name rather than merged and misattributed.
    assertSettlementFactorsMergeable(emp.display_name ?? employeePartyId, country, factors, settlementFactors);
    Object.assign(factors, settlementFactors);
  }

  const { net, nonCash, employerCost } = payableStubTotals(gross, lines);
  if (cmp(nonCash, "0") !== 0) factors.NON_CASH_EARNINGS = nonCash;

  // The rail is snapshotted, like the province and the claim amounts: a later
  // edit to the party or the profile must not change how a pay that has
  // already gone out is reported to have gone out.
  const paymentMethod = resolvePayrollPaymentMethod({
    profileMethod: emp.payment_method,
    partyMethod: emp.party_payment_method,
    hasApprovedBankDetails: bool(emp.has_approved_bank),
    fallbackToCheque: ctx.eftFallbackToCheque,
  }).method;

  // Department expense mapping answers after every phase has pushed its
  // lines (earnings, statutory burdens, union fringes, vacation): the
  // mapping is per component and department, so it can only resolve once
  // the lines carry both. Item-routed lines keep their item account.
  await stampDepartmentExpenseAccounts({ tx, orgId, lines, payDate: run.pay_date! });

  const stubId = await insertPayStubRow(tx, {
    orgId, actorId, documentId, employeePartyId, employmentId,
    country, filingAccountId: jurisdiction.filingAccountId, province, periodsPerYear: P, payDate: run.pay_date!, taxYear,
    federalClaim: factors.TC ?? "0", provincialClaim: factors.TCP ?? "0",
    currency: run.doc_currency!, gross, pensionable, insurable, net,
    employerCost, vacationAccrued, factors, paymentMethod,
  });
  const entitlementLineIds=await insertPayStubLineRows(tx, {
    orgId, stubId, actorId, country, payDate: run.pay_date!,
  }, lines);

  await persistEntitlementMovements(tx, {
    orgId, actorId, documentId,
    employeePartyIds: [employeePartyId],
    simulate: ctx.simulate, movements: entitlementMovements, stubLineIds: entitlementLineIds,
  });

  await persistCompensationPackageCalculations(tx, compensationPackages);

  return {
    employeePartyId, province, gross, net, employerCost,
    errors: [], warnings: entitlementWarnings, advisories,
  };
}
