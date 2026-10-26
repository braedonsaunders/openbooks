/**
 * Statutory-holiday earnings, assigned components, and run-level line adjustments.
 *
 * Kept beside run-earning-lines.ts so each operation module stays within the
 * line bound. Callers still import these functions from run-earning-lines.ts.
 */
import {
  EMPLOYER_LEVY_PROGRAMS,
  isEmployerLevyAdjustmentEvidenceCandidate,
  parseEmployerLevyAdjustmentEvidence,
} from "./run-levy-adjustment-evidence.ts";

import { applicableAssignedComponents } from "./assignment-run-applicability.ts";

import type { PayRunType } from "./run-contracts.ts";

import { type PayrollSubsidiaryScope } from "./scope.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { PayrollError } from "./error.ts";

import { add, cmp, mulDecimal, mulPercent, prorateDays, roundMoney } from "../money/money.ts";

import { canonicalDecimal } from "../money/exact-decimal.ts";

import { parseMoney, type Money } from "../money/brands.ts";

import { payrollPack } from "./packs.ts";

import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";

import { componentYearToDate as openingComponentYtd } from "./opening-balances.ts";

import { loadActiveDerivedRules } from "./derived-earnings.ts";

import { applyBasisCaps } from "./limits.ts";

import {
  type Line,
  statutoryHolidayLinesForStub,
  earningsBase,
  totalHours,
  cappableHourLines,
} from "./run-stub-records.ts";

import { resolvePayRate } from "./run-calculation-support.ts";

import { assignmentCoveredDays, assignmentCoversPeriod } from "./assignment-windows.ts";

import { assertComponentServiceEligibility } from "./entitlements-component-eligibility.ts";

import { assertBankDepositAdjustment } from "./run-bank-input.ts";

import {
  bankCashFundingSplit,
  bankCashSplitMatchesValuation,
  bankFundedValuationCents,
  isBankCashInputEvidenceCandidate,
  parseBankCashInputEvidence,
  type BankCashPayDateValuation,
} from "./run-bank-cash-evidence.ts";

import { bankSplitValuationRefusal, resolveBankPayDateValuation } from "./run-bank-valuation.ts";

import { priceRunHolidayHours } from "./run-holiday-input.ts";

import {
  isDeclaredVacationAccrualCandidate,
  isDeclaredVacationAccrualInput,
  parseDeclaredVacationAccrualEvidence,
  type DeclaredVacationAccrualInput,
} from "./run-vacation-accrual-input.ts";

/** Resolve the same classified operator inputs for derivation and settlement. */
async function runLineAdjustmentRows(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  employeePartyId: string,
): Promise<readonly Record<string, unknown>[]> {
  return await tx.execute<Record<string, unknown>>(
    sql`
    select a.id as adjustment_id, a.amount::text as adj_amount, a.hours::text as adj_hours, a.earned_from::text as adj_earned_from, a.earned_to::text as adj_earned_to, a.replace_component, a.note, r.pay_date::text as run_pay_date, d.currency as run_currency, c.*,
           ec.supplemental_wage_category, ec.statutory_reporting_category, ec.statutory_exemption_category
      from pay_run_adjustments a
      join pay_runs r on r.org_id=a.org_id and r.document_id=a.pay_run_document_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
      join pay_component_earning_classifications ec
        on ec.org_id = c.org_id and ec.pay_component_id = c.id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `,
    "objects",
  );
}

/**
 * Phase 2 mechanics: the jurisdiction-gated statutory holiday lines resolved
 * by `statutoryHolidayLinesForStub`, appended with deliberately no `hours`
 * so per-hour components and union fringes cannot be paid twice.
 */
export async function appendStatutoryHolidayEarningLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    emp: Record<string, string | null>;
    country: string;
    subsidiaryId: string | null;
    province: string;
    run: Record<string, string>;
    payRate: Awaited<ReturnType<typeof resolvePayRate>>;
    statHolidayPay: boolean;
    oneOffRun: boolean;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    lines: Line[];
    /** Caller role scope; null/undefined is unrestricted. */
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    /** Authoritative statutory holiday eligibility facts by employee. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
    /** Presented statutory occupation class; see `statutoryHolidayLinesForStub`. */
    occupationClass?: string | null;
    /** Stub earning lines so far, for the weekly cap's same-week slice. */
    currentEarningLines?: readonly {
      amount: string;
      kind: string;
      nonPeriodic?: boolean | null;
    }[];
  },
): Promise<void> {
  const {
    orgId,
    documentId,
    employeePartyId,
    emp,
    country,
    subsidiaryId,
    province,
    run,
    payRate,
    statHolidayPay,
    oneOffRun,
    need,
    lines,
    allowedSubsidiaryIds,
    holidayEligibility,
    occupationClass,
    currentEarningLines,
  } = args;
  // A period's holiday pay belongs to its regular run, like its salary; a
  // supplemental run in the same period would pay the holiday twice.
  if (!oneOffRun && statHolidayPay && run.run_type !== "supplemental") {
    // An explicit component replacement supplies this run's holiday input.
    // Resolve it before the superseded formula asks for eligibility or prior
    // earnings. The ordinary adjustment phase still validates and applies it;
    // approved unpaid obligations remain separate, governed settlements.
    const adjustments = await runLineAdjustmentRows(tx, orgId, documentId, employeePartyId);
    if (
      adjustments.some(
        (adjustment) =>
          adjustment.replace_component === true &&
          adjustment.system_key === "stat_holiday" &&
          adjustment.kind === "earning",
      )
    )
      return;
    // Class-based percent-of-pay rules (Manitoba construction s. 30) price
    // the pay's regular wages, including paid vacation and excluding
    // overtime and unpaid accruals, before holiday lines themselves land.
    const overtimeComponentId = need("overtime", "earning").id;
    const periodRegularEarnings = lines
      .filter(
        (line) =>
          line.kind === "earning" &&
          !line.accrualOnly &&
          line.componentId !== overtimeComponentId &&
          line.classification !== "overtime" &&
          line.classification !== "double_time",
      )
      .reduce((total, line) => add(total, line.amount), "0");
    const holidayLines = await statutoryHolidayLinesForStub(tx, {
      orgId,
      documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      emp,
      country,
      subsidiaryId,
      province,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      payRate,
      need,
      allowedSubsidiaryIds,
      holidayEligibility,
      periodRegularEarnings,
      occupationClass,
      currentEarningLines,
    });
    for (const line of holidayLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        // Hours the holiday engine priced from its inputs (a paid day's
        // length) travel with the line so an explicit counted-components
        // benefit basis can see them. Premium and percent-of-wages lines
        // never carry hours — they price hours the timesheet already paid —
        // so carrying cannot pay per-hour components twice. The component's
        // own flags (taxable, pensionable, insurable — all
        // true) classify the amount: holiday pay is wages.
        description: line.description,
        hours: line.hours,
        // Cross-struct boundary, re-parsed like the retro lines above.
        amount: parseMoney(line.amount),
        sequence: line.sequence,
        // Holiday pay is earned on its holiday, so dated coverage (benefit
        // elections, assignments) counts it in full whenever that day is
        // covered instead of prorating it across the period.
        ...(!line.periodWide &&
        line.holidayDate >= run.period_start! &&
        line.holidayDate <= run.period_end!
          ? { earnedFrom: line.holidayDate, earnedTo: line.holidayDate }
          : {}),
        // Current holiday wages do not withdraw previously banked alternate days.
        fundedByEntitlementBank: false,
      });
    }
  }
}

/**
 * Recurring assigned components (allowances, RRSP match, dues, garnishees…):
 * basis caps applied HERE, because the cap changes the basis a percent-of-X
 * component computes on and the resulting pre-tax amount is what the
 * statutory pass consumes as T4127 factor F / U1. One-off runs pass no rows.
 */
