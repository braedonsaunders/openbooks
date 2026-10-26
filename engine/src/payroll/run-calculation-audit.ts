/**
 * Retained evidence for one persisted pay-run calculation.
 *
 * A calculation replaces the run's stubs, stub lines, entitlement movements
 * and calculated allocation rows. The rows it replaces are the only record
 * of what the previous calculation actually produced, so each persisted
 * calculation carries its before and after results into the native
 * audit_log in the same transaction. The evidence is assembled in SQL:
 * stored decimal columns are cast to text there, and stored JSON snapshots
 * are embedded as stored, so no monetary value is ever re-derived from a
 * JavaScript number or from live component and profile configuration.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

type Runner = Pick<typeof db, "execute">;

/** One run's calculated result at a point inside the calculating transaction. */
export interface CapturedPayRunCalculationEvidence {
  /**
   * Serialized evidence object. It is carried as text and embedded into the
   * audit event as JSON without being decoded, so the decimal text and the
   * stored source snapshots inside it survive exactly as read.
   */
  evidence: string;
  /** True when the run already carried a calculated result to preserve. */
  hasCalculatedResult: boolean;
  /** The stored source digest of the captured result, when one was pinned. */
  calculationSourceDigest: string | null;
}

const RUN_EVIDENCE = sql`
  jsonb_build_object(
    'documentId', r.document_id::text,
    'documentNumber', d.document_number,
    'payScheduleId', r.pay_schedule_id::text,
    'subsidiaryId', d.subsidiary_id::text,
    'currency', d.currency,
    'documentStatus', d.status,
    'runStatus', r.run_status,
    'runType', r.run_type,
    'periodStart', r.period_start::text,
    'periodEnd', r.period_end::text,
    'payDate', r.pay_date::text,
    'taxYear', r.tax_year,
    'employeeCount', r.employee_count,
    'grossTotal', r.gross_total::text,
    'netTotal', r.net_total::text,
    'employerCostTotal', r.employer_cost_total::text,
    'calculatedAt', case when r.calculated_at is null then null
      else to_char(r.calculated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'calculationSourceDigest', r.calculation_source_digest,
    'calculationSourceSnapshot', r.calculation_source_snapshot,
    'benefitSourceSnapshot', r.benefit_source_snapshot,
    'calculationErrors', coalesce(r.calculation_errors, '[]'::jsonb),
    'refusalAcknowledgement', r.refusal_acknowledgement
  )`;

const STUB_EVIDENCE = sql`
  coalesce((
    select jsonb_agg(stub_value order by employee_party_id, stub_id)
      from (
        select s.employee_party_id::text as employee_party_id, s.id as stub_id,
               jsonb_build_object(
                 'stubId', s.id::text,
                 'employeePartyId', s.employee_party_id::text,
                 'employmentId', s.employment_id::text,
                 'province', s.province,
                 'country', s.country,
                 'countrySource', s.country_source,
                 'filingAccountId', s.filing_account_id::text,
                 'filingAccountSource', s.filing_account_source,
                 'filingAccountEvidence', s.filing_account_evidence,
                 'periodsPerYear', s.periods_per_year,
                 'payDate', s.pay_date::text,
                 'taxYear', s.tax_year,
                 'currency', s.currency_code,
                 'gross', s.gross::text,
                 'pensionableEarnings', s.pensionable_earnings::text,
                 'insurableEarnings', s.insurable_earnings::text,
                 'netPay', s.net_pay::text,
                 'employerCost', s.employer_cost::text,
                 'vacationAccrued', s.vacation_accrued::text,
                 'federalClaim', s.federal_claim::text,
                 'provincialClaim', s.provincial_claim::text,
                 'factors', s.factors,
                 'paymentMethod', s.payment_method,
                 'chequeNumber', s.cheque_number,
                 'lines', coalesce((
                   select jsonb_agg(line_value order by sequence, line_id)
                     from (
                       select l.sequence, l.id as line_id,
                              jsonb_build_object(
                                'lineId', l.id::text,
                                'stubId', l.stub_id::text,
                                'componentId', l.component_id::text,
                                'kind', l.kind,
                                'description', l.description,
                                'hours', l.hours::text,
                                'derivedQuantity', l.derived_quantity::text,
                                'derivedRuleCode', l.derived_rule_code,
                                'rate', l.rate::text,
                                'amount', l.amount::text,
                                'earnedFrom', l.earned_from::text,
                                'earnedTo', l.earned_to::text,
                                'paymentKind', l.payment_kind,
                                'nonCashAccountId', l.non_cash_account_id::text,
                                'projectId', l.project_id::text,
                                'departmentId', l.department_id::text,
                                'timeTypeId', l.time_type_id::text,
                                'itemId', l.item_id::text,
                                'expenseAccountId', l.expense_account_id::text,
                                'expenseAccountSource', l.expense_account_source,
                                'expenseAccountEvidence', l.expense_account_evidence,
                                'statutoryReportingCode', l.statutory_reporting_code,
                                'remittancePartyId', l.remittance_party_id::text,
                                'liabilityAccountId', l.liability_account_id::text,
                                'liabilityAccountSource', l.liability_account_source,
                                'liabilityAccountEvidence', l.liability_account_evidence,
                                'sequence', l.sequence
                              ) as line_value
                         from pay_stub_lines l
                        where l.org_id = s.org_id and l.stub_id = s.id
                     ) line_rows
                 ), '[]'::jsonb)
               ) as stub_value
          from pay_stubs s
         where s.org_id = r.org_id and s.pay_run_document_id = r.document_id
      ) stub_rows
  ), '[]'::jsonb)`;

