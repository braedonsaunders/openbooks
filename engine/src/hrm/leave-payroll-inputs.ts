import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { LeaveError } from "./leave-errors.ts";

/**
 * HR-side pay-run input queue API (HR-5). HR writes pending rows at approval
 * and reads them here; the pay-run wiring (when to consume, problems-gating
 * the commit) is the payroll coordinator's — this module never touches
 * pay-run code and never writes a ledger movement.
 *
 * Row identity is (org_id, source_leave_request_id, absence_date): one row
 * per absence day, split by the fact across period and tax-year boundaries.
 * HR sends HOURS; the run resolves the rate (there is no amount column).
 * employee_party_id is the key the ledger reads; employment_id is provenance
 * only and the two are never interchangeable.
 */

export interface LeavePayrollInput {
  readonly id: string;
  readonly employeePartyId: string;
  readonly employmentId: string;
  readonly kind: "payout" | "bank_in";
  readonly absenceDate: string;
  readonly hours: string;
  readonly sourceLeaveRequestId: string;
  readonly status: "pending" | "consumed" | "voided";
  readonly consumedByRunDocumentId: string | null;
}

const INPUT_COLUMNS = sql`id, employee_party_id as "employeePartyId", employment_id as "employmentId",
  kind, absence_date::text as "absenceDate", hours::text as hours,
  source_leave_request_id as "sourceLeaveRequestId", status,
  consumed_by_run_document_id as "consumedByRunDocumentId"`;

const INPUT_KINDS: ReadonlySet<string> = new Set(["payout", "bank_in"]);
const INPUT_STATUSES: ReadonlySet<string> = new Set(["pending", "consumed", "voided"]);

/**
 * Read one stored input row into the typed contract. Exhaustive on purpose:
 * a kind or status this module does not know is REFUSED by name, never
 * mapped to a default. The old fallthrough turned every unknown kind into
 * `payout` — and a payout is money to the employee, so a future third leave
 * kind would have become a silent mispayment instead of a loud refusal
 * (packs declare, the generic layer branches on nothing — same doctrine).
 */
export function readLeavePayrollInputRow(row: Record<string, unknown>): LeavePayrollInput {
  const kind = String(row.kind);
  if (!INPUT_KINDS.has(kind)) {
    throw new LeaveError(
      "REFUSED",
      `payroll input ${String(row.id)} carries kind ${JSON.stringify(row.kind)}, which this consumer does not price — ` +
        "declare the kind in the leave payroll-input contract (payout or bank_in) before it can reach a pay run",
    );
  }
  const status = String(row.status);
  if (!INPUT_STATUSES.has(status)) {
    throw new LeaveError(
      "REFUSED",
      `payroll input ${String(row.id)} carries status ${JSON.stringify(row.status)}, which this consumer does not know — ` +
        "pending, consumed and voided are the only states a pay run may read",
    );
  }
  return {
    id: String(row.id),
    employeePartyId: String(row.employeePartyId),
    employmentId: String(row.employmentId),
    kind: kind as LeavePayrollInput["kind"],
    absenceDate: String(row.absenceDate).slice(0, 10),
    hours: String(row.hours),
    sourceLeaveRequestId: String(row.sourceLeaveRequestId),
    status: status as LeavePayrollInput["status"],
    consumedByRunDocumentId: row.consumedByRunDocumentId != null ? String(row.consumedByRunDocumentId) : null,
  };
}

const toInput = readLeavePayrollInputRow;

export interface ConsumeLeavePayrollInputsQuery {
  readonly orgId: string;
  readonly runDocumentId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeePartyIds: readonly string[];
}

/**
 * Mark pending rows with absence_date between periodStart and periodEnd for
 * those parties as consumed by that run, inside the caller's transaction,
 * and return them.
 *
 * Re-consuming for the SAME run is idempotent: it first releases that run's
 * own consumed rows, then consumes afresh, so recalculate is safe to repeat.
 * A row consumed by a DIFFERENT run is refused by name, never absorbed. A
 * row whose employment now points at a different party than
 * employee_party_id is refused by name (a party merge moved the worker; the
 * stale row must be voided and re-filed, never re-pointed silently).
 */