export async function applyAssignedComponentLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    employeePartyId: string;
    employmentId: string;
    taxYear: number;
    documentId: string;
    assignedRows: Record<string, unknown>[];
    runType: PayRunType;
    oneOffRun: boolean;
    lines: Line[];
    /** The run's period: fixed_amount rows covering only part of it prorate. */
    periodStart: string;
    periodEnd: string;
    payDate: string;
  },
): Promise<void> {
  const {
    orgId,
    employeePartyId,
    employmentId,
    taxYear,
    documentId,
    oneOffRun,
    lines,
    periodStart,
    periodEnd,
  } = args;
  const assignedRows = applicableAssignedComponents(args.assignedRows, args.runType);
  // A rate-card assignment prices operational facts; its value is not also
  // a recurring payment. Resolve ownership on the same date as derived rules,
  // including periods with no qualifying facts and therefore no derived line.
  const rateCardComponents = new Set(
    !oneOffRun && args.assignedRows.some((row) => row.kind === "earning")
      ? (await loadActiveDerivedRules(tx, orgId, periodEnd))
          .filter((rule) => rule.rateMode === "rate_card")
          .map((rule) => rule.componentId)
      : [],
  );
  for (const row of args.assignedRows) {
    if (row.run_applicability !== "standard_runs" && rateCardComponents.has(String(row.id))) {
      throw new PayrollError(
        `Payroll component ${String(row.code)} prices operational facts through a rate-card rule — replace its recurring assignment with standard applicability before recalculating.`,
      );
    }
  }
  await assertComponentServiceEligibility(tx, {
    orgId,
    employmentId,
    policyDate: periodEnd,
    componentIds: oneOffRun ? [] : assignedRows.map((row) => String(row.id)),
  });
  /**
   * Same component's amount already taken earlier in the tax year: committed
   * stub lines PLUS the mid-year opening carry-in
   * (`payroll_opening_balance_components`). One home, in
   * payroll-opening-balances.ts, because the two halves are one fact — this
   * closure previously summed only the stubs while claiming openings arrived
   * "via the opening-balance sweep the year-end module owns", a sweep that has
   * never existed. Adoption must not hand an employee a fresh 402(g) /
   * money-purchase room.
   */
  const componentYearToDate = (componentId: string): Promise<string> =>
    openingComponentYtd(tx, {
      orgId,
      employeePartyId,
      taxYear,
      componentId,
      excludeRunDocumentId: documentId,
    });

  for (const c of oneOffRun ? [] : assignedRows) {
    if (c.kind === "earning" && rateCardComponents.has(String(c.id))) continue;
    const value = String(c.override ?? c.value ?? "0");
    const capped = {
      basis: c.basis as "fixed_amount" | "per_hour" | "percent_of_gross",
      value,
      basisCapHoursPerPeriod: c.basis_cap_hours_per_period as string | null,
      basisCapAmountPerPeriod: c.basis_cap_amount_per_period as string | null,
      basisCapAmountPerYear: c.basis_cap_amount_per_year as string | null,
    };
    const hasCap =
      capped.basisCapHoursPerPeriod != null ||
      capped.basisCapAmountPerPeriod != null ||
      capped.basisCapAmountPerYear != null;
    // The cap changes the basis a percent-of-X component computes on, so it
    // must run HERE: the resulting pre-tax deduction is what the statutory
    // pass consumes as T4127 factor F / U1.
    const context = hasCap
      ? {
          lines: cappableHourLines(lines),
          yearToDate:
            capped.basisCapAmountPerYear != null ? await componentYearToDate(c.id as string) : "0",
        }
      : {};
    // All three branches close through roundMoney/mulPercent: canonical Money.
    let amount: Money;
    if (c.basis === "per_hour") {
      amount = roundMoney(
        mulDecimal(value, applyBasisCaps(capped, totalHours(lines), context)),
        2,
      ) as Money;
    } else if (c.basis === "percent_of_gross") {
      amount = mulPercent(applyBasisCaps(capped, earningsBase(lines), context), value, 2) as Money;
    } else {
      // A fixed_amount row covering only part of the period — a mid-period
      // amendment stored as old-row-ends-15th / new-row-starts-16th, or a row
      // ending with no successor — pays its covered calendar-day fraction.
      // Without this both slices of an amendment would each pay a full
      // period: a double pay. Per-hour and percent-of-gross need no window
      // math: they already scale with the period's own hours and earnings.
      // Fully-covering rows skip the math and pay the full value exactly.
      const window = {
        effectiveFrom: String(c.effective_from),
        effectiveTo: c.effective_to == null ? null : String(c.effective_to),
        periodStart,
        periodEnd,
      };
      const { coveredDays, periodDays } = assignmentCoveredDays(window);
      const periodValue = assignmentCoversPeriod(window)
        ? value
        : prorateDays(value, coveredDays, periodDays);
      amount = roundMoney(applyBasisCaps(capped, periodValue, context), 2) as Money;
    }
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: c.id as string,
      kind: c.kind as Line["kind"],
      description: c.name as string,
      amount,
      sequence: Number(c.sequence),
      // Recurring rows are earned across their coverage span (the whole
      // period when the assignment covers it): dating the earning rows lets
      // later lookbacks place them exactly. Deductions and employer rows
      // carry no earned span — nothing reads one.
      ...(c.kind === "earning"
        ? {
            earnedFrom: [periodStart, String(c.effective_from)].sort().at(-1)!,
            earnedTo:
              c.effective_to == null ? periodEnd : [periodEnd, String(c.effective_to)].sort()[0]!,
          }
        : {}),
      sourceProratedByCoverage: c.basis === "fixed_amount",
      sourceEffectiveFrom: [periodStart, String(c.effective_from)].sort().at(-1)!,
      sourceEffectiveTo: [
        periodEnd,
        c.effective_to == null ? periodEnd : String(c.effective_to),
      ].sort()[0]!,
      taxable: c.taxable as boolean,
      pensionable: c.pensionable as boolean,
      insurable: c.insurable as boolean,
      nonPeriodic: c.non_periodic as boolean,
      taxTreatment: c.tax_treatment as string,
      supplementalWageCategory: c.supplemental_wage_category as Line["supplementalWageCategory"],
      statutoryReportingCategory: c.statutory_reporting_category as string | null,
      statutoryExemptionCategory:
        c.statutory_exemption_category as Line["statutoryExemptionCategory"],
      protectionBase: c.protection_base as string,
      protectionMaxPercent: c.protection_max_percent as string | null,
      protectionPriority: Number(c.protection_priority ?? 100),
      protectionClass: (c.protection_class as string | null) ?? null,
      includeInDisposableEarnings: c.include_in_disposable_earnings as boolean,
    });
  }
}

