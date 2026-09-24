import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import {
  HrmAuthorizationError,
  requireAggregateBenefitsManage,
  requireHrmBenefitsManage,
  requireHrmBenefitsManageOnEmployment,
} from "../authorization.ts";
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
    // Generation materializes deduction rows per employment, so it reads
    // through the actor's employer lens: out-of-scope enrollments are
    // never generated and never returned. Unrestricted actors (null)
    // keep the full month, dangling employment links included.
    const scope = await requireAggregateBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const elections = (
      await db.execute<Record<string, unknown>>(sql`
        select e.id, e.employment_id as "employmentId", e.plan_id as "planId",
               e.effective_from::text as "effectiveFrom",
               e.effective_to::text as "effectiveTo",
               e.employee_amount_per_period::text as "employeeAmountPerPeriod",
               e.employer_amount_per_period::text as "employerAmountPerPeriod",
               e.currency, emp.employer_subsidiary_id as "employerSubsidiaryId"
          from hrm_benefit_enrollments e
          left join worker_employments emp on emp.org_id = e.org_id and emp.id = e.employment_id
         where e.org_id = ${orgId} and e.status = 'active'
           and e.effective_from <= ${month.to}::date
           and (e.effective_to is null or e.effective_to >= ${month.from}::date)
         order by e.id
      `)
    ).rows.filter(
      (row) =>
        scope === null ||
        (row.employerSubsidiaryId != null && scope.has(String(row.employerSubsidiaryId))),
    );
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

type InputRow = {
  readonly enrollmentId: string;
  readonly employeePartyId: string;
  readonly employmentId: string;
  readonly kind: BenefitPayrollInputKind;
  readonly payComponentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly coveredFrom: string;
  readonly coveredTo: string;
};

async function findInputRow(
  exec: SqlExecutor,
  orgId: string,
  row: Pick<InputRow, "enrollmentId" | "kind" | "coveredFrom">,
): Promise<BenefitPayrollInputDTO | undefined> {
  return (
    await exec.execute<Record<string, unknown>>(sql`
      select ${INPUT_COLUMNS} from hrm_benefit_payroll_inputs
       where org_id = ${orgId} and enrollment_id = ${row.enrollmentId}
         and kind = ${row.kind} and coverage_from = ${row.coveredFrom}::date
    `)
  ).rows.map(toInputDTO)[0];
}

/**
 * The idempotency rules for a month the unique key already covers, applied
 * identically to a pre-existing row and to a concurrent generator's winning
 * row. Every material field is compared — amount, component, currency,
 * coverage end, and both identity columns — so a same-key row with
 * different terms is refused by name instead of silently adopted.
 */
function resolveExistingInputRow(existing: BenefitPayrollInputDTO, row: InputRow): BenefitPayrollInputDTO {
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
  const differing: string[] = [];
  if (existing.amount !== row.amount) differing.push(`amount ${existing.amount} vs ${row.amount}`);
  if (existing.payComponentId !== row.payComponentId) {
    differing.push(`component ${existing.payComponentId} vs ${row.payComponentId}`);
  }
  if (existing.currency !== row.currency) differing.push(`currency ${existing.currency} vs ${row.currency}`);
  if (existing.coverageTo !== row.coveredTo) differing.push(`coverage end ${existing.coverageTo} vs ${row.coveredTo}`);
  if (existing.employeePartyId !== row.employeePartyId) {
    differing.push(`employee ${existing.employeePartyId} vs ${row.employeePartyId}`);
  }
  if (existing.employmentId !== row.employmentId) {
    differing.push(`employment ${existing.employmentId} vs ${row.employmentId}`);
  }
  if (differing.length > 0) {
    throw new BenefitsError(
      "REFUSED",
      `a pending input already covers ${row.coveredFrom}..${existing.coverageTo} with different terms (${differing.join("; ")}) — void it with a reason first, then regenerate`,
    );
  }
  return existing;
}

async function upsertInputRow(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  row: InputRow,
): Promise<BenefitPayrollInputDTO> {
  const existing = await findInputRow(exec, orgId, row);
  if (existing) return resolveExistingInputRow(existing, row);
  // The unique constraint arbitrates concurrent generators: DO NOTHING
  // reports the loser with zero rows instead of a 23505, which would abort
  // this transaction and fail every statement after it (25P02).
  const inserted = (
    await exec.execute<Record<string, unknown>>(sql`
      insert into hrm_benefit_payroll_inputs
        (org_id, enrollment_id, employee_party_id, employment_id, kind,
         pay_component_id, amount, currency, coverage_from, coverage_to,
         created_by, updated_by)
      values (${orgId}, ${row.enrollmentId}, ${row.employeePartyId}, ${row.employmentId},
              ${row.kind}, ${row.payComponentId}, ${row.amount}, ${row.currency},
              ${row.coveredFrom}::date, ${row.coveredTo}::date, ${actorId}, ${actorId})
      on conflict on constraint hrm_benefit_payroll_inputs_enrollment_kind_month_unique do nothing
      returning ${INPUT_COLUMNS}
    `)
  ).rows.map(toInputDTO)[0];
  if (inserted) return inserted;
  // Lost the race (or a row landed between the read and the write):
  // re-read the winner and apply the same full-field rules as above.
  const raced = await findInputRow(exec, orgId, row);
  if (!raced) {
    throw new BenefitsError(
      "REFUSED",
      `the benefit payroll input for ${row.coveredFrom} was not stored and no row covers it — retry the request`,
    );
  }
  return resolveExistingInputRow(raced, row);
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
    // The row is locked first and its employment's employer scope is
    // rechecked inside the write transaction: a B input is
    // indistinguishable from a missing one (uniform NOT_FOUND), so an
    // A-scoped actor can neither void B's inputs nor probe their ids.
    const locked = (
      await db.execute<{ employment_id: string }>(sql`
        select employment_id from hrm_benefit_payroll_inputs
         where org_id = ${orgId} and id = ${inputId} for update`)
    ).rows[0];
    if (!locked) {
      throw new BenefitsError(
        "NOT_FOUND",
        "benefit payroll input is not visible in this organization and legal-entity scope — reload and retry",
      );
    }
    try {
      await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, String(locked.employment_id));
    } catch (error) {
      if (error instanceof HrmAuthorizationError) {
        throw new BenefitsError(
          "NOT_FOUND",
          "benefit payroll input is not visible in this organization and legal-entity scope — reload and retry",
        );
      }
      throw error;
    }
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
