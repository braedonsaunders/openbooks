import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

export class LeavePayrollInputError extends PayrollError {
  readonly code = "REFUSED";
}

/**
 * Payroll-side consumer for approved HR leave inputs. HR writes the rows;
 * payroll resolves their effective entitlement destination and consumes them
 * with the employee's stub inside one savepoint.
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
  readonly leaveTypeId: string;
  readonly kind: "payout" | "bank_in";
  readonly absenceDate: string;
  readonly hours: string;
  readonly sourceLeaveRequestId: string;
  readonly status: "pending" | "consumed" | "voided";
  readonly consumedByRunDocumentId: string | null;
  readonly entitlementPlanId: string | null;
  readonly entitlementMappingId: string | null;
  readonly entitlementPlanUpdatedAt: string | null;
}

const INPUT_COLUMNS = sql`id, employee_party_id as "employeePartyId", employment_id as "employmentId",
  leave_type_id as "leaveTypeId",
  kind, absence_date::text as "absenceDate", hours::text as hours,
  source_leave_request_id as "sourceLeaveRequestId", status,
  consumed_by_run_document_id as "consumedByRunDocumentId",
  resolved_entitlement_plan_id as "entitlementPlanId",
  resolved_entitlement_mapping_id as "entitlementMappingId",
  resolved_entitlement_plan_updated_at::text as "entitlementPlanUpdatedAt"`;

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
    throw new LeavePayrollInputError(
      `payroll input ${String(row.id)} carries kind ${JSON.stringify(row.kind)}, which this consumer does not price — ` +
        "declare the kind in the leave payroll-input contract (payout or bank_in) before it can reach a pay run",
    );
  }
  const status = String(row.status);
  if (!INPUT_STATUSES.has(status)) {
    throw new LeavePayrollInputError(
      `payroll input ${String(row.id)} carries status ${JSON.stringify(row.status)}, which this consumer does not know — ` +
        "pending, consumed and voided are the only states a pay run may read",
    );
  }
  return {
    id: String(row.id),
    employeePartyId: String(row.employeePartyId),
    employmentId: String(row.employmentId),
    leaveTypeId: String(row.leaveTypeId),
    kind: kind as LeavePayrollInput["kind"],
    absenceDate: String(row.absenceDate).slice(0, 10),
    hours: String(row.hours),
    sourceLeaveRequestId: String(row.sourceLeaveRequestId),
    status: status as LeavePayrollInput["status"],
    consumedByRunDocumentId:
      row.consumedByRunDocumentId != null ? String(row.consumedByRunDocumentId) : null,
    entitlementPlanId: row.entitlementPlanId != null ? String(row.entitlementPlanId) : null,
    entitlementMappingId:
      row.entitlementMappingId != null ? String(row.entitlementMappingId) : null,
    entitlementPlanUpdatedAt:
      row.entitlementPlanUpdatedAt != null ? String(row.entitlementPlanUpdatedAt) : null,
  };
}

const toInput = readLeavePayrollInputRow;

export function requireBankedLeaveEntitlementPlan(input: {
  absenceDate: string;
  mapping:
    | {
        mapping_id: string;
        is_active: boolean;
        plan_id: string;
        plan_updated_at: string;
        unit: string;
        direction: string;
        system_key: string | null;
        plan_active: boolean;
      }
    | undefined;
}): { planId: string; mappingId: string; planUpdatedAt: string } {
  const mapping = input.mapping;
  if (
    !mapping?.is_active ||
    !mapping.plan_active ||
    mapping.unit !== "hours" ||
    mapping.direction !== "accrue" ||
    mapping.system_key === "vacation"
  ) {
    throw new LeavePayrollInputError(
      `approved banked leave has no effective entitlement mapping on ${input.absenceDate} — open Setup → Workforce → Leave types, add an effective-dated mapping to an active accruing hours plan other than Vacation, then recalculate payroll`,
    );
  }
  return {
    planId: mapping.plan_id,
    mappingId: mapping.mapping_id,
    planUpdatedAt: mapping.plan_updated_at,
  };
}

export interface ConsumeLeavePayrollInputsQuery {
  readonly orgId: string;
  readonly runDocumentId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeePartyIds: readonly string[];
  /** The driver releases all prior rows once, before its per-employee savepoints. */
  readonly releaseExisting?: boolean;
  /** Read-only re-derivation of an already committed run. */
  readonly simulate?: boolean;
}

