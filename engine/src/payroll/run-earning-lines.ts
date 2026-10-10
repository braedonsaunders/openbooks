import { applicableAssignedComponents } from './assignment-run-applicability.ts';
import type { PayRunType } from './run-contracts.ts';
/**
 * Stub earning-line phases appended per employee during calculation.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { add, cmp, mulDecimal, mulPercent, prorateDays, roundMoney } from "../money/money.ts";
import { negMoney, parseMoney, type Money } from "../money/brands.ts";
import { payrollPack } from "./packs.ts";
import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";
import { componentYearToDate as openingComponentYtd } from "./opening-balances.ts";
import { loadActiveDerivedRules, resolveDerivedEarnings } from "./derived-earnings.ts";
import { entitlementMoneyValue, planMovementsForStub, type EntitlementPlan, type EntitlementWarning } from "./entitlements.ts";
import { applyBasisCaps } from "./limits.ts";
import { allocateProportionally } from "./run-allocation.ts";
import { priceDatedWageEntries } from "./wage-rounding.ts";
import { type Line, programApplicabilityFromExclusions, statutoryHolidayLinesForStub, earningsBase, totalHours, earningJobBuckets, cappableHourLines, resolveEarningExpenseAccount } from "./run-stub-records.ts";
import { resolvePayRate } from "./run-calculation-support.ts";
import { payrollHourlyWage, salaryPeriodPay } from "./rate.ts";
import { assignmentCoveredDays, assignmentCoversPeriod } from "./assignment-windows.ts";
import { assertComponentServiceEligibility } from "./entitlements-component-eligibility.ts";
import { assertBankDepositAdjustment } from "./run-bank-input.ts";
import { priceRunHolidayHours } from "./run-holiday-input.ts";
export async function appendPeriodicEarnings(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string;
    run: Record<string, string>; emp: Record<string, string | null>;
    employeePartyId: string;
    payRate: Awaited<ReturnType<typeof resolvePayRate>>;
    periodsPerYear: number;
    baseComponent: Record<string, unknown>;
    oneOffRun: boolean;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    /** Org wage expense default: the last rung of line expense resolution. */
    wageExpenseAccountId: string | null;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId, documentId, run, emp, employeePartyId, payRate,
    periodsPerYear: P, baseComponent, oneOffRun, need, wageExpenseAccountId, lines,
  } = args;
  if (oneOffRun) {
    // no periodic earnings — adjustments (bonus) or settled retro differences
    // (retro, immediately below) carry the whole cheque
  } else if (emp.pay_basis === "salary" && run.run_type === "supplemental") {
    // The period's salary is paid once, by its regular run; a supplemental run
    // in the same period pays only its other inputs.
  } else if (emp.pay_basis === "salary") {
    // Exact annual amount ÷ periods, rounded once (see salaryPeriodPay).
    const periodSalary = salaryPeriodPay(payRate!, P);
    lines.push({
      componentId: baseComponent.id as string, kind: "earning", description: "Salary",
      amount: periodSalary, sequence: 10,
      programApplicability: programApplicabilityFromExclusions(baseComponent.program_exclusions),
    });
  } else {
    // Exact annual amount ÷ annual hours (see payrollHourlyWage): the
    // quotient is multiplied by every hour on every stub.
    const hourlyWage = payrollHourlyWage(payRate!);
    const time = (await tx.execute<{
        id: string; hours: string; worked_on: string; project_id: string | null; department_id: string | null;
        time_type_id: string | null; item_id: string | null;
        classification: string; multiplier: string; type_name: string;
        item_name: string | null; item_account_id: string | null;
        item_account_number: string | null; item_account_name: string | null;
      }>(sql`
      select te.id, te.hours, te.worked_on, te.project_id, te.department_id, te.time_type_id, te.item_id,
             coalesce(tt.classification, 'regular') as classification,
             coalesce(tt.cost_multiplier, 1) as multiplier, coalesce(tt.name, 'Regular') as type_name,
             i.name as item_name, i.payroll_expense_account_id as item_account_id,
             a.number as item_account_number, a.name as item_account_name
        from time_entries te
        left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
        left join items i on i.id = te.item_id and i.org_id = te.org_id
        left join accounts a on a.id = i.payroll_expense_account_id and a.org_id = i.org_id
       where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
         and coalesce(tt.exclude_from_wages, false) = false
    `));
    const otComponent = need("overtime", "earning");
    const groups = new Map<string, {
      row: (typeof time.rows)[0]; entries: { workedOn: string; hours: string }[];
    }>();
    for (const t of time.rows) {
      const key = [t.time_type_id ?? "", t.project_id ?? "", t.department_id ?? "", t.item_id ?? ""].join("|");
      const entry = { workedOn: t.worked_on, hours: t.hours };
      const existing = groups.get(key);
      if (existing) existing.entries.push(entry);
      else groups.set(key, { row: t, entries: [entry] });
    }
    let sequence = 10;
    for (const group of groups.values()) {
      const isOt = group.row.classification === "overtime" || group.row.classification === "double_time";
      const componentRow = isOt ? otComponent : baseComponent;
      const stamp = resolveEarningExpenseAccount({
        item: group.row.item_id == null ? null : {
          id: group.row.item_id,
          name: group.row.item_name ?? group.row.item_id,
          accountId: group.row.item_account_id,
          accountNumber: group.row.item_account_number,
          accountName: group.row.item_account_name,
        },
        component: {
          id: String(componentRow.id),
          name: String(componentRow.name ?? "component"),
          expenseAccountId: componentRow.expense_account_id == null
            ? null : String(componentRow.expense_account_id),
        },
        wageDefaultAccountId: wageExpenseAccountId,
      });
      const priced = priceDatedWageEntries(hourlyWage, group.row.multiplier, group.entries, payRate!);
      for (const part of priced.days) lines.push({
        componentId: String(componentRow.id),
        kind: "earning",
        description: group.row.type_name,
        hours: part.hours, rate: priced.rate,
        earnedFrom: part.workedOn, earnedTo: part.workedOn,
        amount: parseMoney(part.amount),
        projectId: group.row.project_id, departmentId: group.row.department_id,
        timeTypeId: group.row.time_type_id, itemId: group.row.item_id,
        expenseAccountId: stamp?.accountId ?? null,
        expenseAccountSource: stamp?.source ?? null,
        expenseAccountEvidence: stamp?.evidence ?? null,
        sequence: sequence++,
        classification: group.row.classification,
        programApplicability: programApplicabilityFromExclusions(componentRow.program_exclusions),
      });
    }
  }
}