export async function consumeLeavePayrollInputs(
  exec: SqlExecutor,
  query: ConsumeLeavePayrollInputsQuery,
): Promise<LeavePayrollInput[]> {
  const { orgId, runDocumentId, periodStart, periodEnd } = query;
  if (query.employeePartyIds.length === 0) return [];
  // Idempotent recalculate: release this run's own consumed rows first.
  // Voided rows stay voided — release never resurrects one.
  await exec.execute(sql`
    update hrm_payroll_inputs
       set status = 'pending', consumed_by_run_document_id = null, consumed_at = null,
           updated_at = now()
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
       and status = 'consumed'
  `);
  // Another run's consumed rows in this scope are never absorbed.
  const foreign = (await exec.execute<{ id: string; consumed_by_run_document_id: string }>(sql`
    select id, consumed_by_run_document_id from hrm_payroll_inputs
     where org_id = ${orgId} and status = 'consumed'
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     limit 1
  `)).rows[0];
  if (foreign) {
    throw new LeaveError(
      "REFUSED",
      `payroll input ${foreign.id} is already consumed by pay run ${foreign.consumed_by_run_document_id} — release that run's inputs or narrow the period instead of absorbing another run's rows`,
    );
  }
  const pending = (await exec.execute<Record<string, unknown>>(sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs
     where org_id = ${orgId} and status = 'pending'
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     order by absence_date, employee_party_id
     for update
  `)).rows;
  // Party coherence per row: the employment's live worker must still be the
  // party the ledger will read. A merge moved the worker; refuse by name.
  for (const row of pending) {
    const employment = (await exec.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments
       where org_id = ${orgId} and id = ${String(row.employmentId)}
    `)).rows[0];
    if (employment && employment.worker_party_id !== String(row.employeePartyId)) {
      throw new LeaveError(
        "REFUSED",
        `payroll input ${String(row.id)} names party ${String(row.employeePartyId)} but its employment now points at party ${employment.worker_party_id} — void the stale row and re-file the request so HR re-resolves the party; the run never re-points it`,
      );
    }
  }
  if (pending.length === 0) return [];
  const ids = pending.map((row) => String(row.id));
  await exec.execute(sql`
    update hrm_payroll_inputs
       set status = 'consumed', consumed_by_run_document_id = ${runDocumentId},
           consumed_at = now(), updated_at = now()
     where org_id = ${orgId} and status = 'pending'
       and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
  `);
  const consumed = (await exec.execute<Record<string, unknown>>(sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
       and status = 'consumed'
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     order by absence_date, employee_party_id
  `)).rows;
  return consumed.map(toInput);
}

export interface ReleaseLeavePayrollInputsQuery {
  readonly orgId: string;
  readonly runDocumentId: string;
}

/**
 * Return that run's consumed rows to pending. Returns the COUNT — zero is
 * legitimate (nothing to release) and must be distinguishable from failure.
 * Never resurrects a voided row.
 */
export async function releaseLeavePayrollInputs(
  exec: SqlExecutor,
  query: ReleaseLeavePayrollInputsQuery,
): Promise<number> {
  const result = (await exec.execute<{ n: string }>(sql`
    with released as (
      update hrm_payroll_inputs
         set status = 'pending', consumed_by_run_document_id = null, consumed_at = null,
             updated_at = now()
       where org_id = ${query.orgId} and consumed_by_run_document_id = ${query.runDocumentId}
         and status = 'consumed'
      returning id
    )
    select count(*)::text as n from released
  `));
  return Number(result.rows[0]?.n ?? "0");
}

export interface LeavePayrollInputProblem {
  readonly code: "PENDING_INPUTS" | "VOIDED_AFTER_CONSUME";
  readonly runDocumentId: string;
  readonly message: string;
}

export interface LeavePayrollInputProblemsQuery {
  readonly orgId: string;
  readonly runDocumentId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeePartyIds: readonly string[];
}

/**
 * THE commit-gate read: a named refusal or null. It refuses when any PENDING
 * row exists for those parties in the period (calculation missed a day),
 * AND when any row consumed by THIS run is now VOIDED (a request cancelled
 * after calculation: the calculation is stale and the pending-only read
 * cannot see it). Remedy recalculate in both cases, because
 * release-then-reconsume drops the voided row. Voiding never clears
 * consumed_by_run_document_id — the only link back to the stale run — so
 * the voided leg can always name it.
 */
export async function leavePayrollInputProblems(
  exec: SqlExecutor,
  query: LeavePayrollInputProblemsQuery,
): Promise<LeavePayrollInputProblem | null> {
  if (query.employeePartyIds.length === 0) return null;
  const scope = sql`
    org_id = ${query.orgId}
      and absence_date >= ${query.periodStart} and absence_date <= ${query.periodEnd}
      and employee_party_id in (
        select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
      )`;
  const pending = (await exec.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_payroll_inputs where ${scope} and status = 'pending'
  `)).rows[0]?.n ?? 0;
  if (pending > 0) {
    return {
      code: "PENDING_INPUTS",
      runDocumentId: query.runDocumentId,
      message: `${pending} leave pay-run inputs are still pending for this period — recalculate the run so every absence day is consumed before committing`,
    };
  }
  // The ordering is the defect: the void must land AFTER the consume for
  // this leg to fire. A void before consume leaves no consumed row behind.
  const voided = (await exec.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_payroll_inputs
     where ${scope} and status = 'voided' and consumed_by_run_document_id = ${query.runDocumentId}
  `)).rows[0]?.n ?? 0;
  if (voided > 0) {
    return {
      code: "VOIDED_AFTER_CONSUME",
      runDocumentId: query.runDocumentId,
      message: `${voided} leave pay-run inputs consumed by this run were voided after calculation — the calculation is stale; release and recalculate the run so the voided days drop out before committing`,
    };
  }
  return null;
}

/**
 * Rows consumed by a run that is neither committed nor voided
 * (abandonment), surfaced on the HR leave tab so an operator sees rows a
 * dead run is still holding. A live calculation legitimately holds rows —
 * the tab shows them; release or recalculate resolves them.
 */
export async function strandedLeavePayrollInputs(
  exec: SqlExecutor,
  orgId: string,
): Promise<LeavePayrollInput[]> {
  const rows = (await exec.execute<Record<string, unknown>>(sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs i
     where i.org_id = ${orgId} and i.status = 'consumed'
       and exists (
         select 1 from pay_runs r
           join documents d on d.id = r.document_id and d.org_id = r.org_id
          where r.org_id = ${orgId} and r.document_id = i.consumed_by_run_document_id
            and r.run_status <> 'committed' and d.status <> 'voided'
       )
     order by i.absence_date, i.employee_party_id
  `)).rows;
  return rows.map(toInput);
}
