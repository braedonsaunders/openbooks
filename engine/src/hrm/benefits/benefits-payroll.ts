import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmBenefitsManage } from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import { enrollmentTouchesMonth, monthBounds, monthlyFromBasis, prorateForMonth } from "./benefits-math.ts";
import {
  loadBenefitPlan,
  loadBenefitPlanLevels,
  validateBenefitPlanComponents,
} from "./plans.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";

/**
 * HRM benefit pay-run input generation (HR-8): the HR side of the amount
 * seam. One hrm_benefit_payroll_inputs row per active enrolment per
 * coverage month per kind, with the amount for that month derived from the
 * stored election figures by the plan's basis and proration — never a
 * pay-period computation, never a currency conversion, never a guessed
 * wage or an assumed schedule.
 *
 * Idempotent through the (org, enrollment, kind, coverage_from) unique: a
 * retried month lands on the same rows. A voided month stays voided (the
 * correction path is a new election, whose rows carry a new enrollment);
 * a consumed month is refused by name — HR never rewrites what a run holds.
 * The run-side consumer is the payroll coordinator's (item 57); this module
 * never touches pay-run code or the leave consumer.
 */

export type BenefitPayrollInputKind = "benefit_deduction" | "employer_contribution";
export type BenefitPayrollInputStatus = "pending" | "consumed" | "voided";

export interface BenefitPayrollInputDTO {
  readonly id: string;
  readonly enrollmentId: string;
  readonly employeePartyId: string;
  readonly employmentId: string;
  readonly kind: BenefitPayrollInputKind;
  readonly payComponentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly coverageFrom: string;
  readonly coverageTo: string;
  readonly status: BenefitPayrollInputStatus;
  readonly consumedByRunDocumentId: string | null;
}

const INPUT_COLUMNS = sql`id, enrollment_id as "enrollmentId",
  employee_party_id as "employeePartyId", employment_id as "employmentId",
  kind, pay_component_id as "payComponentId", amount::text as amount,
  currency, coverage_from::text as "coverageFrom", coverage_to::text as "coverageTo",
  status, consumed_by_run_document_id as "consumedByRunDocumentId"`;

function toInputDTO(row: Record<string, unknown>): BenefitPayrollInputDTO {
  const kind = String(row.kind);
  if (kind !== "benefit_deduction" && kind !== "employer_contribution") {
    throw new BenefitsError(
      "REFUSED",
      `benefit payroll input carries unknown kind ${JSON.stringify(kind)} — regenerate the month; HR writes only benefit_deduction and employer_contribution`,
    );
  }
  const status = String(row.status);
  if (status !== "pending" && status !== "consumed" && status !== "voided") {
    throw new BenefitsError("REFUSED", "benefit payroll input carries an unknown status — reload and retry");
  }
  return {
    id: String(row.id),
    enrollmentId: String(row.enrollmentId),
    employeePartyId: String(row.employeePartyId),
    employmentId: String(row.employmentId),
    kind,
    payComponentId: String(row.payComponentId),
    amount: String(row.amount),
    currency: String(row.currency),
    coverageFrom: String(row.coverageFrom).slice(0, 10),
    coverageTo: String(row.coverageTo).slice(0, 10),
    status,
    consumedByRunDocumentId:
      row.consumedByRunDocumentId != null ? String(row.consumedByRunDocumentId) : null,
  };
}

