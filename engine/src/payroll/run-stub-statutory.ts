import { mergeStatutoryFactors } from "./statutory-factors.ts";

import type { CaBonusIncomeReferenceSource } from "./canada/bonus-income-reference.ts";

import {
  prepareCompensationPackages,
  persistCompensationPackageCalculations,
} from "./compensation-package-payroll.ts";

import { type PayRunType } from "./run-contracts.ts";

import { db } from "../platform/db.ts";

import { aggregateUsSupplementalWageAmounts } from "./supplemental-wages.ts";

import { aggregateUsStatutoryExemptionAmounts } from "./statutory-exemptions.ts";

import { cmp, sum } from "../money/money.ts";

import { revalidateStoredCertificates } from "./certificates.ts";

import { assertPayrollRegionSupported, type PayrollTaxBaseKey } from "./packs.ts";

import { createPushStatutory } from "./push-statutory.ts";

import { assessStubAggregateLevies } from "./employer-aggregate-priors.ts";

import {
  assertSettlementFactorsMergeable,
  settleAnnualSettlement,
} from "./annual-settlement-run.ts";

import { EMPTY_EMPLOYER_LEVY_FACTORS } from "./statutory-context.ts";

import {
  assertComponentServiceEligibility,
  entitlementPlans,
  planMovementsForStub,
  type EntitlementWarning,
} from "./entitlements.ts";

import { resolvePayrollPaymentMethod } from "./payment-method.ts";

import {
  assertEarningsAssessedStable,
  dropIncomeAssessedLines,
  type EarningsAssessedLine,
} from "./limits.ts";

import { reduceTaxBases } from "./treatment-bases.ts";

import {
  type StubComputation,
  type StubComputationInput,
  resolveStubStatutoryHours,
} from "./run-calculation-support.ts";

import { createStubCertificateResolver } from "./run-stub-preflight.ts";

import {
  type Line,
  installablePackOrThrow,
  insertPayStubRow,
  insertPayStubLineRows,
  persistEntitlementMovements,
  earningsAssessedSnapshot,
  stampDepartmentExpenseAccounts,
  stampEntitlementSettlementAccounts,
  employeeHomeDepartment,
  stampEarningLineStatutoryTreatments,
} from "./run-stub-records.ts";

import { settleDeductionProtection, recordProtectionShortfalls } from "./run-protection.ts";

import { resolveProtectionExemptFloors } from "./protection-classes.ts";

import { payableStubTotals } from "./non-cash-earnings.ts";

/**
 * Statutory passes, deduction protection, and stub persistence.
 *
 * Split from calculateStub so each operation stays within the line bound.
 * The moved body is unchanged; arrays and line objects are the same references
 * the earning phases already filled.
 */