/**
 * Phase 1b mechanics: one earning line per settled retro allocation bucket,
 * straight out of payroll_retro_allocations (dynamic import — the retro
 * module depends on this one), taxed on the pack's declared retroactive
 * treatment. Gated to retro runs by the caller's flag.
 */
export async function appendRetroSettlementLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    emp: Record<string, string | null>;
    country: string;
    retroRun: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId, documentId, employeePartyId, emp, country, retroRun, lines,
    allowedSubsidiaryIds,
  } = args;
  if (retroRun) {
    const { retroEarningLinesForStub } = await import("./retro-store.ts");
    const retroLines = await retroEarningLinesForStub(tx, {
      orgId, payRunDocumentId: documentId, employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      nonPeriodic: payrollPack(country).retroactivePayTreatment === "non_periodic",
      allowedSubsidiaryIds,
    });
    for (const line of retroLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        description: line.description,
        // Deliberately no `hours`: the source periods already paid every
        // per-hour component and union fringe on those hours, and carrying
        // them here would pay all of them a second time. The hours are on the
        // settlement rows as evidence instead.
        // Cross-struct boundary: retro lines carry their own amount shape,
        // so the stub re-parses here (fail closed, like every persist
        // boundary) instead of asserting a brand it cannot prove.
        amount: parseMoney(line.amount),
        projectId: line.projectId,
        departmentId: line.departmentId,
        sequence: line.sequence,
        vacationable: line.vacationable,
        nonPeriodic: line.nonPeriodic,
        supplementalWageCategory: line.supplementalWageCategory,
        statutoryReportingCategory: line.statutoryReportingCategory,
        statutoryExemptionCategory: line.statutoryExemptionCategory,
      });
    }
  }
}

