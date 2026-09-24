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
import { add, cmp, neg, sum } from "../money/money.ts";
import { payrollCertificate, resolveCertificate, revalidateStoredCertificates, type ResolvedCertificate } from "./certificates.ts";
import { packRates, PayrollPackError, assertPayrollRegionSupported, type EmployeePayrollContext, type PayrollRunContext } from "./packs.ts";
import { assertConfiguredStatutoryRates, type StatutoryRateResolution } from "./statutory-rates.ts";
import { createPushStatutory } from "./push-statutory.ts";
import { assessStubAggregateLevies } from "./employer-aggregate-priors.ts";
import { assertSettlementFactorsMergeable, settleAnnualSettlement } from "./annual-settlement-run.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "./statutory-context.ts";
import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";
import { payRateIsUsable } from "./rate.ts";
import { entitlementPlans, planMovementsForStub, vacationPlanOf, type EntitlementWarning } from "./entitlements.ts";
import { resolvePayrollPaymentMethod } from "./payment-method.ts";
import { assertEarningsAssessedStable, dropIncomeAssessedLines, type EarningsAssessedLine } from "./limits.ts";
import { reduceTaxBases } from "./treatment-bases.ts";
import { assertVacationPlanResolved } from "./run-setup.ts";
import { type StubComputation, storedTaxCertificates, resolvePayRate } from "./run-calculation-support.ts";
import { type Line, installablePackOrThrow, insertPayStubRow, insertPayStubLineRows, persistEntitlementMovements, earningsAssessedSnapshot } from "./run-stub-records.ts";
import { appendPeriodicEarnings, appendRetroSettlementLines, appendDerivedEarningLines, appendStatutoryHolidayEarningLines, applyAssignedComponentLines, applyRunLineAdjustments, appendUnionFringeLines, settleTerminationBankPayouts, appendCashVacationPay, applyEntitlementPlanMovements } from "./run-earning-lines.ts";
import { assignmentOverlapsPeriod } from "./assignment-windows.ts";
import { settleDeductionProtection, recordProtectionShortfalls } from "./run-protection.ts";
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
  },
): Promise<StubComputation> {
  const { orgId, actorId, documentId, run, emp, jurisdiction } = ctx;
  const employeePartyId = emp.party_id!;
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
    assertConfiguredStatutoryRates(
      await ctx.statutoryRatesFor(country, taxYear),
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

  // The employee's tax certificates, read ONCE for the stub rather than once
  // per statutory pass: the deduction-protection fixpoint runs the pass up to
  // PROTECTION_MAX_PASSES times and an employee's signed forms do not change
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
  /**
   * One declared certificate, resolved against what is stored — the row the
   * employee signed, else the profile column that predates the model, else the
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
      ? "salaried employee has no annual labor cost rate (employee scope)"
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
    select a.value as override, a.effective_from, a.effective_to, c.*
      from employee_pay_components a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
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
    orgId, documentId, employeePartyId, emp, country, province, run, payRate,
    statHolidayPay: ctx.statHolidayPay, oneOffRun, need: ctx.need, lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    holidayEligibility: ctx.holidayEligibility,
  });

  await applyAssignedComponentLines(tx, {
    orgId, employeePartyId, taxYear, documentId,
    assignedRows: assigned.rows, oneOffRun, lines,
    periodStart: run.period_start!, periodEnd: run.period_end!,
  });

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  await applyRunLineAdjustments(tx, {
    orgId, documentId, employeePartyId, bonusRun, retroRun, country, lines,
  });

  // Union fringes and dues (collective agreement).
  await appendUnionFringeLines(tx, { orgId, emp, country, lines });

  // Phases 6 and 7 — vacation pay plus every other entitlement plan (banked
  // time, sick banks, benefit recoup) through ONE engine; see
  // engine/src/payroll/entitlements.ts.
  //
  // The employee's vacation_percent stays on the payroll profile, its one
  // home; it is handed to the Vacation plan as that employee's rate. A reached
  // service tier (5 years → 6%) overrides it. `pay_each_period` and a final pay
  // still settle in cash rather than banking, so the accrue-vs-pay decision is
  // unchanged from the operator's point of view.
  const vacationPercent = emp.vacation_percent!;
  let vacationAccrued = "0";
  const terminationRun = runType === "termination";
  const plans = await entitlementPlans(orgId, tx);
  // Resolved on the plan's ENGINE BINDING, never on its operator-typed code.
  const vacationPlan = vacationPlanOf(plans);
  assertVacationPlanResolved(emp, vacationPlan, terminationRun);

  await settleTerminationBankPayouts(tx, {
    orgId, documentId, payDate: run.pay_date!, employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    terminationRun, plans, lines, entitlementMovements,
  });

  const payVacationInCash = emp.vacation_method === "pay_each_period" || terminationRun;
  await appendCashVacationPay({ vacationPercent, payVacationInCash, need: ctx.need, lines });

  vacationAccrued = await applyEntitlementPlanMovements(tx, {
    orgId, documentId, employeePartyId, payDate: run.pay_date!,
    employeeName: emp.display_name ?? employeePartyId,
    vacationPercent, payVacationInCash, vacationPlan, plans,
    lines, entitlementMovements, entitlementWarnings,
  });

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
  // The one-off share of the pensionable leg, for packs that annualise the
  // leg: annualising the whole leg and adding the one-off again counts it
  // periodsPerYear + 1 times. No taxable filter — a non-taxable erogazione
  // still contributes to the contributory base exactly once.
  const pensionableNonPeriodic = earning((l) => (l.pensionable ?? true) && (l.nonPeriodic ?? false));

  // Per-program bases for contribution programs the pack declares. Each
  // program accumulates its OWN base from the per-earning-type applicability
  // carried on the lines — never from another program's base. Absent
  // applicability means included (the sibling flags' default-true), so a
  // pack that declares no program skips this loop and nothing changes.
  const programBases: Record<string, string> = {};
  for (const program of pack.contributionPrograms ?? []) {
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
  const reducedBases = () => reduceTaxBases(
    lines,
    { income, nonPeriodic, pensionable, insurable },
    packTreatments,
  );

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

  const runStatutoryPass = async (): Promise<void> => {
    clearIncomeAssessedLines();
    factors = await pack.computeStatutory({
      tx, orgId, documentId, employeePartyId,
      subsidiaryId: ctx.runContext.subsidiaryId,
      employeeName: emp.display_name ?? employeePartyId,
      taxYear, country, region: province, run, emp,
      filingAccountId: jurisdiction.filingAccountId,
      periodsPerYear: P, employerEmployeeCount: ctx.employerEmployeeCount,
      income, nonPeriodic, pensionable, insurable, pensionableNonPeriodic,
      programBases,
      reducedBases: reducedBases(),
      deduction,
      pushStatutory, storedCertificates, certificateFor, noteAdvisory, bool,
      assertRegionSupported: (region) => assertPayrollRegionSupported(country, region),
      employerLevies,
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
  const { lastProtection, protectedLines, protectionRequested } =
    await settleDeductionProtection({
      lines, gross,
      employeeLabel: emp.display_name ?? employeePartyId,
      packTreatments,
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

  const deductions = sum(lines.filter((l) => l.kind === "deduction").map((l) => l.amount));
  // Refundable employment credits (a `credit` line) are money the employer
  // pays the employee through payroll: they INCREASE net pay. Employer cost
  // below deliberately excludes them — the employer reclaims the credit from
  // the tax authority (F24 compensation for IT), so the P&L cost is nil and
  // the GL projection debits the reclaimed liability instead (see payRunGlLegs).
  const credits = sum(lines.filter((l) => l.kind === "credit").map((l) => l.amount));
  const net = add(add(gross, neg(deductions)), credits);
  if (cmp(net, "0") < 0) throw new PayrollError(`net pay is negative (${net})`);
  const employerCost = sum(
    lines.filter((l) => l.kind === "employer_contribution").map((l) => l.amount),
  );

  // The rail is snapshotted, like the province and the claim amounts: a later
  // edit to the party or the profile must not change how a pay that has
  // already gone out is reported to have gone out.
  const paymentMethod = resolvePayrollPaymentMethod({
    profileMethod: emp.payment_method,
    partyMethod: emp.party_payment_method,
    hasApprovedBankDetails: bool(emp.has_approved_bank),
    fallbackToCheque: ctx.eftFallbackToCheque,
  }).method;

  const stubId = await insertPayStubRow(tx, {
    orgId, actorId, documentId, employeePartyId,
    country, filingAccountId: jurisdiction.filingAccountId, province, periodsPerYear: P, payDate: run.pay_date!, taxYear,
    federalClaim: factors.TC ?? "0", provincialClaim: factors.TCP ?? "0",
    currency: run.doc_currency!, gross, pensionable, insurable, net,
    employerCost, vacationAccrued, factors, paymentMethod,
  });
  await insertPayStubLineRows(tx, { orgId, stubId, actorId }, lines);

  await persistEntitlementMovements(tx, {
    orgId, actorId, documentId,
    employeePartyIds: [employeePartyId],
    simulate: ctx.simulate, movements: entitlementMovements,
  });

  return {
    employeePartyId, province, gross, net, employerCost,
    errors: [], warnings: entitlementWarnings, advisories,
  };
}