export async function completeStubStatutory(args: {
  tx: Pick<typeof db, "execute">;
  ctx: StubComputationInput;
  actorId: string;
  documentId: string;
  orgId: string;
  employeePartyId: string;
  employmentId: string;
  emp: StubComputationInput["emp"];
  P: number;
  country: StubComputationInput["jurisdiction"]["country"];
  province: StubComputationInput["jurisdiction"]["region"];
  taxYear: StubComputationInput["jurisdiction"]["taxYear"];
  pack: ReturnType<typeof installablePackOrThrow>;
  run: StubComputationInput["run"];
  runType: PayRunType;
  jurisdiction: StubComputationInput["jurisdiction"];
  workerCompGroupId: string | null;
  certificateFor: ReturnType<typeof createStubCertificateResolver>;
  lines: Line[];
  compensationPackages: Awaited<ReturnType<typeof prepareCompensationPackages>>;
  vacationAccrued: string;
  plans: Awaited<ReturnType<typeof entitlementPlans>>;
  entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  entitlementWarnings: EntitlementWarning[];
  storedCertificates: Awaited<ReturnType<typeof revalidateStoredCertificates>>["valid"];
  entitlementPolicyDate: string;
}): Promise<StubComputation> {
  const {
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
  } = args;
  await stampEarningLineStatutoryTreatments(tx, {
    orgId,
    payDate: run.pay_date!,
    workerCompGroupId,
    lines,
  });

  await assertComponentServiceEligibility(tx, {
    orgId,
    employmentId,
    policyDate: entitlementPolicyDate,
    componentIds: lines
      .filter((line) => cmp(line.amount, "0") !== 0)
      .map((line) => line.componentId)
      .filter((id): id is string => id !== null),
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
    country,
    lines,
    emittedEarningsAssessed,
    need: ctx.need,
  });

  // ---- Phase 8: pack-declared earnings-assessed employer levies ----------
  // WCB/WSIB and provincial EHT for the CA pack, workers' compensation for
  // the AU pack; other packs omit this hook.
  // Both the per-employee WCB cap and the employer-level EHT exemption
  // consume COMMITTED stubs only (a draft may be abandoned; same-employee
  // races are caught by the ytd staleness arm, disjoint-roster races by the
  // employerLevyYtd arm, which the Phase-8 hook arms) — see the pack's
  // employer-levies module.
  const employerLevies =
    (await pack.applyEmployerLevies?.({
      tx,
      orgId,
      documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      taxYear,
      region: province,
      lines,
      pushStatutory,
      payDate: run.pay_date!,
      subsidiaryId: ctx.runContext.subsidiaryId ?? null,
      workerCompGroupId,
    })) ?? EMPTY_EMPLOYER_LEVY_FACTORS;

  // Statutory inputs from the line set. The pack's contributoryBases declaration
  // documents what pensionable and insurable accumulate for each jurisdiction.
  const earning = (predicate: (l: Line) => boolean) =>
    sum(
      lines
        .filter((l) => l.kind === "earning" && !l.accrualOnly && predicate(l))
        .map((l) => l.amount),
    );
  const deduction = (treatment: string) =>
    sum(
      lines
        .filter((l) => l.kind === "deduction" && l.taxTreatment === treatment)
        .map((l) => l.amount),
    );

  const gross = earning(() => true);
  const income = earning((l) => (l.taxable ?? true) && !(l.nonPeriodic ?? false));
  const nonPeriodic = earning((l) => (l.taxable ?? true) && (l.nonPeriodic ?? false));
  const pensionable = earning((l) => l.pensionable ?? true);
  const insurable = earning((l) => l.insurable ?? true);
  const insurableNonPeriodic = earning((l) => (l.insurable ?? true) && (l.nonPeriodic ?? false));
  // The one-off share of the pensionable leg, for packs that annualise the
  // leg: annualising the whole leg and adding the one-off again counts it
  // periodsPerYear + 1 times. No taxable filter — a non-taxable erogazione
  // still contributes to the contributory base exactly once.
  const pensionableNonPeriodic = earning(
    (l) => (l.pensionable ?? true) && (l.nonPeriodic ?? false),
  );

  const statutoryHours =
    pack.statutoryHours?.basis === "contractual-plus-worked-extra"
      ? await resolveStubStatutoryHours(tx, {
          orgId,
          employeePartyId,
          payBasis: emp.pay_basis ?? null,
          periodStart: run.period_start!,
          subsidiaryId: ctx.runContext.subsidiaryId,
          periodsPerYear: P,
          lines,
        })
      : undefined;

  // Per-program bases for contribution programs the pack declares. Each
  // program accumulates its OWN base from the per-earning-type applicability
  // carried on the lines — never from another program's base. Absent
  // applicability means included (the sibling flags' default-true), so a
  // pack that declares no program skips this loop and nothing changes.
  const programBases: Record<string, string> = {};
  const programNonPeriodicBases: Record<string, string> = {};
  for (const program of pack.contributionPrograms ?? []) {
    programNonPeriodicBases[program.key] = earning(
      (l) => (l.programApplicability?.[program.key] ?? true) && (l.nonPeriodic ?? false),
    );
    programBases[program.key] = earning((l) => l.programApplicability?.[program.key] ?? true);
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
      [
        ...new Set(
          packTreatments
            .flatMap((treatment) => treatment.reduces)
            .filter((base): base is PayrollTaxBaseKey => base.startsWith("state:")),
        ),
      ].map((base) => [base, base.endsWith(":nonPeriodic") ? nonPeriodic : income]),
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
    tx,
    orgId,
    documentId,
    employeePartyId,
    taxYear,
    country,
    region: province,
    gross,
    taxableGross: earning((l) => l.taxable ?? true),
    pensionable,
    periodsPerYear: P,
    subsidiaryId: ctx.runContext.subsidiaryId,
    lines,
    pushStatutory,
    payDate: run.pay_date!,
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
        orgId,
        employeePartyId,
        employmentId: emp.employment_id ?? null,
        periodStart: run.period_start!,
        periodEnd: run.period_end!,
        taxYear,
        documentId,
        currentWages: sum([income, nonPeriodic]),
      })
    : undefined;

  const bonusIncomeReferences: CaBonusIncomeReferenceSource[] = [];
  const runStatutoryPass = async (): Promise<void> => {
    bonusIncomeReferences.length = 0;
    clearIncomeAssessedLines();
    factors = await pack.computeStatutory({
      tx,
      orgId,
      documentId,
      employeePartyId,
      subsidiaryId: ctx.runContext.subsidiaryId,
      resolveStatutoryRates: () => ctx.statutoryRatesFor(country, taxYear),
      gross,
      statutoryHours,
      employmentId,
      employeeName: emp.display_name ?? employeePartyId,
      taxYear,
      country,
      region: province,
      run,
      emp,
      filingAccountId: jurisdiction.filingAccountId,
      recordBonusIncomeReference: (source) => {
        bonusIncomeReferences.push(source);
      },
      periodsPerYear: P,
      employerEmployeeCount: ctx.employerEmployeeCount,
      workAllocations,
      income,
      nonPeriodic,
      pensionable,
      insurable,
      pensionableNonPeriodic,
      insurableNonPeriodic,
      programNonPeriodicBases,
      supplementalWageAmounts: aggregateUsSupplementalWageAmounts(lines),
      statutoryExemptionAmounts: aggregateUsStatutoryExemptionAmounts(lines),
      programBases,
      reducedBases: reducedBases(),
      deduction,
      pushStatutory,
      storedCertificates,
      certificateFor,
      noteAdvisory,
      bool,
      assertRegionSupported: (region) => assertPayrollRegionSupported(country, region),
      employerLevies,
      periodPriors: ctx.periodPriors,
      supplementalTaxMethod: ctx.supplementalTaxMethod,
    });
    mergeStatutoryFactors(
      factors,
      (pack.contributionPrograms ?? []).map((program): [string, unknown] => [
        program.stubFactorKey,
        programBases[program.key]!,
      ]),
      "program",
      country,
    );
    mergeStatutoryFactors(factors, Object.entries(aggregateFactors), "employer-aggregate", country);
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
    tx,
    orgId,
    subsidiaryId: ctx.runContext.subsidiaryId ?? null,
    country,
    classes: pack.protectionClasses ?? [],
    payDate: run.pay_date!,
    periodsPerYear: P,
    employeeLabel: emp.display_name ?? employeePartyId,
    lines: lines.filter(
      (line) => line.kind === "deduction" && line.protectionBase && line.protectionBase !== "none",
    ),
  });
  const { lastProtection, protectedLines, protectionRequested } = await settleDeductionProtection({
    lines,
    gross,
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
    lastProtection,
    protectedLines,
    protectionRequested,
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
    tx,
    orgId,
    documentId,
    pack,
    run,
    emp,
    country,
    region: province,
    taxYear,
    periodsPerYear: P,
    runType,
    employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    income,
    nonPeriodic,
    lines,
    need: ctx.need,
    components: ctx.components,
    filingAccountId: jurisdiction.filingAccountId,
    storedCertificates,
    certificateFor,
    bool,
    employerLevies,
  });
  if (settlementFactors !== null) {
    // The settlement owns its factor namespace and the monthly pass owns
    // its; a key in both would settle one levy's money under another's name.
    // Refused by name rather than merged and misattributed.
    assertSettlementFactorsMergeable(
      emp.display_name ?? employeePartyId,
      country,
      factors,
      settlementFactors,
    );
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
  const homeDepartment = await employeeHomeDepartment(tx, {
    orgId,
    employeePartyId,
    employmentId: employmentId ?? null,
    onDate: run.period_end!,
  });
  if (homeDepartment) {
    for (const line of lines) {
      if (
        line.departmentId == null &&
        (line.kind === "earning" || line.kind === "employer_contribution")
      ) {
        line.departmentId = homeDepartment;
      }
    }
  }
  await stampDepartmentExpenseAccounts({ tx, orgId, lines, payDate: run.pay_date! });
  // Bank settlements answer last: the liability they relieve or fund is the
  // accounting nature of the line, whatever department or item costed it.
  stampEntitlementSettlementAccounts({
    lines,
    plans,
    components: ctx.components,
    employeeName: emp.display_name ?? employeePartyId,
  });

  const stubId = await insertPayStubRow(tx, {
    orgId,
    actorId,
    documentId,
    employeePartyId,
    employmentId,
    country,
    filingAccountId: jurisdiction.filingAccountId,
    province,
    periodsPerYear: P,
    payDate: run.pay_date!,
    taxYear,
    federalClaim: factors.TC ?? "0",
    provincialClaim: factors.TCP ?? "0",
    currency: run.doc_currency!,
    gross,
    pensionable,
    insurable,
    net,
    employerCost,
    vacationAccrued,
    factors,
    paymentMethod,
  });
  const entitlementLineIds = await insertPayStubLineRows(
    tx,
    {
      orgId,
      stubId,
      actorId,
      country,
      payDate: run.pay_date!,
    },
    lines,
  );

  await persistEntitlementMovements(tx, {
    orgId,
    actorId,
    documentId,
    employeePartyIds: [employeePartyId],
    simulate: ctx.simulate,
    movements: entitlementMovements,
    stubLineIds: entitlementLineIds,
  });

  await persistCompensationPackageCalculations(tx, compensationPackages);
  for (const source of bonusIncomeReferences) ctx.onBonusIncomeReference?.(source);

  return {
    employeePartyId,
    province,
    gross,
    net,
    employerCost,
    errors: [],
    warnings: entitlementWarnings,
    advisories,
  };
}