const ENTITLEMENT_EVIDENCE = sql`
  coalesce((
    select jsonb_agg(movement_value order by employee_party_id, movement_id)
      from (
        select e.employee_party_id::text as employee_party_id, e.id as movement_id,
               jsonb_build_object(
                 'movementId', e.id::text,
                 'planId', e.plan_id::text,
                 'employeePartyId', e.employee_party_id::text,
                 'employmentId', e.employment_id::text,
                 'movementDate', e.movement_date::text,
                 'amount', e.amount::text,
                 'hours', e.hours::text,
                 'kind', e.kind,
                 'stubLineId', e.stub_line_id::text,
                 'note', e.note,
                 'sourceHolidayKey', e.source_holiday_key,
                 'sourceHolidayDate', e.source_holiday_date::text,
                 'takeOn', e.take_on::text
               ) as movement_value
          from entitlement_ledger e
         where e.org_id = r.org_id and e.pay_run_document_id = r.document_id
      ) movement_rows
  ), '[]'::jsonb)`;

const BENEFIT_ALLOCATION_EVIDENCE = sql`
  coalesce((
    select jsonb_agg(allocation_value order by employee_party_id, allocation_id)
      from (
        select a.employee_party_id::text as employee_party_id, a.id as allocation_id,
               jsonb_build_object(
                 'allocationId', a.id::text,
                 'employmentId', a.employment_id::text,
                 'employeePartyId', a.employee_party_id::text,
                 'enrollmentId', a.enrollment_id::text,
                 'ruleId', a.rule_id::text,
                 'termId', a.term_id::text,
                 'periodFrom', a.period_from::text,
                 'periodTo', a.period_to::text,
                 'amount', a.amount::text,
                 'currency', a.currency,
                 'payStubLineId', a.pay_stub_line_id::text,
                 'status', a.status,
                 'sourceSnapshot', a.source_snapshot
               ) as allocation_value
          from pay_run_benefit_allocations a
         where a.org_id = r.org_id and a.pay_run_document_id = r.document_id
      ) allocation_rows
  ), '[]'::jsonb)`;

/**
 * Read the run's currently persisted calculated result, exactly as stored.
 *
 * Callers invoke this after the run, population and employee-year fences
 * have settled and before the first row of the old result is deleted, and
 * again after the replacement result has been stored and read back. Returns
 * null only when the run itself does not exist in this organization.
 */
