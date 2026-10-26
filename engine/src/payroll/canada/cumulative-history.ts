import { sql } from "drizzle-orm";
import { isIsoCalendarDate } from "../../platform/business-date.ts";
import { add, cmp, sum } from "../../money/money.ts";
import { certificateAnswersProblem } from "../certificates.ts";
import { PayrollError } from "../error.ts";
import { at, DAY, iso, nextPeriodAfter, type ScheduleRow } from "../run-calendar.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import type { T4127Averaging, T4127Ytd } from "./t4127.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { readEmployeeOpeningLevySources } from "../opening-levy-source-reader.ts";
import { canonicalDecimal } from "../../money/exact-decimal.ts";

const HISTORY_FIELDS = [
  { key: "income", openingKey: "caAvgIncome", factor: "I" },
  { key: "pensionDeductions", openingKey: "caAvgPensionF", factor: "F" },
  { key: "alimonyDeductions", openingKey: "caAvgAlimony", factor: "F2" },
  { key: "unionDues", openingKey: "caAvgUnionDues", factor: "U1" },
  { key: "f5A", openingKey: "caAvgF5A", factor: "F5A" },
  { key: "pensionablePeriodic", openingKey: "caAvgPe", factor: "CA_PE" },
  { key: "insurablePeriodic", openingKey: "caAvgIe", factor: "CA_IE" },
  { key: "qpipPeriodic", openingKey: "caAvgQpip", factor: "CA_QPIP_PE" },
  { key: "pensionableNonPeriodic", openingKey: "caAvgBonusPe", factor: "CA_BPE" },
  { key: "insurableNonPeriodic", openingKey: "caAvgBonusIe", factor: "CA_BIE" },
  { key: "qpipNonPeriodic", openingKey: "caAvgBonusQpip", factor: "CA_BQPIP" },
  { key: "periodicTax", openingKey: "caAvgTaxM", factor: "CA_T_BASE" },
  { key: "bonusTax", openingKey: "caAvgTaxM1", factor: "TB" },
  { key: "nonPeriodic", openingKey: "caAvgBonus", factor: "B" },
  { key: "nonPeriodicPensionDeductions", openingKey: "caAvgF4", factor: "F3" },
  { key: "nonPeriodicCppEnhancedDeductions", openingKey: "caAvgF5B", factor: "F5B" },
] as const;

/** Option 2's income-tax window is distinct from the full year's CPP/EI
 * ceilings. Off-cycle cheques never become additional scheduled periods. */