/** Phase 2 mechanics: rule-emitted derived earning INPUTS for the period
 *  (per diem, on-call days, travel…), resolved against the period's approved
 *  time facts. Off-cycle runs are skipped by the caller's flag. */
export async function appendDerivedEarningLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string;
    run: Record<string, string>;
    employeePartyId: string;
    oneOffRun: boolean;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, documentId, run, employeePartyId, oneOffRun, lines } = args;
  if (!oneOffRun) {
    const derivedRules = await loadActiveDerivedRules(tx, orgId, run.period_end!);
    if (derivedRules.length > 0) {
      // Salaried supervisors earn derived amounts too, and the hourly branch's
      // time query is scoped to wages, so read the period's facts explicitly.
      const facts = (await tx.execute<{
          id: string; worked_on: string; hours: string; time_type_id: string | null;
          project_id: string | null; department_id: string | null;
          is_billable: boolean; created_at: string | Date;
        }>(sql`
        select te.id, te.worked_on, te.hours, te.time_type_id, te.project_id,
               te.department_id, te.is_billable, te.created_at
          from time_entries te
          left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
         where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
           and te.status = 'approved'
           and te.worked_on between ${run.period_start} and ${run.period_end}
           and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
           -- Time this run does not pay stays unclaimed for the period's other
           -- run, which derives from it there; deriving here too pays twice.
           and not exists (
             select 1 from pay_run_adjustments a
               join pay_components c on c.id = a.component_id and c.org_id = a.org_id
              where a.org_id = te.org_id and a.pay_run_document_id = ${documentId}
                and a.employee_party_id = te.employee_party_id
                and a.adjustment_type = 'line' and a.replace_component
                and c.system_key = case
                  when coalesce(tt.classification, 'regular') in ('overtime', 'double_time') then 'overtime'
                  else 'base_pay' end)
      `));
      const derived = await resolveDerivedEarnings(tx, {
        orgId,
        employeePartyId,
        periodStart: run.period_start!,
        periodEnd: run.period_end!,
        rules: derivedRules,
        timeEntries: facts.rows.map((fact) => ({
          id: fact.id,
          workedOn: String(fact.worked_on).slice(0, 10),
          hours: fact.hours,
          timeTypeId: fact.time_type_id,
          projectId: fact.project_id,
          departmentId: fact.department_id,
          isBillable: fact.is_billable === true,
          createdAt: fact.created_at instanceof Date
            ? fact.created_at.toISOString()
            : String(fact.created_at),
        })),
        gross: earningsBase(lines),
      });
      for (const line of derived) {
        lines.push({
          componentId: line.componentId,
          kind: "earning",
          description: line.description,
          derivedQuantity: line.quantity,
          derivedRuleCode: line.ruleCode,
          // Deliberately no `hours`: nights and on-call days are not worked
          // hours, and hour-shaped derived quantities are already on the wage
          // lines, so carrying them here would pay per-hour components twice.
          rate: line.rate ?? undefined,
          // Cross-struct boundary, re-parsed like the retro lines above.
          amount: parseMoney(line.amount),
          projectId: line.projectId,
          departmentId: line.departmentId,
          timeTypeId: line.timeTypeId,
          sequence: line.sequence,
          taxable: line.taxable,
          pensionable: line.pensionable,
          insurable: line.insurable,
          vacationable: line.vacationable,
          nonPeriodic: line.nonPeriodic,
      supplementalWageCategory: line.supplementalWageCategory,
      statutoryReportingCategory: line.statutoryReportingCategory,
      statutoryExemptionCategory: line.statutoryExemptionCategory,
        });
      }
    }
  }
}

