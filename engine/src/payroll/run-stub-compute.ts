import { vacationBaseIncluded } from "./component-statutory-treatment.ts";

import { historicalWithholdingProfile } from "./historical-withholding.ts";

import {
  prepareCompensationPackages,
  appendCompensationPackageStage,
} from "./compensation-package-payroll.ts";

import { ONE_OFF_RUN_TYPES, type PayRunType } from "./run-contracts.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { PayrollError } from "./error.ts";

import { cmp } from "../money/money.ts";

import { revalidateStoredCertificates } from "./certificates.ts";

import { payRateIsUsable, payrollHourlyWage } from "./rate.ts";

import {
  alternateDayPlanOf,
  entitlementPlans,
  planMovementsForStub,
  resolveVacationTerms,
  resolveServiceTier,
  vacationPlanOf,
  type EntitlementWarning,
} from "./entitlements.ts";

import { grantRemembranceAlternateDay } from "./remembrance-grants.ts";

import { assertVacationPlanResolved } from "./run-setup.ts";

import {
  type StubComputation,
  type StubComputationInput,
  storedTaxCertificates,
  resolvePayRate,
} from "./run-calculation-support.ts";

import {
  assertPackStatutoryRatesConfigured,
  createStubCertificateResolver,
} from "./run-stub-preflight.ts";

import {
  type Line,
  installablePackOrThrow,
  resolveEmployeeJurisdiction,
  stampEarningLineStatutoryTreatments,
} from "./run-stub-records.ts";

import {
  appendPeriodicEarnings,
  appendRetroSettlementLines,
  appendDerivedEarningLines,
  appendStatutoryHolidayEarningLines,
  applyAssignedComponentLines,
  applyRunLineAdjustments,
} from "./run-earning-lines.ts";

import { appendUnionFringeLines, applyEntitlementPlanMovements } from "./run-plan-earning-lines.ts";

import type { DeclaredVacationAccrualInput } from "./run-vacation-accrual-input.ts";

import { applyBankDrawdown } from "./run-bank-drawdown.ts";

import { settleTerminationBankPayouts, appendCashVacationPay } from "./run-final-payouts.ts";

import { assignmentOverlapsPeriod } from "./assignment-windows.ts";

import { applyEarningPaymentKinds } from "./non-cash-earnings.ts";

import { appendRecurringBenefitLines, recurringBenefitSource } from "./benefit-plan-inputs.ts";

import { appendApprovedHolidaySettlements } from "./holiday-settlements.ts";

import { priceLeavePayrollInputs } from "./leave-payroll-effects.ts";

import { priceAllowancePayrollInputs } from "./allowance-payroll-inputs.ts";

import { completeStubStatutory } from "./run-stub-statutory.ts";