/**
 * Run-level 'line' adjustments: one-off inputs for THIS employee in THIS
 * run. replaceComponent swaps out the component's derived lines (time,
 * salary, or recurring) before the one-off amount lands; either way the
 * statutory math below sees the adjusted inputs, never edited outputs.
 * Returned identities retain zero replacements for earning phases that run later.
 */
export async function applyRunLineAdjustments(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    bonusRun: boolean;
    retroRun: boolean;
    terminationRun: boolean;
    country: string;
    lines: Line[];
    /** Per-cheque vacation liabilities are materialized by the entitlement plan, not as free-standing lines. */
    declaredVacationAccruals?: Map<string, DeclaredVacationAccrualInput>;
  },
): Promise<ReadonlySet<string>> {
  const { orgId, documentId, employeePartyId, bonusRun, retroRun, terminationRun, country, lines } =
    args;
  const replacedComponentIds = new Set<string>();
  const adjustments = await runLineAdjustmentRows(tx, orgId, documentId, employeePartyId);
  for (const adj of adjustments) {
    if (isEmployerLevyAdjustmentEvidenceCandidate(typeof adj.note === "string" ? adj.note : null)) {
      const evidence = parseEmployerLevyAdjustmentEvidence(
        typeof adj.note === "string" ? adj.note : null,
      );
      const amount = canonicalDecimal(String(adj.adj_amount), 4);
      if (
        !evidence ||
        evidence.requestId !== String(adj.adjustment_id) ||
        country !== EMPLOYER_LEVY_PROGRAMS[evidence.programKey].country ||
        adj.country !== EMPLOYER_LEVY_PROGRAMS[evidence.programKey].country ||
        adj.kind !== "employer_contribution" ||
        adj.system_key !== EMPLOYER_LEVY_PROGRAMS[evidence.programKey].systemKey ||
        adj.is_active !== true ||
        adj.replace_component !== false ||
        adj.adj_hours != null ||
        adj.adj_earned_from != null ||
        adj.adj_earned_to != null ||
        amount === null ||
        cmp(amount, "0") <= 0 ||
        cmp(roundMoney(amount, 2), amount) !== 0
      ) {
        throw new PayrollError(
          "The saved issued levy input no longer identifies a positive employer-only amount with its audited request and active Canadian component; remove or correct the editable input before calculating.",
        );
      }
      // The Canadian levy pass combines the issued premium and native
      // assessment once while retaining their separate basis factors.
      continue;
    }
    if (isDeclaredVacationAccrualCandidate(typeof adj.note === "string" ? adj.note : null)) {
      const evidence = parseDeclaredVacationAccrualEvidence(
        typeof adj.note === "string" ? adj.note : null,
      );
      const amount = canonicalDecimal(String(adj.adj_amount), 4);
      if (
        !evidence ||
        evidence.requestId !== String(adj.adjustment_id) ||
        !amount ||
        cmp(amount, "0") <= 0 ||
        cmp(roundMoney(amount, 2), amount) !== 0 ||
        adj.kind !== "employer_contribution" ||
        adj.is_active !== true ||
        !adj.id
      ) {
        throw new PayrollError(
          "The saved declared vacation accrual lacks a positive amount, active accrual component or audited source evidence; correct it through the declared vacation accrual command before calculating.",
        );
      }
      const source: DeclaredVacationAccrualInput = {
        ...evidence,
        adjustmentId: String(adj.adjustment_id),
        componentId: String(adj.id),
        amount,
      };
      if (!isDeclaredVacationAccrualInput(source)) {
        throw new PayrollError(
          "The saved declared vacation accrual has invalid amount or source identity; correct it through the declared vacation accrual command before calculating.",
        );
      }
      if (!args.declaredVacationAccruals) {
        throw new PayrollError(
          "The declared vacation input requires the native vacation-accrual planning path; calculate it through the pay-run command.",
        );
      }
      if (args.declaredVacationAccruals.has(source.componentId)) {
        throw new PayrollError(
          "This employee has more than one declared vacation accrual on the run; remove the duplicate audited input before calculating.",
        );
      }
      args.declaredVacationAccruals.set(source.componentId, source);
      continue;
    }
    const bankInput = parseBankCashInputEvidence(typeof adj.note === "string" ? adj.note : null);
    if (
      isBankCashInputEvidenceCandidate(typeof adj.note === "string" ? adj.note : null) &&
      !bankInput
    ) {
      throw new PayrollError(
        "The saved bank payout input has invalid audited rate, reason, source or request evidence; correct it through the bank cash input command before calculating.",
      );
    }
    if (
      bankInput &&
      (terminationRun ||
        bankInput.requestId !== String(adj.adjustment_id) ||
        adj.kind !== "earning" ||
        adj.payment_kind !== "cash" ||
        adj.is_active !== true ||
        adj.unit_of_measure === "quantity" ||
        adj.replace_component !== false ||
        adj.adj_earned_from != null ||
        adj.adj_earned_to != null)
    ) {
      throw new PayrollError(
        "The saved bank cash input no longer identifies an ordinary-run cash hours line with its original request; remove it through the audited input workflow before recalculating.",
      );
    }
    // Additional income tax is a statutory input withheld through the tax line.
    if (adj.system_key === "income_tax") continue;
    if ((adj.adj_earned_from != null || adj.adj_earned_to != null) && adj.kind !== "earning") {
      throw new PayrollError(
        "The dated adjustment component is no longer an earning; review the editable run input.",
      );
    }
    if (adj.system_key === "stat_holiday") {
      if (
        adj.kind !== "earning" ||
        adj.payment_kind !== "cash" ||
        adj.replace_component !== true ||
        adj.adj_hours == null
      )
        throw new PayrollError(
          "The recorded holiday input no longer identifies a cash earning replacement with paid hours; review the editable run input.",
        );
      if (adj.adj_earned_from !== adj.adj_earned_to)
        throw new PayrollError("Record holiday hours on one date within this pay period.");
      const priced = await priceRunHolidayHours(tx, {
        orgId,
        documentId,
        employeePartyId,
        hours: String(adj.adj_hours),
        earnedOn: adj.adj_earned_from == null ? undefined : String(adj.adj_earned_from),
      });
      if (cmp(String(adj.adj_amount), priced) !== 0)
        throw new PayrollError(
          "The dated wage for recorded holiday hours has changed; update the editable holiday input and recalculate.",
        );
    }

    // A saved deposit must still settle through the current native bank;
    // retiring or rebinding a plan cannot turn it into negative worked time.
    await assertBankDepositAdjustment(tx, {
      orgId,
      componentId: String(adj.id),
      amount: String(adj.adj_amount),
      hours: adj.adj_hours == null ? null : String(adj.adj_hours),
      terminationRun,
    });
    // A queued provider valuation must not lose its non-cash representation
    // when its component is retired before this run is calculated.
    if (adj.payment_kind === "non_cash" && adj.is_active !== true) {
      throw new PayrollError(
        `non-cash payroll component "${String(adj.name)}" is inactive — re-enable this component in Payroll components, then recalculate the editable run`,
      );
    }
    if (adj.replace_component) {
      replacedComponentIds.add(String(adj.id));
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.componentId === adj.id) lines.splice(i, 1);
      }
    }
    // A funding split is captured BEFORE its lines are constructed: the
    // native pay-date wage is resolved once on this transaction (never
    // from the keyed rate, a current profile or an average), the split is
    // checked against it, and the frozen valuation rides the bank-funded
    // line so the drawdown validates evidence instead of re-resolving.
    const fundingSplit = bankInput?.outsideBankAmount
      ? bankCashFundingSplit(String(adj.adj_amount), bankInput.outsideBankAmount)
      : null;
    if (bankInput?.outsideBankAmount && !fundingSplit) {
      throw new PayrollError(
        "The saved bank payout split no longer has a positive bank-funded amount below the issued cash amount; correct it through the audited bank cash input command before calculating.",
      );
    }
    let bankValuation: BankCashPayDateValuation | undefined;
    if (fundingSplit) {
      if (adj.adj_hours == null || cmp(String(adj.adj_hours), "0") <= 0) {
        throw new PayrollError(
          "Cash paid outside the bank belongs only to a withdrawal with positive bank hours; correct it through the audited bank cash input command before calculating.",
        );
      }
      const payDate = typeof adj.run_pay_date === "string" ? adj.run_pay_date : null;
      if (!payDate)
        throw new PayrollError(
          "The saved bank payout split has no pay date to value against; correct it through the audited bank cash input command before calculating.",
        );
      bankValuation =
        (await resolveBankPayDateValuation(tx, orgId, employeePartyId, payDate, true)) ?? undefined;
      if (!bankValuation) throw bankSplitValuationRefusal(employeePartyId, payDate);
      // Monetary scalars are only comparable in one currency: the native
      // wage must be denominated in the pay-run document's currency. A
      // foreign-currency wage refuses by name — the split is never priced
      // through an invented or general-purpose FX conversion.
      const runCurrency = typeof adj.run_currency === "string" ? adj.run_currency : null;
      if (!runCurrency)
        throw new PayrollError(
          "The saved bank payout split has no pay-run currency to value against; correct it through the audited bank cash input command before calculating.",
        );
      if (bankValuation.currency !== runCurrency) {
        throw new PayrollError(
          `The audited bank payout split is valued from a ${bankValuation.currency} wage, but this pay run pays ${runCurrency}; configure a ${runCurrency} wage effective on ${payDate} and recalculate — a foreign-currency wage is never converted to price a split`,
        );
      }
      if (!bankCashSplitMatchesValuation(fundingSplit, String(adj.adj_hours), bankValuation)) {
        throw new PayrollError(
          `The audited bank payout split assigns ${fundingSplit.bankFundedAmount} to the bank, but ${String(adj.adj_hours)} hours value to ${bankFundedValuationCents(String(adj.adj_hours), bankValuation)} at the native wage effective on ${payDate}; correct the audited split through the bank cash input command before calculating.`,
        );
      }
    }
    // Operator-entered adjustment, closed through roundMoney: canonical Money.
    const amount = roundMoney(String(adj.adj_amount), 2) as Money;
    // Paid-hour inputs can have no cash value when the corresponding wages
    // are supplied separately. Retain their hours for benefits and reporting;
    // empty replacements still suppress derived pay without creating a line.
    const quantityUnits = (adj.unit_of_measure as string | null) === "quantity";
    const paidHours =
      adj.kind === "earning" &&
      !quantityUnits &&
      adj.adj_hours != null &&
      cmp(String(adj.adj_hours), "0") > 0;
    if (cmp(amount, "0") === 0 && !paidHours) continue;
    // A quantity-unit component counts trips, meals, or incentive units —
    // never hours. Its units stay on the adjustment for the audit trail, but
    // no hours reach the line: every hours basis downstream (per-hour rates,
    // benefit hours bases, insurable-hours and wage-hour reports) reads
    // lines and stub hours, so a quantity line is excluded everywhere by
    // carrying none.
    const line: Line = {
      componentId: adj.id as string,
      kind: adj.kind as Line["kind"],
      runAdjustmentId: String(adj.adjustment_id),
      earnedFrom: adj.adj_earned_from == null ? null : String(adj.adj_earned_from),
      earnedTo: adj.adj_earned_to == null ? null : String(adj.adj_earned_to),
      // Recorded holiday units are ordinary wages, not an alternate-day draw.
      fundedByEntitlementBank: adj.system_key === "stat_holiday" ? false : undefined,
      description: bankInput
        ? `${bankInput.reason} (${bankInput.sourceReference})`
        : (adj.note as string | null) || (adj.name as string),
      hours: quantityUnits || adj.adj_hours == null ? undefined : String(adj.adj_hours),
      ...(bankInput?.rate ? { rate: bankInput.rate } : {}),
      amount,
      sequence: Number(adj.sequence),
      taxable: adj.taxable as boolean,
      pensionable: adj.pensionable as boolean,
      insurable: adj.insurable as boolean,
      // On a bonus run every earning is non-periodic by definition: the
      // employee is not receiving this amount every period, so annualizing it
      // would over-withhold badly. On a RETRO run the same is true of a manual
      // top-up line, but the treatment is the pack's declaration rather than
      // this module's opinion — a jurisdiction that taxes retroactive pay as
      // ordinary period income declares so and gets it.
      nonPeriodic: bonusRun
        ? adj.kind === "earning"
        : retroRun
          ? adj.kind === "earning" &&
            payrollPack(country).retroactivePayTreatment === "non_periodic"
          : (adj.non_periodic as boolean),
      supplementalWageCategory: adj.supplemental_wage_category as Line["supplementalWageCategory"],
      statutoryReportingCategory: adj.statutory_reporting_category as string | null,
      statutoryExemptionCategory:
        adj.statutory_exemption_category as Line["statutoryExemptionCategory"],
      taxTreatment: adj.tax_treatment as string,
      // A one-off garnishment entered for a single run is still a protected
      // deduction, and still belongs to (or outside) the protected base.
      protectionBase: adj.protection_base as string,
      protectionMaxPercent: adj.protection_max_percent as string | null,
      protectionPriority: Number(adj.protection_priority ?? 100),
      protectionClass: (adj.protection_class as string | null) ?? null,
      includeInDisposableEarnings: adj.include_in_disposable_earnings as boolean,
    };
    if (fundingSplit && bankValuation) {
      // Keep the issued total on the same earning component while
      // separating bank funding from independently paid cash. The bank-
      // funded portion carries the worked hours and the frozen pay-date
      // valuation; the outside portion worked none and is not bank-funded.
      // Funding origin changes no statutory policy: the component's dated
      // treatment governs both portions at the stamp, as unsplit.
      lines.push({
        ...line,
        description: `${line.description} — bank-funded portion`,
        amount: roundMoney(fundingSplit.bankFundedAmount, 2) as Money,
        rate: undefined,
        fundedByEntitlementBank: true,
        bankCashFundingSplit: fundingSplit,
        bankCashValuation: bankValuation,
      });
      lines.push({
        ...line,
        description: `${line.description} — paid outside the bank`,
        amount: roundMoney(fundingSplit.outsideBankAmount, 2) as Money,
        // Explicit zero, never absent: a selected per-hour contribution
        // rule refuses a nonzero operator input with no hours, and this
        // portion worked none — the bank-funded line holds them all.
        hours: "0.00",
        rate: undefined,
        fundedByEntitlementBank: false,
      });
    } else {
      lines.push(line);
    }
  }
  return replacedComponentIds;
}