export async function capturePayRunCalculationEvidence(
  tx: Runner,
  orgId: string,
  documentId: string,
): Promise<CapturedPayRunCalculationEvidence | null> {
  const main = (
    await tx.execute<{
      runStatus: string;
      calculatedAt: string | null;
      calculationSourceDigest: string | null;
      hasStubs: boolean;
      runText: string;
      stubsText: string;
      entitlementsText: string;
      benefitAllocationsText: string;
    }>(
      sql`
    select r.run_status as "runStatus",
           r.calculated_at::text as "calculatedAt",
           r.calculation_source_digest as "calculationSourceDigest",
           exists (
             select 1 from pay_stubs s
              where s.org_id = r.org_id and s.pay_run_document_id = r.document_id
           ) as "hasStubs",
           (${RUN_EVIDENCE})::text as "runText",
           (${STUB_EVIDENCE})::text as "stubsText",
           (${ENTITLEMENT_EVIDENCE})::text as "entitlementsText",
           (${BENEFIT_ALLOCATION_EVIDENCE})::text as "benefitAllocationsText"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `,
      "objects",
    )
  )[0];
  if (!main) return null;

  let holidayAllocationsText: string;
  {
    const captured = (
      await tx.execute<{ evidence: string }>(
        sql`
      select coalesce((
        select jsonb_agg(allocation_value order by allocation_id)
          from (
            select a.id as allocation_id,
                   jsonb_build_object(
                     'allocationId', a.id::text,
                     'obligationId', a.obligation_id::text,
                     'payStubLineId', a.pay_stub_line_id::text,
                     'componentId', a.component_id::text,
                     'amount', a.amount::text,
                     'hours', a.hours::text,
                     'rate', a.rate::text,
                     'currency', a.currency,
                     'status', a.status,
                     'sourceSnapshot', a.source_snapshot
                   ) as allocation_value
              from pay_run_holiday_allocations a
             where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
          ) allocation_rows
      ), '[]'::jsonb)::text as evidence
    `,
        "objects",
      )
    )[0];
    if (!captured)
      throw new PayrollError(
        "the calculated holiday evidence could not be read — retry the calculation",
      );
    holidayAllocationsText = captured.evidence;
  }

  let compensationCalculationsText: string;
  {
    const captured = (
      await tx.execute<{ evidence: string }>(
        sql`
      select coalesce((
        select jsonb_agg(calculation_value order by calculation_id)
          from (
            select c.id as calculation_id,
                   jsonb_build_object(
                     'calculationId', c.id::text,
                     'assignmentId', c.assignment_id::text,
                     'employmentId', c.employment_id::text,
                     'sourceSnapshot', c.source_snapshot,
                     'resultSnapshot', c.result_snapshot
                   ) as calculation_value
              from payroll_compensation_calculations c
             where c.org_id = ${orgId} and c.pay_run_document_id = ${documentId}
          ) calculation_rows
      ), '[]'::jsonb)::text as evidence
    `,
        "objects",
      )
    )[0];
    if (!captured)
      throw new PayrollError(
        "the calculated compensation evidence could not be read — retry the calculation",
      );
    compensationCalculationsText = captured.evidence;
  }

  return {
    evidence:
      `{"run":${main.runText},"stubs":${main.stubsText},` +
      `"entitlements":${main.entitlementsText},` +
      `"benefitAllocations":${main.benefitAllocationsText},` +
      `"holidayAllocations":${holidayAllocationsText},` +
      `"compensationCalculations":${compensationCalculationsText}}`,
    hasCalculatedResult:
      main.runStatus === "calculated" ||
      main.calculatedAt !== null ||
      main.calculationSourceDigest !== null ||
      main.hasStubs,
    calculationSourceDigest: main.calculationSourceDigest,
  };
}

/**
 * Record the one calculation event for a persisted calculation attempt.
 *
 * The event names the run's document as its audit row, so the ordinary
 * audit views resolve it as a pay_runs record for the run itself. A first
 * calculation records no prior result; a recalculation records the replaced
 * result in full. The write is required: storing no row refuses the
 * calculation, and the surrounding transaction rolls the result back with
 * the event. This records that a calculation was performed and what it
 * produced; it certifies nothing about statutory correctness or payment.
 */
export async function recordPayRunCalculationEvent(
  tx: Runner,
  input: {
    orgId: string;
    documentId: string;
    actorId: string;
    before: CapturedPayRunCalculationEvidence | null;
    after: CapturedPayRunCalculationEvidence;
  },
): Promise<void> {
  const beforeEvidence = input.before?.hasCalculatedResult ? input.before.evidence : null;
  const reason =
    beforeEvidence !== null
      ? "Pay run recalculated: the prior calculated result was replaced by this calculation"
      : "Pay run calculated: the calculated result was recorded";
  const beforeFragment =
    beforeEvidence !== null ? sql`${beforeEvidence}::jsonb` : sql`'null'::jsonb`;
  const inserted = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'pay_runs', ${input.documentId}, 'update',
            jsonb_build_object(
              'operation', 'calculate_pay_run',
              'event', 'pay_run_calculated',
              'reason', ${reason}::text,
              'recalculation', ${beforeEvidence !== null}::boolean,
              'before', ${beforeFragment},
              'after', ${input.after.evidence}::jsonb
            ),
            ${input.actorId})
    returning id
  `,
    "objects",
  );
  if (inserted.length !== 1) {
    throw new PayrollError(
      "the pay run calculation audit event was not recorded — the calculation has been rolled back; retry the calculation",
    );
  }
}