/** Compute one employee's stub: earning phases, statutory passes and deduction protection. */
export async function calculateStub(
  tx: Pick<typeof db, "execute">,
  ctx: StubComputationInput,
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
  const schedule = await tx.execute<{ periods_per_year: number }>(
    sql`
    select periods_per_year from pay_schedules
     where org_id = ${orgId} and id = ${run.pay_schedule_id}
  `,
    "objects",
  );
  const P = schedule[0]!.periods_per_year;
  // Every one of these comes from the resolved context, not from re-reading
  // `emp` and defaulting. `country` decides which statutory engine runs;
  // `region` is the province or state it runs for; both were asserted against
  // the paying legal entity before this function was called.
  const { country, region: province } = jurisdiction;
  const taxYear = jurisdiction.taxYear;
  const pack = installablePackOrThrow(country);

  await assertPackStatutoryRatesConfigured({
    tx,
    orgId,
    pack,
    country,
    taxYear,
    province,
    jurisdiction,
    run,
    employeePartyId,
    displayName: emp.display_name ?? employeePartyId,
    statutoryRatesFor: ctx.statutoryRatesFor,
  });

  const lines: Line[] = [];
  // Entitlement movements are written to the ledger only after the stub rows
  // exist, so they can carry the stub_line_id that produced them.
  const entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"] = [];
  const entitlementWarnings: EntitlementWarning[] = [];

  const payRate = await resolvePayRate(
    tx,
    orgId,
    employeePartyId,
    run.period_end!,
    run.doc_currency ?? null,
  );
  const baseComponent = ctx.need("base_pay", "earning");
  if (typeof baseComponent.id !== "string")
    throw new PayrollError(
      "The native base-pay component identity is unavailable — correct Payroll Setup before calculating",
    );

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
  emp = historicalWithholdingProfile({
    country,
    profile: emp,
    stored: storedCertificates,
    payDate: run.pay_date!,
  });
  const workerCompGroupId = emp.resolved_worker_comp_group_id ?? null;
  const certificateFor = createStubCertificateResolver({
    country,
    storedCertificates,
    emp,
    payDate: run.pay_date,
  });

  // An off-cycle run pays only its one-off lines: no salary, no time, and no
  // recurring components (a bonus cheque does not re-take the period's benefit
  // deductions, and a retro cheque does not re-take them either — the source
  // periods already did). A bonus run's earnings are taxed on the pack's
  // non-periodic method; a retro run's treatment is the pack's DECLARATION
  // (payroll/packs.ts `retroactivePayTreatment`), never a constant here.
  const runType = (run.run_type as PayRunType) ?? "regular";
  const bonusRun = runType === "bonus";
  const retroRun = runType === "retro";
  const oneOffRun = ONE_OFF_RUN_TYPES.has(runType);

  // Is the effective rate row one the run can actually pay on? The rule lives
  // in engine/src/payroll/rate.ts and readiness asks it in SQL, so the
  // pre-flight and the run cannot disagree — which they did, before the
  // predicate had one owner: a salaried employee holding only an hourly rate
  // passed readiness green and then threw here.
  if (!oneOffRun && !payRateIsUsable(emp.pay_basis!, payRate)) {
    throw new PayrollError(
      payRate
        ? "salaried employee has only an hourly labor cost rate (employee scope); a salary needs a rate per week, two weeks, half-month, month or year"
        : "no labor cost rate covers this employee for the period",
    );
  }

  await appendPeriodicEarnings(tx, {
    orgId,
    documentId,
    run,
    emp,
    employeePartyId,
    payRate,
    periodsPerYear: P,
    baseComponent,
    oneOffRun,
    need: ctx.need,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
    lines,
  });

  const allowanceEarnings = priceAllowancePayrollInputs(
    ctx.allowancePayrollInputs ?? [],
    run.doc_currency!,
  );
  for (const [index, allowance] of allowanceEarnings.entries()) {
    const component = ctx.components.find((candidate) => candidate.id === allowance.payComponentId);
    if (!component || component.kind !== "earning" || typeof component.name !== "string") {
      throw new PayrollError(
        `approved allowance input ${allowance.id} has no active earning component in this payroll calculation — choose an active earning component on its policy, then void, recompute and approve the entry`,
      );
    }
    const sequence = Math.max(0, ...lines.map((line) => line.sequence)) + 1;
    lines.push({
      componentId: allowance.payComponentId,
      kind: "earning",
      description: `${component.name} · ${allowance.coverageDate}`,
      amount: allowance.amount,
      earnedFrom: allowance.coverageDate,
      earnedTo: allowance.coverageDate,
      sequence: sequence + index,
    });
  }

  const leaveInputs = ctx.leavePayrollInputs ?? [];
  const leaveEffects = priceLeavePayrollInputs(
    leaveInputs,
    leaveInputs.some((input) => input.kind === "payout") && payRate
      ? payrollHourlyWage(payRate)
      : null,
  );
  for (const [index, payout] of leaveEffects.payouts.entries()) {
    const sequence = Math.max(0, ...lines.map((line) => line.sequence)) + 1;
    lines.push({
      componentId: baseComponent.id as string,
      kind: "earning",
      description: "Leave payout",
      hours: payout.hours,
      amount: payout.amount,
      earnedFrom: payout.absenceDate,
      earnedTo: payout.absenceDate,
      sequence: sequence + index,
    });
  }
  for (const { planId, hours } of leaveEffects.bankIns) {
    entitlementMovements.push({
      planId,
      employeePartyId,
      movementDate: run.pay_date!,
      amount: hours,
      hours,
      kind: "bank_in",
      componentId: null,
      note: "Approved leave bank-in",
    });
  }

  // Phase 1b — retroactive pay. A retro run pays the differences that were
  // QUANTIFIED and REVIEWED before it existed: one earning line per
  // (component, project, department) bucket of every settled source period,
  // straight out of payroll_retro_allocations. Those rows are both the payment
  // and the audit evidence, so there is no second copy of the amount to drift.
  //
  // Landing HERE, before the recurring components and the entitlement phases,
  // is what puts retro earnings in gross: vacation and every other entitlement
  // plan then accrues on them under the component treatment resolved at this
  // pay date, with no retro-specific rule.
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
  // double pay. A party-wide assignment applies to every employment; an
  // employment-scoped assignment applies only to its recorded employment.
  const rosterEmploymentId = emp.employment_id;
  if (!rosterEmploymentId) {
    throw new PayrollError(
      `${emp.display_name ?? employeePartyId}: the payroll employment identity is unavailable — select the employee's native employment before calculating`,
    );
  }
  const assigned = await tx.execute<Record<string, unknown>>(
    sql`
    select a.value as override, a.effective_from, a.effective_to, a.run_applicability, c.*,
           ec.supplemental_wage_category, ec.statutory_reporting_category, ec.statutory_exemption_category
      from employee_pay_components a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
      join pay_component_earning_classifications ec
        on ec.org_id = c.org_id and ec.pay_component_id = c.id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId}
       and a.is_active and c.is_active and c.system_key is null
       and (c.country is null or c.country = ${country})
       and ${assignmentOverlapsPeriod(sql`a.effective_from`, sql`a.effective_to`, run.period_start!, run.period_end!)}

       and (a.employment_id is null
            or a.employment_id = ${rosterEmploymentId}::uuid)
     order by c.sequence
  `,
    "objects",
  );

  // Phase 2 — derived earnings. Per diem for nights stayed, on-call days,
  // travel pay costed to the first job of the day, site and equipment
  // incentives: money produced by operational facts rather than typed in and
  // hand-corrected. Rules emit INPUTS, exactly like time and adjustments, so
  // the statutory pass still owns every computed output.
  //
  // Off-cycle bonus runs are skipped: they pay only their one-off lines, and a
  // month_end rule landing inside an already-paid period would settle twice.
  await appendDerivedEarningLines(tx, {
    orgId,
    documentId,
    run,
    employeePartyId,
    oneOffRun,
    lines,
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
    orgId,
    documentId,
    employeePartyId,
    emp,
    country,
    subsidiaryId: ctx.runContext.subsidiaryId || null,
    province,
    run,
    payRate,
    statHolidayPay: ctx.statHolidayPay,
    oneOffRun,
    need: ctx.need,
    lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    holidayEligibility: ctx.holidayEligibility,
    occupationClass: emp.statutory_occupation_class,
    currentEarningLines: lines,
  });
  await appendApprovedHolidaySettlements(tx, {
    orgId,
    actorId,
    documentId,
    employeePartyId,
    employmentId,
    subsidiaryId: ctx.runContext.subsidiaryId,
    country,
    province,
    labourJurisdiction: emp.labour_jurisdiction ?? null,
    payDate: run.pay_date!,
    runType,
    statHolidayPay: ctx.statHolidayPay,
    simulate: ctx.simulate,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    need: ctx.need,
    lines,
  });

  const compensationPackages = await prepareCompensationPackages(
    tx,
    {
      orgId,
      actorId,
      documentId,
      employeePartyId,
      employmentId,
      subsidiaryId: ctx.runContext.subsidiaryId ?? null,
      country,
      currency: run.doc_currency!,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      payDate: run.pay_date!,
      taxYear,
      hourlyWage: payRate ? payrollHourlyWage(payRate) : null,
      payScheduleId: run.pay_schedule_id!,
      runType,
      oneOffRun,
      terminationRun: runType === "termination",
      simulate: !!ctx.simulate,
      assignedRows: assigned,
      allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
      unionAgreementId: emp.union_agreement_id ?? null,
      unionClassificationId: emp.union_classification_id ?? null,
    },
    lines,
  );
  await appendCompensationPackageStage(tx, compensationPackages, "earnings", lines);

  await applyAssignedComponentLines(tx, {
    orgId,
    employeePartyId,
    employmentId,
    taxYear,
    documentId,
    assignedRows: assigned,
    runType,
    oneOffRun,
    lines,
    periodStart: run.period_start!,
    periodEnd: run.period_end!,
    payDate: run.pay_date!,
  });

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  const declaredVacationAccruals = new Map<string, DeclaredVacationAccrualInput>();
  const replacedComponentIds = await applyRunLineAdjustments(tx, {
    orgId,
    documentId,
    employeePartyId,
    bonusRun,
    retroRun,
    country,
    lines,
    terminationRun: runType === "termination",
    declaredVacationAccruals,
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
  // Final settlement uses the entitlement terms at employment's end.
  // A later payment date cannot grant additional service or replace those terms.
  const entitlementPolicyDate =
    terminationRun && emp.terminated_on && emp.terminated_on < run.period_end!
      ? emp.terminated_on
      : run.period_end!;
  const plans = await entitlementPlans(orgId, tx);
  // Resolved on the plan's ENGINE BINDING, never on its operator-typed code.
  const vacationPlan = vacationPlanOf(plans);

  // Ordinary cash is snapshotted before derived vacation and bank payouts.
  // Vacationable non-cash premiums then enter the native entitlement basis;
  // deductions and employer contributions price final cash earnings afterward.
  await applyEarningPaymentKinds(tx, {
    orgId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!,
    components: ctx.components,
    lines,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
  });
  const regularCashLines = lines.slice();
  const recurringSource = await recurringBenefitSource(tx, {
    orgId,
    employmentId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    periodStart: run.period_start!,
    periodEnd: run.period_end!,
    payDate: run.pay_date!,
    documentId,
  });
  const recurringBenefitInput: Omit<Parameters<typeof appendRecurringBenefitLines>[1], "stage"> = {
    source: recurringSource,
    basePayComponentId: baseComponent.id,
    orgId,
    actorId,
    documentId,
    employmentId,
    employeePartyId,
    workerCompGroupId,
    regularCashLines,
    replacedComponentIds,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!,
    country,
    periodStart: run.period_start!,
    periodEnd: run.period_end!,
    periodsPerYear: P,
    hourlyWage: payRate ? payrollHourlyWage(payRate) : null,
    payBasis: emp.pay_basis!,
    payDate: run.pay_date!,
    taxYear,
    runType,
    oneOffRun,
    simulate: ctx.simulate,
    lines,
    entitlementMovements,
  };
  await appendRecurringBenefitLines(tx, {
    ...recurringBenefitInput,
    stage: "vacationable_earnings",
  });

  await stampEarningLineStatutoryTreatments(tx, {
    orgId,
    payDate: run.pay_date!,
    workerCompGroupId,
    lines,
  });

  const vacationElection = emp.employment_id
    ? await resolveVacationTerms(tx, orgId, emp.employment_id, entitlementPolicyDate)
    : null;
  const vacationableEarnings = lines.some(
    (line) =>
      line.kind === "earning" &&
      !line.accrualOnly &&
      vacationBaseIncluded(line) &&
      line.componentId !== vacationPlan?.payoutComponentId &&
      cmp(line.amount, "0") !== 0,
  );
  // No method or rate is needed to accrue zero on earnings explicitly excluded
  // from vacation. Any eligible earning, including a non-cash benefit, or a
  // final settlement still requires documented terms before calculation.
  if (vacationPlan && !vacationElection && (vacationableEarnings || terminationRun))
    throw new PayrollError(
      `${emp.display_name ?? employeePartyId} has no effective vacation terms; configure their vacation method and entitlement in Benefits before calculating payroll.`,
    );
  if (vacationElection && vacationElection.planId !== vacationPlan?.id)
    throw new PayrollError(
      `${emp.display_name ?? employeePartyId} has vacation terms assigned to a different or inactive program; activate their governing vacation program in Benefits before calculating payroll.`,
    );
  vacationPercent =
    vacationElection?.percentFloor ??
    (vacationElection ? (vacationPlan?.accrualValue ?? null) : null);
  const vacationMethod = vacationElection?.method ?? null;
  assertVacationPlanResolved(
    { ...emp, vacation_percent: vacationPercent, vacation_method: vacationMethod },
    vacationPlan,
    terminationRun,
  );
  const vacationTerms =
    vacationPlan && vacationElection
      ? await resolveServiceTier(
          tx,
          orgId,
          employeePartyId,
          entitlementPolicyDate,
          emp.employment_id ?? undefined,
        )
      : null;
  const vacationTier = vacationPlan ? vacationTerms?.planAccrualValues.get(vacationPlan.id) : null;
  const paidLeave = vacationMethod === "paid_leave";
  const personalDays = vacationElection?.annualDaysFloor;
  const policyDays = vacationPlan ? vacationTerms?.planAnnualDays.get(vacationPlan.id) : null;
  const annualDays =
    personalDays != null && (policyDays == null || cmp(personalDays, policyDays) > 0)
      ? personalDays
      : policyDays;
  if (paidLeave && (annualDays == null || cmp(annualDays, "0") <= 0))
    throw new PayrollError(
      `${emp.display_name ?? employeePartyId} has paid leave without an annual day allowance; enter their annual vacation days or configure the reached service tier.`,
    );
  // Personal vacation terms are a floor: progression must never erase a
  // separately granted higher employee rate. Paid leave keeps salary running
  // and never creates a second percentage payment or money-bank accrual.
  if (paidLeave) vacationPercent = null;
  else if (
    vacationTier != null &&
    (vacationPercent == null || cmp(vacationTier, vacationPercent) > 0)
  )
    vacationPercent = vacationTier;

  await settleTerminationBankPayouts(tx, {
    orgId,
    documentId,
    payDate: run.pay_date!,
    payCurrency: run.doc_currency!,
    employeePartyId,
    employmentId,
    employeeName: emp.display_name ?? employeePartyId,
    terminationRun,
    plans,
    lines,
    entitlementMovements,
  });

  await stampEarningLineStatutoryTreatments(tx, {
    orgId,
    payDate: run.pay_date!,
    workerCompGroupId,
    lines,
  });

  const payVacationInCash = vacationMethod === "pay_each_period" || terminationRun;
  await appendCashVacationPay({
    vacationPercent,
    payVacationInCash,
    need: ctx.need,
    lines,
    replacedComponentIds,
    vacationPayoutComponentId: vacationPlan?.payoutComponentId,
  });

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
        country,
        province,
        emp,
        employeeName: emp.display_name ?? employeePartyId,
      }),
      subsidiaryId: ctx.runContext.subsidiaryId ?? null,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      plan: alternateDayPlanOf(plans),
    });
    if (grant) entitlementMovements.push(grant);
  }

  await stampEarningLineStatutoryTreatments(tx, {
    orgId,
    payDate: run.pay_date!,
    workerCompGroupId,
    lines,
  });

  vacationAccrued = await applyEntitlementPlanMovements(tx, {
    orgId,
    documentId,
    employeePartyId,
    payDate: run.pay_date!,
    payCurrency: run.doc_currency!,
    employeeName: emp.display_name ?? employeePartyId,
    employmentId: emp.employment_id ?? undefined,
    policyDate: entitlementPolicyDate,
    vacationPercent,
    payVacationInCash,
    excludeVacationAccrual: paidLeave || vacationElection === null,
    vacationPlan,
    plans,
    lines,
    entitlementMovements,
    entitlementWarnings,
    declaredVacationAccruals,
  });

  // Bank drawdown runs after accrual by construction: the accrual basis above
  // never sees payout lines, and this run's accrual movements already sit in
  // entitlementMovements, so the overdraw check counts them as available.
  await applyBankDrawdown(tx, {
    orgId,
    documentId,
    payDate: run.pay_date!,
    employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    terminationRun,
    plans,
    lines,
    entitlementMovements,
  });

  await applyEarningPaymentKinds(tx, {
    orgId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!,
    components: ctx.components,
    lines,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
  });

  await appendRecurringBenefitLines(tx, { ...recurringBenefitInput, stage: "remaining" });
  await appendCompensationPackageStage(tx, compensationPackages, "remaining", lines);

  await applyEarningPaymentKinds(tx, {
    orgId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    currency: run.doc_currency!,
    components: ctx.components,
    lines,
    wageExpenseAccountId: ctx.wageExpenseAccountId,
  });

  return completeStubStatutory({
    tx,
    ctx,
    actorId,
    documentId,
    orgId,
    employeePartyId,
    employmentId,
    emp,
    P,
    country,
    province,
    taxYear,
    pack,
    run,
    runType,
    jurisdiction,
    workerCompGroupId,
    certificateFor,
    lines,
    compensationPackages,
    vacationAccrued,
    plans,
    entitlementMovements,
    entitlementWarnings,
    storedCertificates,
    entitlementPolicyDate,
  });
}
