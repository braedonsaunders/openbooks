import { sourceTimeAvailableSql } from "../projects/source-time-availability.ts";

import { type PayrollSubsidiaryScope } from "./scope.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { parseMoney } from "../money/brands.ts";

import { payrollPack } from "./packs.ts";

import { loadActiveDerivedRules, resolveDerivedEarnings } from "./derived-earnings.ts";

import { priceDatedWageEntries } from "./wage-rounding.ts";

import { loadWageTimeEntries } from "./wage-hours.ts";

import { type Line, earningsBase, resolveEarningExpenseAccount } from "./run-stub-records.ts";

import { resolvePayRate } from "./run-calculation-support.ts";

import { payrollHourlyWage, salaryPeriodPay } from "./rate.ts";

export async function appendPeriodicEarnings(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    run: Record<string, string>;
    emp: Record<string, string | null>;
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
    orgId,
    documentId,
    run,
    emp,
    employeePartyId,
    payRate,
    periodsPerYear: P,
    baseComponent,
    oneOffRun,
    need,
    wageExpenseAccountId,
    lines,
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
      componentId: baseComponent.id as string,
      kind: "earning",
      description: "Salary",
      amount: periodSalary,
      sequence: 10,
      // A salary is earned across the whole pay period: dating it lets later
      // lookbacks (holiday averages) place it exactly instead of prorating.
      earnedFrom: run.period_start,
      earnedTo: run.period_end,
    });
  } else {
    // Exact annual amount ÷ annual hours (see payrollHourlyWage): the
    // quotient is multiplied by every hour on every stub.
    const hourlyWage = payrollHourlyWage(payRate!);
    // The Scope tab previews exactly this read, so the previewed hours are
    // the hours Calculate prices — never claimed-by-another-run or
    // non-wage time this run will not pay.
    const time = await loadWageTimeEntries(tx, {
      orgId,
      employeePartyIds: [employeePartyId],
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      documentId,
    });
    const otComponent = need("overtime", "earning");
    const groups = new Map<
      string,
      {
        row: (typeof time)[number];
        entries: { workedOn: string; hours: string }[];
      }
    >();
    for (const t of time) {
      const key = [
        t.timeTypeId ?? "",
        t.projectId ?? "",
        t.departmentId ?? "",
        t.itemId ?? "",
      ].join("|");
      const entry = { workedOn: t.workedOn, hours: t.hours };
      const existing = groups.get(key);
      if (existing) existing.entries.push(entry);
      else groups.set(key, { row: t, entries: [entry] });
    }
    let sequence = 10;
    for (const group of groups.values()) {
      const isOt =
        group.row.classification === "overtime" || group.row.classification === "double_time";
      const componentRow = isOt ? otComponent : baseComponent;
      const stamp = resolveEarningExpenseAccount({
        item:
          group.row.itemId == null
            ? null
            : {
                id: group.row.itemId,
                name: group.row.itemName ?? group.row.itemId,
                accountId: group.row.itemAccountId,
                accountNumber: group.row.itemAccountNumber,
                accountName: group.row.itemAccountName,
              },
        component: {
          id: String(componentRow.id),
          name: String(componentRow.name ?? "component"),
          expenseAccountId:
            componentRow.expense_account_id == null
              ? null
              : String(componentRow.expense_account_id),
        },
        wageDefaultAccountId: wageExpenseAccountId,
      });
      const priced = priceDatedWageEntries(
        hourlyWage,
        group.row.multiplier,
        group.entries,
        payRate!,
      );
      for (const part of priced.days)
        lines.push({
          componentId: String(componentRow.id),
          kind: "earning",
          description: group.row.typeName,
          hours: part.hours,
          rate: priced.rate,
          earnedFrom: part.workedOn,
          earnedTo: part.workedOn,
          amount: parseMoney(part.amount),
          projectId: group.row.projectId,
          departmentId: group.row.departmentId,
          timeTypeId: group.row.timeTypeId,
          itemId: group.row.itemId,
          expenseAccountId: stamp?.accountId ?? null,
          expenseAccountSource: stamp?.source ?? null,
          expenseAccountEvidence: stamp?.evidence ?? null,
          sequence: sequence++,
          classification: group.row.classification,
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
    orgId: string;
    documentId: string;
    employeePartyId: string;
    emp: Record<string, string | null>;
    country: string;
    retroRun: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId,
    documentId,
    employeePartyId,
    emp,
    country,
    retroRun,
    lines,
    allowedSubsidiaryIds,
  } = args;
  if (retroRun) {
    const { retroEarningLinesForStub } = await import("./retro-store.ts");
    const retroLines = await retroEarningLinesForStub(tx, {
      orgId,
      payRunDocumentId: documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      nonPeriodic: payrollPack(country).retroactivePayTreatment === "non_periodic",
      allowedSubsidiaryIds,
    });
    for (const line of retroLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        description: line.description,
        // Earned in the settled source period, not this run's: the source
        // span is the honest earned span for later lookbacks.
        earnedFrom: line.sourcePeriodStart,
        earnedTo: line.sourcePeriodEnd,
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
    orgId: string;
    documentId: string;
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
      const facts = await tx.execute<{
        id: string;
        worked_on: string;
        hours: string;
        time_type_id: string | null;
        project_id: string | null;
        department_id: string | null;
        is_billable: boolean;
        created_at: string | Date;
      }>(
        sql`
        select te.id, te.worked_on, te.hours, te.time_type_id, te.project_id,
               te.department_id, te.is_billable, te.created_at
          from time_entries te
          left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
         where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
           and te.status = 'approved'
           and (${sourceTimeAvailableSql(sql`te.custom`)} or te.payroll_batch_ref = ${documentId})
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
      `,
        "objects",
      );
      const derived = await resolveDerivedEarnings(tx, {
        orgId,
        employeePartyId,
        periodStart: run.period_start!,
        periodEnd: run.period_end!,
        payDate: run.pay_date!,
        rules: derivedRules,
        timeEntries: facts.map((fact) => ({
          id: fact.id,
          workedOn: String(fact.worked_on).slice(0, 10),
          hours: fact.hours,
          timeTypeId: fact.time_type_id,
          projectId: fact.project_id,
          departmentId: fact.department_id,
          isBillable: fact.is_billable === true,
          createdAt:
            fact.created_at instanceof Date
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
          // Derived rows aggregate the period's own time facts: earned
          // across the pay period, like the salary beside them.
          earnedFrom: run.period_start,
          earnedTo: run.period_end,
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
          programApplicability: line.programApplicability,
          nonPeriodic: line.nonPeriodic,
          supplementalWageCategory: line.supplementalWageCategory,
          statutoryReportingCategory: line.statutoryReportingCategory,
          statutoryExemptionCategory: line.statutoryExemptionCategory,
        });
      }
    }
  }
}

export {
  appendStatutoryHolidayEarningLines,
  applyAssignedComponentLines,
  applyRunLineAdjustments,
} from "./run-earning-line-adjustments.ts";