export async function cumulativeHistory(
  ctx: PayrollStatutoryComputeContext,
): Promise<{
  averaging: T4127Averaging;
  bonusYtd: Pick<
    T4127Ytd,
    "nonPeriodic" | "nonPeriodicPensionDeductions" | "nonPeriodicCppEnhancedDeductions"
  >;
} | null> {
  const record = ctx.certificateFor("ca_t4127_method");
  if (!record?.onFile) return null;
  const problem = certificateAnswersProblem(record.certificate, record.answers);
  if (problem)
    throw new PayrollError(
      `${problem} — correct the employer withholding method record in the employee’s Payroll profile`,
    );
  if (record.answers.method === "option1") return null;
  if (record.missing.length || record.answers.method !== "option2" || !record.effectiveFrom)
    throw new PayrollError(
      "Complete and date the employer withholding method election in the employee’s Payroll profile before calculating cumulative averaging",
    );
  const owners = await ctx.tx.execute<{
    subsidiaryId: string;
    currency: string;
    payDate: string | null;
  }>(
    sql`
    select d.subsidiary_id as "subsidiaryId",d.currency,r.pay_date::text as "payDate" from documents d
      join pay_runs r on r.org_id=d.org_id and r.document_id=d.id
     where d.org_id=${ctx.orgId} and d.id=${ctx.documentId} and d.kind='pay_run'`,
    "objects",
  );
  if (
    owners.length !== 1 ||
    !owners[0]!.subsidiaryId ||
    (ctx.subsidiaryId !== undefined && ctx.subsidiaryId !== owners[0]!.subsidiaryId)
  )
    throw new PayrollError("Canadian averaging history requires the actual pay-run legal employer");
  if (owners[0]!.currency !== "CAD")
    throw new PayrollError(
      "Canadian averaging history requires a qualified Canadian-dollar pay-run basis",
    );
  const subsidiaryId = owners[0]!.subsidiaryId;
  const payDate = owners[0]!.payDate;
  if (!payDate)
    throw new PayrollError("Canadian averaging history requires the actual pay-run pay date");
  const yearStart = `${ctx.taxYear}-01-01`;
  const declaredStart = record.answers.window_start || record.effectiveFrom;
  if (!isIsoCalendarDate(declaredStart) || declaredStart > payDate)
    throw new PayrollError(
      "Set an averaging window start in YYYY-MM-DD on or before this pay date in the employee’s Payroll withholding method record",
    );
  const start = declaredStart < yearStart ? yearStart : declaredStart;
  const recordedThrough = record.answers.opening_history_through;
  if (recordedThrough && !isIsoCalendarDate(recordedThrough))
    throw new PayrollError(
      "Set the imported averaging history-through date in YYYY-MM-DD in the employee’s withholding method record",
    );
  const through = recordedThrough && recordedThrough >= yearStart ? recordedThrough : null;
  if (through && (!isIsoCalendarDate(through) || through < start || through >= payDate))
    throw new PayrollError(
      "Imported averaging history must end within this averaging window and before the current pay date — correct its history-through date in the Payroll profile",
    );
  if (through && record.answers.opening_history_complete !== "true")
    throw new PayrollError(
      "Verify every averaging opening field against the prior provider’s report in Payroll → Opening Balances, then confirm complete imported history in the employee’s withholding method record",
    );
  if (start < record.effectiveFrom && !through)
    throw new PayrollError(
      "An averaging window before this method election requires complete imported history — supply its history-through date and opening balances, or reset the window to the election date",
    );
  const schedule = (
    await ctx.tx.execute<ScheduleRow>(
      sql`select id,frequency,periods_per_year,anchor_period_end::text,pay_date_offset_days from pay_schedules where org_id=${ctx.orgId} and id=${ctx.run.pay_schedule_id}`,
      "objects",
    )
  )[0];
  if (!schedule)
    throw new PayrollError(
      "Restore this run’s pay schedule before calculating cumulative averaging",
    );
  let cursor = iso(new Date(at(start).getTime() - DAY * (schedule.pay_date_offset_days + 1)));
  let elapsed = 0;
  for (let n = 0; n < 370; n++) {
    const period = nextPeriodAfter(schedule, cursor);
    const payday = iso(
      new Date(at(period.periodEnd).getTime() + DAY * schedule.pay_date_offset_days),
    );
    if (payday > payDate) break;
    if (payday >= start) elapsed++;
    cursor = period.periodEnd;
  }
  // Before the first scheduled payday, an off-cycle cheque uses the first
  // projection period; it creates no extra calendar boundary for later runs.
  elapsed = Math.max(1, elapsed);
  if (elapsed > ctx.periodsPerYear)
    throw new PayrollError(
      "The averaging calendar exceeds the schedule’s periods per year — correct its calendar or reset the elected window",
    );
  const unknownHistory = await ctx.tx.execute(
    sql`
    select s.id from pay_stubs s
      join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
     where s.org_id=${ctx.orgId} and s.employee_party_id=${ctx.employeePartyId} and s.tax_year=${ctx.taxYear}
       and s.pay_run_document_id<>${ctx.documentId} and r.run_status='committed' and d.status<>'voided'
       and r.pay_date>=${start}::date and d.subsidiary_id=${subsidiaryId}
       and (s.country is null or s.country='CA' and (s.currency_code<>'CAD' or d.currency<>'CAD'))
     limit 1`,
    "objects",
  );
  if (unknownHistory.length)
    throw new PayrollError(
      "Canadian averaging history has unknown country or currency attribution — qualify the original retained payroll source before calculating",
    );
  const history = await ctx.tx.execute<{
    pay_date: string;
    schedule_id: string;
    factors: Record<string, string>;
  }>(
    sql`
    select r.pay_date::text,r.pay_schedule_id as schedule_id,s.factors from pay_stubs s
      join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${ctx.orgId} and s.employee_party_id=${ctx.employeePartyId} and s.tax_year=${ctx.taxYear}
      and s.pay_run_document_id<>${ctx.documentId} and r.run_status='committed' and d.status<>'voided'
      and r.pay_date>=${start}::date
      and d.subsidiary_id=${subsidiaryId} and s.country='CA' and s.currency_code='CAD'
    order by r.pay_date,s.id`,
    "objects",
  );
  if (history.some((row) => row.pay_date > payDate))
    throw new PayrollError(
      "A later pay run is already committed in this averaging window — correct payroll through the controlled void and replacement workflow before recalculating an earlier pay date",
    );
  if (history.some((row) => row.schedule_id !== schedule.id))
    throw new PayrollError(
      "The averaging window spans different pay schedules — reset the employer withholding method window on the new schedule’s effective date",
    );
  if (through && history.some((row) => row.pay_date <= through))
    throw new PayrollError(
      "Imported averaging history overlaps committed payroll — correct its history-through date and opening balances before calculating",
    );
  let opening: Record<string, string> | undefined;
  if (through) {
    const source = await readEmployeeOpeningLevySources(ctx.tx, {
      orgId: ctx.orgId,
      employeePartyId: ctx.employeePartyId,
      taxYear: ctx.taxYear,
      subsidiaryId,
      beforeDate: payDate,
    });
    if (
      !source.hasOpening ||
      !source.facts ||
      !source.authority ||
      !source.openingSnapshot ||
      !source.openingChildren
    )
      throw new PayrollError(
        "Imported averaging history has no qualified original opening for this legal employer — qualify its exact retained opening report, country and employer in Payroll → Opening balances → Levy source before calculating",
      );
    if (source.facts.originalCountry !== "CA" || source.facts.originalCurrency !== "CAD")
      throw new PayrollError(
        "Imported Canadian averaging history requires a certified original Canadian-dollar source — qualify the original Canadian report in Payroll → Opening balances → Levy source or correct the imported-history declaration before calculating",
      );
    if (source.facts.coverageEnd !== through)
      throw new PayrollError(
        "Imported averaging history-through must equal the original report’s certified coverage end — correct the withholding method declaration to match its qualified source before calculating",
      );
    opening = {};
    const columns = [
      ...HISTORY_FIELDS.map(
        (field) => CA_OPENING_YTD_FIELDS.find((row) => row.key === field.openingKey)!.column,
      ),
      "taxable_ytd",
      "pensionable_ytd",
      "insurable_ytd",
      "tax_ytd",
    ];
    for (const column of columns) {
      const amount = canonicalDecimal(source.openingSnapshot[column], 4);
      if (amount === null || cmp(amount, "0") < 0)
        throw new PayrollError(
          `The original ${column} averaging opening is not an exact non-negative decimal — qualify its original source before calculating`,
        );
      opening[column] = amount;
    }
  }
  if (opening) {
    const excess = (parts: string[], whole: string) =>
      cmp(sum(parts.map((key) => opening[key]!)), opening[whole]!) > 0;
    if (
      excess(["ca_avg_income", "ca_avg_bonus"], "taxable_ytd") ||
      excess(["ca_avg_pe", "ca_avg_bonus_pe"], "pensionable_ytd") ||
      excess(["ca_avg_ie", "ca_avg_bonus_ie"], "insurable_ytd") ||
      excess(["ca_avg_tax_m", "ca_avg_tax_m1"], "tax_ytd")
    )
      throw new PayrollError(
        "Imported averaging-window earnings or withholding exceed calendar-year opening balances — reconcile both sets to the prior provider’s report in Payroll → Opening Balances",
      );
  }
  const amounts: Record<string, string> = {};
  for (const field of HISTORY_FIELDS) {
    if (history.some((row) => row.factors[field.factor] == null))
      throw new PayrollError(
        `Committed payroll lacks ${field.factor} history required for cumulative averaging — reset the employer withholding method window after that payroll or replace it through the controlled payroll correction workflow`,
      );
    const column = CA_OPENING_YTD_FIELDS.find((row) => row.key === field.openingKey)!.column;
    amounts[field.key] = sum([
      opening?.[column] ?? "0",
      ...history.map((row) => row.factors[field.factor]!),
    ]);
  }
  // M excludes L at the producer, so additional voluntary withholding never
  // reduces a later statutory deduction; TB stays in M1 rather than M.
  for (const key of ["periodicTax", "bonusTax"])
    if (add(amounts[key]!, "0").startsWith("-"))
      throw new PayrollError(
        "Averaging withholding history cannot be negative — review its committed correction history",
      );
  return {
    averaging: { ...amounts, elapsedPeriods: elapsed } as unknown as T4127Averaging,
    bonusYtd: {
      nonPeriodic: amounts.nonPeriodic,
      nonPeriodicPensionDeductions: amounts.nonPeriodicPensionDeductions,
      nonPeriodicCppEnhancedDeductions: amounts.nonPeriodicCppEnhancedDeductions,
    },
  };
}