async function lockLeaveEntitlementMapping(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
): Promise<void> {
  await exec.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${orgId} || ':' || ${leaveTypeId}, 0))
  `);
}

export async function lockLeavePayrollInputSources(
  exec: SqlExecutor,
  orgId: string,
  runDocumentId: string,
): Promise<void> {
  const leaveTypes = await exec.execute<{ leave_type_id: string }>(
    sql`
    select distinct leave_type_id::text as leave_type_id
      from hrm_payroll_inputs
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
     order by leave_type_id
  `,
    "objects",
  );
  for (const row of leaveTypes) await lockLeaveEntitlementMapping(exec, orgId, row.leave_type_id);
  await exec.execute(sql`
    select id from hrm_payroll_inputs
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
     order by id for share
  `);
  await exec.execute(sql`
    select m.id
      from hrm_payroll_inputs i
      join hrm_leave_payroll_entitlement_mappings m
        on m.org_id = i.org_id and m.id = i.resolved_entitlement_mapping_id
      join entitlement_plans p on p.org_id = m.org_id and p.id = m.entitlement_plan_id
     where i.org_id = ${orgId} and i.consumed_by_run_document_id = ${runDocumentId}
     order by i.id, m.effective_from desc
     for share of m, p
  `);
}

async function resolveLeaveEntitlementPlan(
  exec: SqlExecutor,
  input: { orgId: string; leaveTypeId: string; absenceDate: string },
): Promise<{ planId: string; mappingId: string; planUpdatedAt: string }> {
  await lockLeaveEntitlementMapping(exec, input.orgId, input.leaveTypeId);
  const mapping = (
    await exec.execute<{
      mapping_id: string;
      is_active: boolean;
      plan_id: string;
      plan_updated_at: string;
      unit: string;
      direction: string;
      system_key: string | null;
      plan_active: boolean;
    }>(
      sql`
    select m.id::text as mapping_id, m.is_active, m.entitlement_plan_id::text as plan_id,
           p.updated_at::text as plan_updated_at, p.unit, p.direction, p.system_key, p.is_active as plan_active
      from hrm_leave_payroll_entitlement_mappings m
      join entitlement_plans p on p.org_id = m.org_id and p.id = m.entitlement_plan_id
     where m.org_id = ${input.orgId} and m.leave_type_id = ${input.leaveTypeId}
       and m.effective_from <= ${input.absenceDate}::date
     order by m.effective_from desc
     limit 1
     for share of m, p
  `,
      "objects",
    )
  )[0];
  return requireBankedLeaveEntitlementPlan({ absenceDate: input.absenceDate, mapping });
}

/**
 * Mark pending rows with absence_date between periodStart and periodEnd for
 * those parties as consumed by that run, inside the caller's transaction,
 * and return them.
 *
 * Re-consuming for the SAME run is idempotent by default: it first releases
 * that run's own consumed rows, then consumes afresh. The calculation driver
 * releases once before its employee savepoints and opts out here.
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
  if (query.releaseExisting !== false && query.simulate !== true)
    await exec.execute(sql`
    update hrm_payroll_inputs
       set status = 'pending', consumed_by_run_document_id = null, consumed_at = null,
           resolved_entitlement_plan_id = null, resolved_entitlement_mapping_id = null,
           resolved_entitlement_plan_updated_at = null,
           updated_at = now()
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
       and status = 'consumed'
  `);
  // Another run's consumed rows in this scope are never absorbed.
  const foreign = (
    await exec.execute<{ id: string; consumed_by_run_document_id: string }>(
      sql`
    select id, consumed_by_run_document_id from hrm_payroll_inputs
     where org_id = ${orgId} and status = 'consumed'
       and consumed_by_run_document_id <> ${runDocumentId}
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     limit 1
  `,
      "objects",
    )
  )[0];
  if (foreign) {
    throw new LeavePayrollInputError(
      `payroll input ${foreign.id} is already consumed by pay run ${foreign.consumed_by_run_document_id} — release that run's inputs or narrow the period instead of absorbing another run's rows`,
    );
  }
  const pending = await exec.execute<Record<string, unknown>>(
    sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs
     where org_id = ${orgId}
       and (status = 'pending' ${
         query.simulate === true
           ? sql`or (status = 'consumed' and consumed_by_run_document_id = ${runDocumentId})`
           : sql``
       })
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     order by absence_date, employee_party_id
     for update
  `,
    "objects",
  );
  // Party coherence per row: the employment's live worker must still be the
  // party the ledger will read. A merge moved the worker; refuse by name.
  for (const row of pending) {
    const employment = (
      await exec.execute<{ worker_party_id: string }>(
        sql`
      select worker_party_id from worker_employments
       where org_id = ${orgId} and id = ${String(row.employmentId)}
    `,
        "objects",
      )
    )[0];
    if (employment && employment.worker_party_id !== String(row.employeePartyId)) {
      throw new LeavePayrollInputError(
        `payroll input ${String(row.id)} names party ${String(row.employeePartyId)} but its employment now points at party ${employment.worker_party_id} — void the stale row and re-file the request so HR re-resolves the party; the run never re-points it`,
      );
    }
  }
  if (pending.length === 0) return [];
  const prepared: Array<{
    row: Record<string, unknown>;
    plan: { planId: string; mappingId: string; planUpdatedAt: string } | null;
  }> = [];
  for (const row of pending) {
    const plan =
      String(row.kind) === "bank_in"
        ? await resolveLeaveEntitlementPlan(exec, {
            orgId,
            leaveTypeId: String(row.leaveTypeId),
            absenceDate: String(row.absenceDate).slice(0, 10),
          })
        : null;
    if (
      String(row.kind) === "bank_in" &&
      row.status === "consumed" &&
      (String(row.entitlementPlanId ?? "") !== plan?.planId ||
        String(row.entitlementMappingId ?? "") !== plan?.mappingId ||
        String(row.entitlementPlanUpdatedAt ?? "") !== plan?.planUpdatedAt)
    ) {
      throw new LeavePayrollInputError(
        `the effective entitlement destination for approved banked leave changed after this run was calculated — recalculate payroll before committing`,
      );
    }
    prepared.push({ row, plan });
  }
  if (query.simulate !== true) {
    for (const { row, plan } of prepared) {
      const result = await exec.execute<never>(sql`
        update hrm_payroll_inputs
           set status = 'consumed', consumed_by_run_document_id = ${runDocumentId},
               consumed_at = now(), resolved_entitlement_plan_id = ${plan?.planId ?? null},
               resolved_entitlement_mapping_id = ${plan?.mappingId ?? null},
               resolved_entitlement_plan_updated_at = ${plan?.planUpdatedAt ?? null}, updated_at = now()
         where org_id = ${orgId} and id = ${String(row.id)} and status = 'pending'
      `);
      if (result.rowCount !== 1) {
        throw new LeavePayrollInputError(
          `approved leave input ${String(row.id)} changed while payroll was calculating — recalculate the pay run`,
        );
      }
    }
  }
  if (query.simulate === true)
    return prepared.map(({ row, plan }) =>
      toInput({
        ...row,
        entitlementPlanId: plan?.planId ?? row.entitlementPlanId,
        entitlementMappingId: plan?.mappingId ?? row.entitlementMappingId,
        entitlementPlanUpdatedAt: plan?.planUpdatedAt ?? row.entitlementPlanUpdatedAt,
      }),
    );
  const consumed = await exec.execute<Record<string, unknown>>(
    sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
       and status = 'consumed'
       and absence_date >= ${periodStart} and absence_date <= ${periodEnd}
       and employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
     order by absence_date, employee_party_id
  `,
    "objects",
  );
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
  const result = await exec.execute<{ n: string }>(
    sql`
    with released as (
      update hrm_payroll_inputs
       set status = 'pending', consumed_by_run_document_id = null, consumed_at = null,
           resolved_entitlement_plan_id = null, resolved_entitlement_mapping_id = null,
           resolved_entitlement_plan_updated_at = null,
             updated_at = now()
       where org_id = ${query.orgId} and consumed_by_run_document_id = ${query.runDocumentId}
         and status = 'consumed'
      returning id
    )
    select count(*)::text as n from released
  `,
    "objects",
  );
  return Number(result[0]?.n ?? "0");
}

export interface LeavePayrollInputProblem {
  readonly code: "PENDING_INPUTS" | "VOIDED_AFTER_CONSUME" | "MAPPING_CHANGED";
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
  const missingMapping =
    (
      await exec.execute<{ n: number }>(
        sql`
    select count(*)::int as n
      from hrm_payroll_inputs i
      left join lateral (
        select m.id::text as mapping_id, m.entitlement_plan_id, m.is_active,
               p.is_active as plan_active, p.updated_at::text as plan_updated_at,
               p.unit, p.direction, p.system_key
          from hrm_leave_payroll_entitlement_mappings m
          left join entitlement_plans p on p.org_id = m.org_id and p.id = m.entitlement_plan_id
         where m.org_id = i.org_id and m.leave_type_id = i.leave_type_id
           and m.effective_from <= i.absence_date
         order by m.effective_from desc
         limit 1
      ) mapping on true
     where i.org_id = ${query.orgId} and i.status = 'pending' and i.kind = 'bank_in'
       and i.absence_date between ${query.periodStart} and ${query.periodEnd}
       and i.employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
       and (mapping.is_active is distinct from true or mapping.plan_active is distinct from true
         or mapping.unit is distinct from 'hours' or mapping.direction is distinct from 'accrue'
         or mapping.system_key = 'vacation')
  `,
        "objects",
      )
    )[0]?.n ?? 0;
  if (missingMapping > 0) {
    return {
      code: "MAPPING_CHANGED",
      runDocumentId: query.runDocumentId,
      message: `${missingMapping} approved banked leave inputs have no effective entitlement mapping — open Setup → Workforce → Leave types, map each type to an active accruing hours plan other than Vacation, then recalculate payroll`,
    };
  }
  const pending =
    (
      await exec.execute<{ n: number }>(
        sql`
    select count(*)::int as n from hrm_payroll_inputs where ${scope} and status = 'pending'
  `,
        "objects",
      )
    )[0]?.n ?? 0;
  if (pending > 0) {
    return {
      code: "PENDING_INPUTS",
      runDocumentId: query.runDocumentId,
      message: `${pending} leave pay-run inputs are still pending for this period — recalculate the run so every absence day is consumed before committing`,
    };
  }
  // The ordering is the defect: the void must land AFTER the consume for
  // this leg to fire. A void before consume leaves no consumed row behind.
  const voided =
    (
      await exec.execute<{ n: number }>(
        sql`
    select count(*)::int as n from hrm_payroll_inputs
     where ${scope} and status = 'voided' and consumed_by_run_document_id = ${query.runDocumentId}
  `,
        "objects",
      )
    )[0]?.n ?? 0;
  if (voided > 0) {
    return {
      code: "VOIDED_AFTER_CONSUME",
      runDocumentId: query.runDocumentId,
      message: `${voided} leave pay-run inputs consumed by this run were voided after calculation — the calculation is stale; release and recalculate the run so the voided days drop out before committing`,
    };
  }
  const changed =
    (
      await exec.execute<{ n: number }>(
        sql`
    select count(*)::int as n
      from hrm_payroll_inputs i
      left join lateral (
        select m.id::text as mapping_id, m.entitlement_plan_id, m.is_active,
               p.updated_at::text as plan_updated_at, p.is_active as plan_active,
               p.unit, p.direction, p.system_key
          from hrm_leave_payroll_entitlement_mappings m
          left join entitlement_plans p on p.org_id = m.org_id and p.id = m.entitlement_plan_id
         where m.org_id = i.org_id and m.leave_type_id = i.leave_type_id
           and m.effective_from <= i.absence_date
         order by m.effective_from desc
         limit 1
      ) mapping on true
     where i.org_id = ${query.orgId} and i.status = 'consumed'
       and i.consumed_by_run_document_id = ${query.runDocumentId}
       and i.kind = 'bank_in'
       and i.employee_party_id in (
         select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
       )
       and (i.resolved_entitlement_plan_id is null or i.resolved_entitlement_mapping_id is null
         or mapping.is_active is distinct from true
         or mapping.entitlement_plan_id is distinct from i.resolved_entitlement_plan_id
         or mapping.mapping_id is distinct from i.resolved_entitlement_mapping_id::text
         or mapping.plan_updated_at is distinct from i.resolved_entitlement_plan_updated_at::text
         or mapping.plan_active is distinct from true or mapping.unit is distinct from 'hours'
         or mapping.direction is distinct from 'accrue' or mapping.system_key = 'vacation')
  `,
        "objects",
      )
    )[0]?.n ?? 0;
  if (changed > 0) {
    return {
      code: "MAPPING_CHANGED",
      runDocumentId: query.runDocumentId,
      message: `${changed} banked leave entitlement mappings changed after calculation — review the effective Setup mapping and recalculate payroll before committing`,
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
  const rows = await exec.execute<Record<string, unknown>>(
    sql`
    select ${INPUT_COLUMNS} from hrm_payroll_inputs i
     where i.org_id = ${orgId} and i.status = 'consumed'
       and exists (
         select 1 from pay_runs r
           join documents d on d.id = r.document_id and d.org_id = r.org_id
          where r.org_id = ${orgId} and r.document_id = i.consumed_by_run_document_id
            and r.run_status <> 'committed' and d.status <> 'voided'
       )
     order by i.absence_date, i.employee_party_id
  `,
    "objects",
  );
  return rows.map(toInput);
}