/** Resolve the same classified operator inputs for derivation and settlement. */
async function runLineAdjustmentRows(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  employeePartyId: string,
): Promise<readonly Record<string, unknown>[]> {
  return (await tx.execute<Record<string, unknown>>(sql`
    select a.id as adjustment_id, a.amount as adj_amount, a.hours as adj_hours, a.earned_from::text as adj_earned_from, a.earned_to::text as adj_earned_to, a.replace_component, a.note, c.*,
           ec.supplemental_wage_category, ec.statutory_reporting_category, ec.statutory_exemption_category
      from pay_run_adjustments a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
      join pay_component_earning_classifications ec
        on ec.org_id = c.org_id and ec.pay_component_id = c.id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `)).rows;
}

/**
 * Phase 2 mechanics: the jurisdiction-gated statutory holiday lines resolved
 * by `statutoryHolidayLinesForStub`, appended with deliberately no `hours`
 * so per-hour components and union fringes cannot be paid twice.
 */
export async function appendStatutoryHolidayEarningLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
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
    orgId, documentId, employeePartyId, emp, country, subsidiaryId, province, run, payRate,
    statHolidayPay, oneOffRun, need, lines, allowedSubsidiaryIds, holidayEligibility,
    occupationClass, currentEarningLines,
  } = args;
  // A period's holiday pay belongs to its regular run, like its salary; a
  // supplemental run in the same period would pay the holiday twice.
  if (!oneOffRun && statHolidayPay && run.run_type !== "supplemental") {
    // An explicit component replacement supplies this run's holiday input.
    // Resolve it before the superseded formula asks for eligibility or prior
    // earnings. The ordinary adjustment phase still validates and applies it;
    // approved unpaid obligations remain separate, governed settlements.
    const adjustments = await runLineAdjustmentRows(tx, orgId, documentId, employeePartyId);
    if (adjustments.some(adjustment => adjustment.replace_component === true
      && adjustment.system_key === "stat_holiday" && adjustment.kind === "earning")) return;
    // Class-based percent-of-pay rules (Manitoba construction s. 30) price
    // the pay's regular wages: every earning line derived so far, before the
    // holiday lines themselves land.
    const periodRegularEarnings = lines
      .filter((line) => line.kind === "earning")
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
        // own flags (taxable, pensionable, insurable, vacationable — all
        // true) classify the amount: holiday pay is wages.
        description: line.description,
        hours: line.hours,
        // Cross-struct boundary, re-parsed like the retro lines above.
        amount: parseMoney(line.amount),
        sequence: line.sequence,
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
    orgId: string; employeePartyId: string; employmentId: string;
    taxYear: number;
    documentId: string;
    assignedRows: Record<string, unknown>[];
    runType: PayRunType;
    oneOffRun: boolean;
    lines: Line[];
    /** The run's period: fixed_amount rows covering only part of it prorate. */
    periodStart: string;
    periodEnd: string;
  },
): Promise<void> {
  const {
    orgId, employeePartyId, employmentId, taxYear, documentId, oneOffRun, lines,
    periodStart, periodEnd,
  } = args;
  const assignedRows = applicableAssignedComponents(args.assignedRows, args.runType);
  // A rate-card assignment prices operational facts; its value is not also
  // a recurring payment. Resolve ownership on the same date as derived rules,
  // including periods with no qualifying facts and therefore no derived line.
  const rateCardComponents = new Set(!oneOffRun && args.assignedRows.some((row) => row.kind === 'earning')
    ? (await loadActiveDerivedRules(tx, orgId, periodEnd))
      .filter((rule) => rule.rateMode === 'rate_card').map((rule) => rule.componentId)
    : []);
  for (const row of args.assignedRows) {
    if (row.run_applicability === 'regular_only' && rateCardComponents.has(String(row.id))) {
      throw new PayrollError(`Payroll component ${String(row.code)} prices operational facts through a rate-card rule — replace its recurring assignment with standard applicability before recalculating.`);
    }
  }
  await assertComponentServiceEligibility(tx, { orgId, employmentId, policyDate: periodEnd,
    componentIds: oneOffRun ? [] : assignedRows.map((row) => String(row.id)) });
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
    if (c.kind === 'earning' && rateCardComponents.has(String(c.id))) continue;
    const value = String(c.override ?? c.value ?? "0");
    const capped = {
      basis: c.basis as "fixed_amount" | "per_hour" | "percent_of_gross",
      value,
      basisCapHoursPerPeriod: c.basis_cap_hours_per_period as string | null,
      basisCapAmountPerPeriod: c.basis_cap_amount_per_period as string | null,
      basisCapAmountPerYear: c.basis_cap_amount_per_year as string | null,
    };
    const hasCap = capped.basisCapHoursPerPeriod != null
      || capped.basisCapAmountPerPeriod != null
      || capped.basisCapAmountPerYear != null;
    // The cap changes the basis a percent-of-X component computes on, so it
    // must run HERE: the resulting pre-tax deduction is what the statutory
    // pass consumes as T4127 factor F / U1.
    const context = hasCap
      ? {
          lines: cappableHourLines(lines),
          yearToDate: capped.basisCapAmountPerYear != null
            ? await componentYearToDate(c.id as string)
            : "0",
        }
      : {};
    // All three branches close through roundMoney/mulPercent: canonical Money.
    let amount: Money;
    if (c.basis === "per_hour") {
      amount = roundMoney(mulDecimal(value, applyBasisCaps(capped, totalHours(lines), context)), 2) as Money;
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
        periodStart, periodEnd,
      };
      const { coveredDays, periodDays } = assignmentCoveredDays(window);
      const periodValue = assignmentCoversPeriod(window)
        ? value
        : prorateDays(value, coveredDays, periodDays);
      amount = roundMoney(applyBasisCaps(capped, periodValue, context), 2) as Money;
    }
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: c.id as string, kind: c.kind as Line["kind"],
      description: c.name as string, amount, sequence: Number(c.sequence),
      sourceProratedByCoverage: c.basis === 'fixed_amount',
      sourceEffectiveFrom: [periodStart, String(c.effective_from)].sort().at(-1)!,
      sourceEffectiveTo: [periodEnd, c.effective_to == null ? periodEnd : String(c.effective_to)].sort()[0]!,
      taxable: c.taxable as boolean, pensionable: c.pensionable as boolean,
      insurable: c.insurable as boolean, vacationable: c.vacationable as boolean,
      programApplicability: programApplicabilityFromExclusions(c.program_exclusions),
      nonPeriodic: c.non_periodic as boolean, taxTreatment: c.tax_treatment as string,
      supplementalWageCategory: c.supplemental_wage_category as Line["supplementalWageCategory"],
      statutoryReportingCategory: c.statutory_reporting_category as string | null,
      statutoryExemptionCategory: c.statutory_exemption_category as Line["statutoryExemptionCategory"],
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
    orgId: string; documentId: string; employeePartyId: string;
    bonusRun: boolean; retroRun: boolean; terminationRun: boolean;
    country: string;
    lines: Line[];
  },
): Promise<ReadonlySet<string>> {
  const { orgId, documentId, employeePartyId, bonusRun, retroRun, terminationRun, country, lines } = args;
  const replacedComponentIds = new Set<string>();
  const adjustments = await runLineAdjustmentRows(tx, orgId, documentId, employeePartyId);
  for (const adj of adjustments) {
    if ((adj.adj_earned_from != null || adj.adj_earned_to != null) && adj.kind !== "earning") {
      throw new PayrollError("The dated adjustment component is no longer an earning; review the editable run input.");
    }
    if (adj.system_key === "stat_holiday") {
      if (adj.kind !== "earning" || adj.payment_kind !== "cash" || adj.replace_component !== true
        || adj.adj_hours == null) throw new PayrollError("The recorded holiday input no longer identifies a cash earning replacement with paid hours; review the editable run input.");
      if (adj.adj_earned_from !== adj.adj_earned_to) throw new PayrollError("Record holiday hours on one date within this pay period.");
      const priced = await priceRunHolidayHours(tx, { orgId, documentId, employeePartyId, hours: String(adj.adj_hours),
        earnedOn: adj.adj_earned_from == null ? undefined : String(adj.adj_earned_from) });
      if (cmp(String(adj.adj_amount), priced) !== 0) throw new PayrollError("The dated wage for recorded holiday hours has changed; update the editable holiday input and recalculate.");
    }

    // A saved deposit must still settle through the current native bank;
    // retiring or rebinding a plan cannot turn it into negative worked time.
    await assertBankDepositAdjustment(tx, { orgId, componentId: String(adj.id),
      amount: String(adj.adj_amount), hours: adj.adj_hours == null ? null : String(adj.adj_hours), terminationRun });
    // A queued provider valuation must not lose its non-cash representation
    // when its component is retired before this run is calculated.
    if (adj.payment_kind === "non_cash" && adj.is_active !== true) {
      throw new PayrollError(`non-cash payroll component "${String(adj.name)}" is inactive — re-enable this component in Payroll components, then recalculate the editable run`);
    }
    if (adj.replace_component) {
      replacedComponentIds.add(String(adj.id));
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.componentId === adj.id) lines.splice(i, 1);
      }
    }
    // Operator-entered adjustment, closed through roundMoney: canonical Money.
    const amount = roundMoney(String(adj.adj_amount), 2) as Money;
    // Paid-hour inputs can have no cash value when the corresponding wages
    // are supplied separately. Retain their hours for benefits and reporting;
    // empty replacements still suppress derived pay without creating a line.
    const quantityUnits = (adj.unit_of_measure as string | null) === "quantity";
    const paidHours = adj.kind === "earning" && !quantityUnits
      && adj.adj_hours != null && cmp(String(adj.adj_hours), "0") > 0;
    if (cmp(amount, "0") === 0 && !paidHours) continue;
    // A quantity-unit component counts trips, meals, or incentive units —
    // never hours. Its units stay on the adjustment for the audit trail, but
    // no hours reach the line: every hours basis downstream (per-hour rates,
    // benefit hours bases, insurable-hours and wage-hour reports) reads
    // lines and stub hours, so a quantity line is excluded everywhere by
    // carrying none.
    lines.push({
      componentId: adj.id as string, kind: adj.kind as Line["kind"],
      runAdjustmentId: String(adj.adjustment_id),
      earnedFrom: adj.adj_earned_from == null ? null : String(adj.adj_earned_from),
      earnedTo: adj.adj_earned_to == null ? null : String(adj.adj_earned_to),
      // Recorded holiday units are ordinary wages, not an alternate-day draw.
      fundedByEntitlementBank: adj.system_key === "stat_holiday" ? false : undefined,
      description: (adj.note as string | null) || (adj.name as string),
      hours: quantityUnits || adj.adj_hours == null ? undefined : String(adj.adj_hours),
      amount, sequence: Number(adj.sequence),
      taxable: adj.taxable as boolean, pensionable: adj.pensionable as boolean,
      insurable: adj.insurable as boolean, vacationable: adj.vacationable as boolean,
      programApplicability: programApplicabilityFromExclusions(adj.program_exclusions),
      // On a bonus run every earning is non-periodic by definition: the
      // employee is not receiving this amount every period, so annualizing it
      // would over-withhold badly. On a RETRO run the same is true of a manual
      // top-up line, but the treatment is the pack's declaration rather than
      // this module's opinion — a jurisdiction that taxes retroactive pay as
      // ordinary period income declares so and gets it.
      nonPeriodic: bonusRun
        ? adj.kind === "earning"
        : retroRun
          ? adj.kind === "earning"
            && payrollPack(country).retroactivePayTreatment === "non_periodic"
          : (adj.non_periodic as boolean),
      supplementalWageCategory: adj.supplemental_wage_category as Line["supplementalWageCategory"],
      statutoryReportingCategory: adj.statutory_reporting_category as string | null,
      statutoryExemptionCategory: adj.statutory_exemption_category as Line["statutoryExemptionCategory"],
      taxTreatment: adj.tax_treatment as string,
      // A one-off garnishment entered for a single run is still a protected
      // deduction, and still belongs to (or outside) the protected base.
      protectionBase: adj.protection_base as string,
      protectionMaxPercent: adj.protection_max_percent as string | null,
      protectionPriority: Number(adj.protection_priority ?? 100),
      protectionClass: (adj.protection_class as string | null) ?? null,
      includeInDisposableEarnings: adj.include_in_disposable_earnings as boolean,
    });
  }
  return replacedComponentIds;
}

