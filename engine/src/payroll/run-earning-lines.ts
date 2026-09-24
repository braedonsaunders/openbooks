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
import { add, cmp, mulDecimal, mulPercent, neg, prorateDays, roundMoney, sum } from "../money/money.ts";
import { payrollPack } from "./packs.ts";
import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";
import { componentYearToDate as openingComponentYtd } from "./opening-balances.ts";
import { loadActiveDerivedRules, resolveDerivedEarnings } from "./derived-earnings.ts";
import { entitlementBalances, entitlementMoneyValue, planMovementsForStub, type EntitlementPlan, type EntitlementWarning } from "./entitlements.ts";
import { applyBasisCaps } from "./limits.ts";
import { divideMoney, allocateProportionally } from "./run-allocation.ts";
import { type Line, programApplicabilityFromExclusions, statutoryHolidayLinesForStub, earningsBase, totalHours, earningJobBuckets, cappableHourLines, resolveEarningExpenseAccount } from "./run-stub-records.ts";
import { resolvePayRate } from "./run-calculation-support.ts";
import { assignmentCoveredDays, assignmentCoversPeriod } from "./assignment-windows.ts";
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
  } else if (emp.pay_basis === "salary") {
    // Exact annual ÷ periods, rounded once (see divideMoney).
    const periodSalary = divideMoney(payRate!.rate, String(P), 2);
    lines.push({
      componentId: baseComponent.id as string, kind: "earning", description: "Salary",
      amount: periodSalary, sequence: 10,
      programApplicability: programApplicabilityFromExclusions(baseComponent.program_exclusions),
    });
  } else {
    // Exact annual ÷ annual hours. This quotient IS the stored four-decimal
    // hourly wage, so a float reciprocal's error does not wash out — it is
    // multiplied by every hour on every stub, always the same direction.
    const hourlyWage = payRate!.basis === "hour"
      ? payRate!.rate
      : divideMoney(payRate!.rate, String(payRate!.annualHours), 4);
    const time = (await tx.execute<{
        id: string; hours: string; project_id: string | null; department_id: string | null;
        time_type_id: string | null; item_id: string | null;
        classification: string; multiplier: string; type_name: string;
        item_name: string | null; item_account_id: string | null;
        item_account_number: string | null; item_account_name: string | null;
      }>(sql`
      select te.id, te.hours, te.project_id, te.department_id, te.time_type_id, te.item_id,
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
    const groups = new Map<string, { hours: string; rate: string; row: (typeof time.rows)[0] }>();
    for (const t of time.rows) {
      // Hours on different service items never merge: each item may declare
      // its own expense account, so one line per (time type, project,
      // department, item). Entries with no item keep the historical grouping.
      const key = [t.time_type_id ?? "", t.project_id ?? "", t.department_id ?? "", t.item_id ?? ""].join("|");
      const rate = roundMoney(mulDecimal(hourlyWage, t.multiplier), 4);
      const existing = groups.get(key);
      if (existing) existing.hours = add(existing.hours, t.hours);
      else groups.set(key, { hours: t.hours, rate, row: t });
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
      lines.push({
        componentId: String(componentRow.id),
        kind: "earning",
        description: group.row.type_name,
        hours: group.hours, rate: group.rate,
        amount: roundMoney(mulDecimal(group.rate, group.hours), 2),
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
        amount: line.amount,
        projectId: line.projectId,
        departmentId: line.departmentId,
        sequence: line.sequence,
        vacationable: line.vacationable,
        nonPeriodic: line.nonPeriodic,
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
         where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
           and te.status = 'approved'
           and te.worked_on between ${run.period_start} and ${run.period_end}
           and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
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
          // Deliberately no `hours`: nights and on-call days are not worked
          // hours, and hour-shaped derived quantities are already on the wage
          // lines, so carrying them here would pay per-hour components twice.
          rate: line.rate ?? undefined,
          amount: line.amount,
          projectId: line.projectId,
          departmentId: line.departmentId,
          timeTypeId: line.timeTypeId,
          sequence: line.sequence,
          taxable: line.taxable,
          pensionable: line.pensionable,
          insurable: line.insurable,
          vacationable: line.vacationable,
          nonPeriodic: line.nonPeriodic,
        });
      }
    }
  }
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
  },
): Promise<void> {
  const {
    orgId, documentId, employeePartyId, emp, country, province, run, payRate,
    statHolidayPay, oneOffRun, need, lines, allowedSubsidiaryIds, holidayEligibility,
  } = args;
  if (!oneOffRun && statHolidayPay) {
    const holidayLines = await statutoryHolidayLinesForStub(tx, {
      orgId,
      documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      emp,
      country,
      province,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      payRate,
      need,
      allowedSubsidiaryIds,
      holidayEligibility,
    });
    for (const line of holidayLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        // Deliberately no `hours`: a paid day off is not worked hours, and
        // carrying them would pay per-hour components and union fringes
        // twice. The component's own flags (taxable, pensionable, insurable,
        // vacationable — all true) classify the amount: holiday pay is wages.
        description: line.description,
        amount: line.amount,
        sequence: line.sequence,
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
    orgId: string; employeePartyId: string;
    taxYear: number;
    documentId: string;
    assignedRows: Record<string, unknown>[];
    oneOffRun: boolean;
    lines: Line[];
    /** The run's period: fixed_amount rows covering only part of it prorate. */
    periodStart: string;
    periodEnd: string;
  },
): Promise<void> {
  const {
    orgId, employeePartyId, taxYear, documentId, assignedRows, oneOffRun, lines,
    periodStart, periodEnd,
  } = args;
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
    let amount: string;
    if (c.basis === "per_hour") {
      amount = roundMoney(mulDecimal(value, applyBasisCaps(capped, totalHours(lines), context)), 2);
    } else if (c.basis === "percent_of_gross") {
      amount = mulPercent(applyBasisCaps(capped, earningsBase(lines), context), value, 2);
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
      amount = roundMoney(applyBasisCaps(capped, periodValue, context), 2);
    }
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: c.id as string, kind: c.kind as Line["kind"],
      description: c.name as string, amount, sequence: Number(c.sequence),
      taxable: c.taxable as boolean, pensionable: c.pensionable as boolean,
      insurable: c.insurable as boolean, vacationable: c.vacationable as boolean,
      programApplicability: programApplicabilityFromExclusions(c.program_exclusions),
      nonPeriodic: c.non_periodic as boolean, taxTreatment: c.tax_treatment as string,
      protectionBase: c.protection_base as string,
      protectionMaxPercent: c.protection_max_percent as string | null,
      protectionPriority: Number(c.protection_priority ?? 100),
      includeInDisposableEarnings: c.include_in_disposable_earnings as boolean,
    });
  }
}

/**
 * Run-level 'line' adjustments: one-off inputs for THIS employee in THIS
 * run. replaceComponent swaps out the component's derived lines (time,
 * salary, or recurring) before the one-off amount lands; either way the
 * statutory math below sees the adjusted inputs, never edited outputs.
 */
export async function applyRunLineAdjustments(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    bonusRun: boolean; retroRun: boolean;
    country: string;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, documentId, employeePartyId, bonusRun, retroRun, country, lines } = args;
  const adjustments = (await tx.execute<Record<string, unknown>>(sql`
    select a.amount as adj_amount, a.hours as adj_hours, a.replace_component, a.note, c.*
      from pay_run_adjustments a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `));
  for (const adj of adjustments.rows) {
    if (adj.replace_component) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.componentId === adj.id) lines.splice(i, 1);
      }
    }
    const amount = roundMoney(String(adj.adj_amount), 2);
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: adj.id as string, kind: adj.kind as Line["kind"],
      description: (adj.note as string | null) || (adj.name as string),
      hours: adj.adj_hours != null ? String(adj.adj_hours) : undefined,
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
      taxTreatment: adj.tax_treatment as string,
      // A one-off garnishment entered for a single run is still a protected
      // deduction, and still belongs to (or outside) the protected base.
      protectionBase: adj.protection_base as string,
      protectionMaxPercent: adj.protection_max_percent as string | null,
      protectionPriority: Number(adj.protection_priority ?? 100),
      includeInDisposableEarnings: adj.include_in_disposable_earnings as boolean,
    });
  }
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
        const amount = roundMoney(mulDecimal(fringe.value, hours), 2);
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
        const amount = mulPercent(earningsBase(lines), fringe.value, 2);
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
 * Final-pay mechanics: payout earning lines clearing every accrued bank
 * plus the matching negative ledger movements, read net of this run's own
 * movements. Skipped unless a termination run has plans to settle.
 */
export async function settleTerminationBankPayouts(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; payDate: string;
    employeePartyId: string;
    /** Employee display name, for the unvalued-hours refusal. */
    employeeName: string;
    terminationRun: boolean;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  },
): Promise<void> {
  const {
    orgId, documentId, payDate, employeePartyId, employeeName,
    terminationRun, plans, lines, entitlementMovements,
  } = args;
  // A final pay must clear every accrued bank: the carried balance is paid out
  // with this period's accrual, never left on the books for someone who left.
  //
  // The balances are read INSIDE this transaction and NET OF THIS RUN'S OWN
  // movements. Both matter: without the exclusion the second Calculate saw the
  // first Calculate's `−balance` payout row, netted to zero, and silently
  // dropped the departing employee's entire accrued balance from their final
  // cheque — leaving the liability on the books with nobody to pay it to.
  if (terminationRun && plans.length > 0) {
    const balances = await entitlementBalances(orgId, employeePartyId, payDate, {
      executor: tx, excludeRunDocumentId: documentId, plans,
    });
    for (const balance of balances) {
      if (cmp(balance.balance, "0") <= 0) continue;
      if (!balance.plan.payoutComponentId) {
        throw new PayrollError(
          `entitlement plan ${balance.plan.code} has no payout component — set it in Payroll setup → Entitlement plans`,
        );
      }
      // The line pays MONEY, never the plan's unit: an hours bank values at
      // the current wage (40 hours at $30/h pays $1,200, not $40.00), and a
      // bank with no resolvable wage refuses by name instead of mispricing.
      // The ledger movement below stays in the plan's unit — the bank IS
      // hours; only its payout is money.
      const payoutMoney = entitlementMoneyValue({
        plan: balance.plan, amount: balance.balance, wage: balance.wage, employeeName,
      });
      lines.push({
        componentId: balance.plan.payoutComponentId, kind: "earning",
        description: `${balance.plan.name} payout (accrued balance)`,
        amount: payoutMoney, sequence: 44, vacationable: false,
      });
      entitlementMovements.push({
        planId: balance.plan.id, employeePartyId, movementDate: payDate,
        amount: neg(roundMoney(balance.balance, 2)), hours: null,
        kind: "payout", componentId: balance.plan.payoutComponentId,
        note: "Final pay — bank cleared",
      });
    }
  }
}

/**
 * Cash-out vacation: the money is paid rather than banked, bypassing the
 * plan engine entirely and producing no ledger movement.
 */
export function appendCashVacationPay(args: {
  vacationPercent: string | null;
  payVacationInCash: boolean;
  need: (systemKey: string, kind: string) => Record<string, unknown>;
  lines: Line[];
}): void {
  const { vacationPercent, payVacationInCash, need, lines } = args;
  // Cash-out vacation policies bypass the bank entirely: the money is paid,
  // not accrued, so no ledger movement is produced.
  if (payVacationInCash && vacationPercent && cmp(vacationPercent, "0") > 0) {
    const base = sum(lines
      .filter((l) => l.kind === "earning" && (l.vacationable ?? true) && !l.accrualOnly)
      .map((l) => l.amount));
    const vacation = mulPercent(base, vacationPercent, 2);
    if (cmp(vacation, "0") > 0) {
      const c = need("vacation_payout", "earning");
      lines.push({
        componentId: c.id as string, kind: "earning", description: "Vacation pay",
        amount: vacation, sequence: 45, vacationable: false,
      });
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
    payDate: string;
    /** Employee display name, for the unvalued-hours refusal. */
    employeeName: string;
    vacationPercent: string | null;
    payVacationInCash: boolean;
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
    const bankablePlans = payVacationInCash && vacationPlan
      ? plans.filter((p) => p.id !== vacationPlan.id)
      : plans;
    const { movements, warnings } = await planMovementsForStub(tx, {
      orgId, employeePartyId, movementDate: payDate,
      payRunDocumentId: documentId,
      earnings: lines
        .filter((l) => l.kind === "earning" && !l.accrualOnly)
        .map((l) => ({
          componentId: l.componentId, amount: l.amount,
          hours: l.hours ?? null, bankable: l.vacationable ?? true,
        })),
      plans: bankablePlans,
      // The Vacation plan's rate has ONE home: the employee's payroll profile.
      // Its absence is an answer, not a gap — an employee with no
      // vacation_percent accrues nothing, and must not silently inherit the
      // plan's org-wide default the way a tenant-defined bank does. (A reached
      // service rung still overrides: a ladder is deliberate org policy.)
      employeeAccrualValues: vacationPlan
        ? new Map([[vacationPlan.id, String(vacationPercent ?? "0")]])
        : undefined,
    });
    entitlementWarnings.push(...warnings);
    // One wage lookup serves every plan's hours valuation for this stub, the
    // same way entitlementBalances values its hours view. Dynamic import, the
    // way entitlements-db.ts reaches labor-costing.
    const { resolveWage } = await import("../projects/labor-costing.ts");
    const resolvedWage = await resolveWage(orgId, employeePartyId, payDate);
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
          description: `${plan.name} payout`, amount: neg(money),
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