/** Periods per year from the employment's stamped pay schedule. Null = unstamped. */
async function periodsPerYearForEmployment(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<number | null> {
  const rows = (
    await exec.execute<{ periods_per_year: number }>(sql`
      select s.periods_per_year
        from employee_payroll_profiles p
        join pay_schedules s on s.org_id = p.org_id and s.id = p.pay_schedule_id
       where p.org_id = ${orgId} and p.employment_id = ${employmentId}
    `)
  ).rows;
  const value = rows[0]?.periods_per_year;
  return typeof value === "number" ? value : null;
}

async function workerPartyForEmployment(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<string> {
  const row = requireOneRow(
    (
      await exec.execute<{ worker_party_id: string }>(sql`
        select worker_party_id from worker_employments
         where org_id = ${orgId} and id = ${employmentId}
      `)
    ).rows,
    "employment for payroll input generation",
  );
  return String(row.worker_party_id);
}

interface ActiveElection {
  readonly id: string;
  readonly employmentId: string;
  readonly planId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employeeAmountPerPeriod: string | null;
  readonly employerAmountPerPeriod: string | null;
  readonly currency: string;
}

export interface GenerateBenefitPayrollInputsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Coverage month (YYYY-MM). HR names months; payroll allocates them to pay periods. */
  readonly coverageMonth: string;
}

/**
 * Generate one input row per active enrolment touching the coverage month
 * per kind. Returns every row for the month (generated now or idempotently
 * re-read). Refusals: consumed months (name the run), voided months (new
 * election required), percent_of_pay without a run-supplied basis, and
 * per_period without a stamped schedule — all by name, none guessed.
 */
export async function generateBenefitPayrollInputs(
  query: GenerateBenefitPayrollInputsQuery,
): Promise<BenefitPayrollInputDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const month = monthBounds(query.coverageMonth);
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const elections = (
      await db.execute<Record<string, unknown>>(sql`
        select id, employment_id as "employmentId", plan_id as "planId",
               effective_from::text as "effectiveFrom",
               effective_to::text as "effectiveTo",
               employee_amount_per_period::text as "employeeAmountPerPeriod",
               employer_amount_per_period::text as "employerAmountPerPeriod",
               currency
          from hrm_benefit_enrollments
         where org_id = ${orgId} and status = 'active'
           and effective_from <= ${month.to}::date
           and (effective_to is null or effective_to >= ${month.from}::date)
         order by id
      `)
    ).rows;
    const out: BenefitPayrollInputDTO[] = [];
    for (const election of elections) {
      const active: ActiveElection = {
        id: String(election.id),
        employmentId: String(election.employmentId),
        planId: String(election.planId),
        effectiveFrom: String(election.effectiveFrom).slice(0, 10),
        effectiveTo:
          election.effectiveTo != null ? String(election.effectiveTo).slice(0, 10) : null,
        employeeAmountPerPeriod:
          election.employeeAmountPerPeriod != null ? String(election.employeeAmountPerPeriod) : null,
        employerAmountPerPeriod:
          election.employerAmountPerPeriod != null ? String(election.employerAmountPerPeriod) : null,
        currency: String(election.currency),
      };
      if (!enrollmentTouchesMonth(active.effectiveFrom, active.effectiveTo, month)) continue;
      out.push(...(await generateForElection(db, orgId, actorId, active, month)));
    }
    return out;
  });
}

async function generateForElection(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  election: ActiveElection,
  month: { from: string; to: string; days: number },
): Promise<BenefitPayrollInputDTO[]> {
  const plan = await loadBenefitPlan(exec, orgId, election.planId);
  if (election.currency !== plan.currency) {
    throw new BenefitsError(
      "REFUSED",
      `election ${election.id} stores ${election.currency} but plan ${plan.code} now prices ${plan.currency} — HR never converts currency; end this enrolment and elect anew on the ${plan.currency} plan`,
    );
  }
  const levels = await loadBenefitPlanLevels(exec, orgId, election.planId);
  // Component validation on generation (the second half of the ruling):
  // an employer row naming a non-employer_contribution component is
  // refused here even if the plan was mis-saved before this check existed.
  await validateBenefitPlanComponents(exec, orgId, plan, levels);
  const periodsPerYear = await periodsPerYearForEmployment(exec, orgId, election.employmentId);
  const partyId = await workerPartyForEmployment(exec, orgId, election.employmentId);
  const coveredFrom = election.effectiveFrom > month.from ? election.effectiveFrom : month.from;
  const monthEnd = month.to;
  const electionEnd = election.effectiveTo ?? monthEnd;
  const coveredTo = electionEnd < monthEnd ? electionEnd : monthEnd;
  const sides: ReadonlyArray<{
    readonly kind: BenefitPayrollInputKind;
    readonly stored: string | null;
    readonly basis: "per_period" | "per_month" | "per_year" | "percent_of_pay";
    readonly componentId: string | null;
  }> = [
    {
      kind: "benefit_deduction",
      stored: election.employeeAmountPerPeriod,
      basis: plan.employeeCostBasis,
      componentId: plan.employeePayComponentId,
    },
    {
      kind: "employer_contribution",
      stored: election.employerAmountPerPeriod,
      basis: plan.employerCostBasis,
      componentId: plan.employerPayComponentId,
    },
  ];
  const out: BenefitPayrollInputDTO[] = [];
  for (const side of sides) {
    if (side.stored === null) continue;
    if (side.componentId === null) {
      throw new BenefitsError(
        "REFUSED",
        `election ${election.id} owes a ${side.kind} row but plan ${plan.code} names no component for that side — link it in Company setup before generating`,
      );
    }
    const monthly = monthlyFromBasis(side.stored, side.basis, {
      periodsPerYear,
      payBasis: null,
    });
    const amount = prorateForMonth({
      monthlyAmount: monthly,
      prorationBasis: plan.prorationBasis,
      coveredFrom,
      coveredTo,
      month,
    });
    out.push(
      await upsertInputRow(exec, orgId, actorId, {
        enrollmentId: election.id,
        employeePartyId: partyId,
        employmentId: election.employmentId,
        kind: side.kind,
        payComponentId: side.componentId,
        amount,
        currency: election.currency,
        coveredFrom,
        coveredTo,
      }),
    );
  }
  return out;
}