/**
 * Union fringes and dues under a collective agreement. Each TOTAL is
 * computed once and then allocated across jobs (`allocateProportionally`),
 * so an employer fringe and the identically-rated employee line agree to
 * the cent regardless of how hours or earnings fell across jobs.
 */
export async function appendUnionFringeLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    emp: Record<string, string | null>;
    country: string;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, emp, country, lines } = args;
  // Union fringes and dues (collective agreement)
  if (emp.union_agreement_id) {
    const { fringesForEmployee } = await import("./union.ts");
    const fringes = await fringesForEmployee(
      tx, orgId, emp.union_agreement_id, emp.union_classification_id ?? null,
    );
    for (const fringe of fringes) {
      if (!fringe.component_id) {
        throw new PayrollError(`union fringe ${fringe.code} has no linked pay component`);
      }
      const kind: Line["kind"] = fringe.paid_by === "employer" ? "employer_contribution" : "deduction";
      // The tax treatment of employee-paid dues is the PACK's declaration, not
      // a constant: 'union_dues' is a T4127 factor-U1 key, and stamping it on
      // every employee-paid fringe in every country made a CRA deduction the
      // world's default. A pack that declares null (the US — dues are post-tax
      // under the TCJA) gets dues lines with no treatment at all.
      const taxTreatment = fringe.paid_by === "employee"
        ? (payrollPack(country).employeeUnionDuesTaxTreatment ?? undefined)
        : undefined;
      // `job_costed` is a property of the FRINGE, not of how it is calculated:
      // in construction that flag exists so the fund lands on the job. Both
      // calculation shapes therefore honour it — the percent-of-gross branch
      // used to ignore it entirely and post one untagged line.
      const jobCosted = fringe.job_costed && kind === "employer_contribution";
      if (fringe.calc === "per_hour_worked") {
        // The TOTAL is computed once and then allocated, never summed from
        // independently rounded per-job amounts: $2.375/h × 10.5h is 24.94
        // whole and 24.93 as three job lines, which made an employer fringe
        // and the identically-rated employee line disagree by a cent purely
        // because of how the hours fell across jobs.
        const hours = totalHours(lines);
        const amount = roundMoney(mulDecimal(fringe.value, hours), 2) as Money;
        if (cmp(amount, "0") === 0) continue;
        const hourLines = lines.filter((l) => l.kind === "earning" && l.hours);
        const splits = jobCosted
          ? allocateProportionally(amount, hourLines.map((l) => ({ weight: l.hours!, target: l })))
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id, kind, description: fringe.name,
              hours: split.target.hours, rate: fringe.value, amount: split.amount,
              projectId: split.target.projectId ?? null,
              departmentId: split.target.departmentId ?? null,
              sequence: 300 + fringe.sequence, taxTreatment,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id, kind, description: fringe.name,
            hours, rate: fringe.value, amount,
            sequence: 300 + fringe.sequence, taxTreatment,
          });
        }
      } else {
        const amount = mulPercent(earningsBase(lines), fringe.value, 2) as Money;
        if (cmp(amount, "0") === 0) continue;
        // Percent-of-gross splits proportional to the earnings it is a percent
        // OF — including the untagged share, which stays untagged rather than
        // being pushed onto the jobs.
        const buckets = jobCosted ? earningJobBuckets(lines) : [];
        const splits = buckets.some((b) => b.projectId)
          ? allocateProportionally(amount, buckets.map((b) => ({ weight: b.weight, target: b })))
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id, kind, description: fringe.name,
              amount: split.amount, sequence: 300 + fringe.sequence, taxTreatment,
              projectId: split.target.projectId, departmentId: split.target.departmentId,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id, kind, description: fringe.name,
            amount, sequence: 300 + fringe.sequence, taxTreatment,
          });
        }
      }
    }
  }
}