async function upsertInputRow(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  row: {
    readonly enrollmentId: string;
    readonly employeePartyId: string;
    readonly employmentId: string;
    readonly kind: BenefitPayrollInputKind;
    readonly payComponentId: string;
    readonly amount: string;
    readonly currency: string;
    readonly coveredFrom: string;
    readonly coveredTo: string;
  },
): Promise<BenefitPayrollInputDTO> {
  const existing = (
    await exec.execute<Record<string, unknown>>(sql`
      select ${INPUT_COLUMNS} from hrm_benefit_payroll_inputs
       where org_id = ${orgId} and enrollment_id = ${row.enrollmentId}
         and kind = ${row.kind} and coverage_from = ${row.coveredFrom}::date
    `)
  ).rows.map(toInputDTO)[0];
  if (existing) {
    // Voided wins over consumed: a voided-after-consume row carries both,
    // and its answer is always that a voided month stays voided.
    if (existing.status === "voided") {
      throw new BenefitsError(
        "REFUSED",
        `coverage ${row.coveredFrom}..${row.coveredTo} for this enrolment is voided and stays voided — change or end the enrolment and regenerate so the correction carries a new election`,
      );
    }
    if (existing.consumedByRunDocumentId !== null) {
      throw new BenefitsError(
        "REFUSED",
        `coverage ${row.coveredFrom}..${row.coveredTo} for this enrolment is already consumed by pay run ${existing.consumedByRunDocumentId} — recalculate the run; HR never rewrites a consumed month`,
      );
    }
    if (
      existing.amount !== row.amount ||
      existing.payComponentId !== row.payComponentId ||
      existing.currency !== row.currency ||
      existing.coverageTo !== row.coveredTo ||
      existing.employeePartyId !== row.employeePartyId
    ) {
      throw new BenefitsError(
        "REFUSED",
        `a pending input already covers ${row.coveredFrom}..${existing.coverageTo} with a different amount — void it with a reason first, then regenerate`,
      );
    }
    return existing;
  }
  try {
    const inserted = requireOneRow(
      (
        await exec.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_payroll_inputs
            (org_id, enrollment_id, employee_party_id, employment_id, kind,
             pay_component_id, amount, currency, coverage_from, coverage_to,
             created_by, updated_by)
          values (${orgId}, ${row.enrollmentId}, ${row.employeePartyId}, ${row.employmentId},
                  ${row.kind}, ${row.payComponentId}, ${row.amount}, ${row.currency},
                  ${row.coveredFrom}::date, ${row.coveredTo}::date, ${actorId}, ${actorId})
          returning ${INPUT_COLUMNS}
        `)
      ).rows,
      "writing the benefit payroll input",
    );
    return toInputDTO(inserted);
  } catch (error) {
    // A concurrent generation for the same month may win the unique race;
    // re-read and apply the same idempotency rules rather than failing.
    if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
      const raced = (
        await exec.execute<Record<string, unknown>>(sql`
          select ${INPUT_COLUMNS} from hrm_benefit_payroll_inputs
           where org_id = ${orgId} and enrollment_id = ${row.enrollmentId}
             and kind = ${row.kind} and coverage_from = ${row.coveredFrom}::date
        `)
      ).rows.map(toInputDTO)[0];
      if (raced && raced.amount === row.amount && raced.status === "pending") return raced;
    }
    throw error;
  }
}

/**
 * Void an input row with a reason. Voiding never clears
 * consumed_by_run_document_id (storage guard) — a voided-after-consume row
 * is the run's stale-calculation evidence, surfaced by its commit gate.
 */
export async function voidBenefitPayrollInput(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly inputId: string;
  readonly reason: string;
}): Promise<BenefitPayrollInputDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const inputId = requireId(query.inputId, "inputId");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "voiding an input needs a reason — it is the row's evidence");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_payroll_inputs
             set status = 'voided', voided_at = now(), void_reason = ${reason},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${inputId} and status <> 'voided'
          returning ${INPUT_COLUMNS}
        `)
      ).rows,
      "voiding the benefit payroll input",
    );
    return toInputDTO(updated);
  });
}