/**
 * Everything that banks: ONE engine call over the stub's bankable earning
 * lines, honouring scoped caps and service tiers, projected onto the stub
 * as accrual / payout / repayment lines and queued as ledger movements.
 * Returns the vacation accrued this period, for the stub header.
 */
export async function applyEntitlementPlanMovements(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    employmentId?: string;
    policyDate?: string;
    payDate: string;
    /** Employee display name, for the unvalued-hours refusal. */
    employeeName: string;
    vacationPercent: string | null;
    payVacationInCash: boolean;
    excludeVacationAccrual?: boolean;
    vacationPlan: EntitlementPlan | null;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
    entitlementWarnings: EntitlementWarning[];
  },
): Promise<string> {
  const {
    orgId, documentId, employeePartyId, payDate, employeeName,
    vacationPercent, payVacationInCash, vacationPlan, plans,
    lines, entitlementMovements, entitlementWarnings,
  } = args;
  let vacationAccrued = "0";
  // Everything that banks: one call, honouring scoped caps and service tiers.
  if (plans.length > 0) {
    const bankablePlans = (payVacationInCash || args.excludeVacationAccrual) && vacationPlan
      ? plans.filter((p) => p.id !== vacationPlan.id)
      : plans;
    // Each plan excludes its own settlement inside planMovementsForStub.
    // Other bank payouts remain earnings under their declared eligibility;
    // deferred wages can earn vacation when the wage component allows it.
    // Deposit funding stays in the basis so its cash reversal nets the wages
    // being banked away.
    const { movements, warnings } = await planMovementsForStub(tx, {
      orgId, employeePartyId, employmentId: args.employmentId, policyDate: args.policyDate, movementDate: payDate,
      payRunDocumentId: documentId,
      earnings: lines
        .filter((l) => l.kind === "earning" && !l.accrualOnly)
        .map((l) => ({
          componentId: l.componentId, amount: l.amount,
          hours: l.hours ?? null, bankable: l.vacationable ?? true,
        })),
      plans: bankablePlans,
      // The caller supplies the effective employee election and service
      // policy rate already used for cash payment. Both representations
      // therefore preserve the same higher personal vacation floor.
      employeeAccrualValues: vacationPlan
        ? new Map([[vacationPlan.id, String(vacationPercent ?? "0")]])
        : undefined,
    });
    entitlementWarnings.push(...warnings);
    // One wage lookup serves every plan's hours valuation for this stub, the
    // same way entitlementBalances values its hours view. Dynamic import, the
    // way entitlements-db.ts reaches labor-costing.
    const { resolveWage, laborCostingSettings } = await import("../projects/labor-costing.ts");
    const wageSettings = await laborCostingSettings(orgId);
    const resolvedWage = await resolveWage(orgId, employeePartyId, payDate, { annualHoursDefault: wageSettings.annualHours });
    const wage = resolvedWage && cmp(resolvedWage.wage, "0") > 0 ? resolvedWage.wage : null;
    for (const movement of movements) {
      if (!movement.componentId) continue;
      const plan = plans.find((p) => p.id === movement.planId)!;
      // Stub lines pay MONEY, never the plan's unit — an hours-plan movement
      // of 8 hours values at the wage ($240 at $30/h), and refuses by name
      // when no wage resolves. The ledger movement queued below stays in the
      // plan's unit.
      const money = entitlementMoneyValue({ plan, amount: movement.amount, wage, employeeName });
      if (movement.kind === "accrual") {
        // Employer-side accrual: DR burden / CR the plan's liability account,
        // exactly as the old vacation_accrual line did.
        lines.push({
          componentId: movement.componentId, kind: "employer_contribution",
          description: plan.name, amount: money,
          sequence: 240, accrualOnly: true,
        });
        if (plan.systemKey === "vacation") vacationAccrued = money;
      } else if (movement.kind === "payout") {
        lines.push({
          componentId: movement.componentId, kind: "earning",
          description: `${plan.name} payout`, amount: negMoney(money),
          sequence: 46, vacationable: false,
        });
      } else if (movement.kind === "repayment") {
        // 'owe' plans recoup through a deduction — the employee repays what
        // the employer carried during their leave.
        lines.push({
          componentId: movement.componentId, kind: "deduction",
          description: plan.name, amount: money, sequence: 180,
        });
      }
      entitlementMovements.push(movement);
    }
  }
  return vacationAccrued;
}
