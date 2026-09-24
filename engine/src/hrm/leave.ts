import { sql } from "drizzle-orm";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  checkApprovalIdentitySeparation,
  loadActorPerson,
  loadApprovalPerson,
  requireHrmLeaveApprove,
  requireHrmLeaveManage,
  requireHrmLeaveManageOnEmployment,
  requireOwnEmploymentForRequest,
} from "./authorization.ts";
import { businessToday } from "../platform/business-date.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import { parseCivilDate } from "./temporal.ts";
import {
  cmpHours,
  eachDayOfRange,
  formatCents,
  parseHoursToCents,
  rangesOverlap,
  selectPolicy,
  splitHoursAcrossDays,
  type AccrualRule,
  type CarryoverRule,
} from "./leave-math.ts";
import { LeaveError } from "./leave-errors.ts";
import {
  applicablePolicy,
  policiesInRange,
  policyScopeForEmployment,
  policyToCandidate,
  timeBalanceAsOf,
  type PolicyRow,
  type PolicyScope,
} from "./leave-read.ts";

/**
 * HRM leave and attendance service (HR-5).
 *
 * Leave types, policies, requests, approvals and the absence record are HR
 * records; the payroll entitlement ledger never learns the concept of leave
 * and HR NEVER writes a movement. The only crossing is the pay-run input
 * queue (hrm_payroll_inputs): approve writes one pending row per absence day
 * for payout/bank_in types, and the run reads them when it computes. The
 * pay-run wiring itself is the payroll coordinator's — this module never
 * touches pay-run code.
 *
 * Approval execution stays native: submitLeaveRequest opens the run through
 * the flows planning entrypoint (lazy import — the flows registry loads this
 * service's adapter, so a static import would cycle), and the adapter's
 * releaseApproval calls back into releaseLeaveRequest here, inside the
 * decide savepoint — so a throw rolls the gate flip, the decision, the
 * absences and the payroll inputs back together.
 *
 * Authorization is hardwired to engine/src/hrm/authorization.ts — no caller
 * may supply parties, booleans, or scope. Writes run on the transaction
 * runner so each check and its write are atomic; every conditional write
 * asserts its affected row count (a zero-row write is a refusal, never a
 * success).
 */

export type LeaveRequestStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "cancelled";

export interface LeaveTypeDTO {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly paid: boolean;
  readonly valueCrossing: "none" | "payout" | "bank_in";
  readonly requiresAttachment: boolean;
  readonly isActive: boolean;
}

export interface LeavePolicyDTO {
  readonly id: string;
  readonly leaveTypeId: string;
  readonly appliesTo: { employer_subsidiary_id: string | null; department_id: string | null };
  readonly accrualRule: AccrualRule;
  readonly carryoverRule: CarryoverRule;
  readonly minimumNoticeDays: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
}

export interface LeaveRequestDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly leaveTypeId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly hours: string;
  readonly reason: string | null;
  readonly status: LeaveRequestStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly flowInstanceId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) throw new LeaveError("REFUSED", "orgId must be a non-empty string");
  return orgId;
}

function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) throw new LeaveError("REFUSED", "actorId must be a non-empty string");
  return actorId;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new LeaveError("INVALID_INPUT", `${field} must be a uuid`);
  return value;
}

function requireReason(reason: unknown, what: string): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new LeaveError("INVALID_INPUT", `${what} carries a non-blank reason — record why`);
  }
  return reason.trim();
}

function requireCivilDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw new LeaveError("INVALID_INPUT", `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`);
  try {
    parseCivilDate(value);
    return value;
  } catch {
    throw new LeaveError("INVALID_INPUT", `${field} must be a real YYYY-MM-DD calendar date in years 0001 through 9999`);
  }
}

function requireHours(value: unknown, field: string): string {
  if (typeof value !== "string") throw new LeaveError("INVALID_INPUT", `${field} must be an exact decimal with at most 2 fraction digits`);
  try {
    const cents = parseHoursToCents(value);
    if (cents <= 0n) throw new LeaveError("INVALID_INPUT", `${field} must be greater than zero`);
    return formatCents(cents);
  } catch (error) {
    if (error instanceof LeaveError) throw error;
    throw new LeaveError("INVALID_INPUT", `${field} must be an exact decimal with at most 2 fraction digits`);
  }
}

async function assertHrmEnabled(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new LeaveError("REFUSED", "leave is unavailable while the hrm feature is off — enable it under Company Settings → Features; existing leave data is preserved");
  }
}

type LeaveTypeRow = {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  value_crossing: "none" | "payout" | "bank_in";
  requires_attachment: boolean;
  is_active: boolean;
};

function toTypeDTO(row: LeaveTypeRow): LeaveTypeDTO {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    paid: row.paid,
    valueCrossing: row.value_crossing,
    requiresAttachment: row.requires_attachment,
    isActive: row.is_active,
  };
}

async function loadLeaveType(exec: SqlExecutor, orgId: string, leaveTypeId: string): Promise<LeaveTypeRow> {
  const row = (await exec.execute<LeaveTypeRow>(sql`
    select id, code, name, paid, value_crossing, requires_attachment, is_active
      from hrm_leave_types where org_id = ${orgId} and id = ${leaveTypeId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization.
  if (!row) throw new LeaveError("NOT_FOUND", "leave type not found in this organization — check the type id");
  return row;
}

// --- Leave types and policies (Setup-registry pattern: org configuration) ---

export interface CreateLeaveTypeQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly code: unknown;
  readonly name: unknown;
  readonly paid?: unknown;
  readonly valueCrossing?: unknown;
  readonly requiresAttachment?: unknown;
}

/** Create a leave type. Code is identity and immutable after creation. */
export async function createLeaveType(query: CreateLeaveTypeQuery): Promise<LeaveTypeDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const code = typeof query.code === "string" && query.code.trim().length > 0 ? query.code.trim() : null;
  const name = typeof query.name === "string" && query.name.trim().length > 0 ? query.name.trim() : null;
  if (!code) throw new LeaveError("INVALID_INPUT", "leave type carries a non-blank code — record the code");
  if (!name) throw new LeaveError("INVALID_INPUT", "leave type carries a non-blank name — record the name");
  const valueCrossing = query.valueCrossing ?? "none";
  if (valueCrossing !== "none" && valueCrossing !== "payout" && valueCrossing !== "bank_in") {
    throw new LeaveError("INVALID_INPUT", "value_crossing is one of none, payout, bank_in — there is no taken movement kind");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmLeaveManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const inserted = (await db.execute<LeaveTypeRow>(sql`
      insert into hrm_leave_types (org_id, code, name, paid, value_crossing, requires_attachment, created_by, updated_by)
      values (${orgId}, ${code}, ${name},
              ${query.paid ?? true}, ${valueCrossing}, ${query.requiresAttachment ?? false},
              ${actorId}, ${actorId})
      returning id, code, name, paid, value_crossing, requires_attachment, is_active
    `)).rows[0];
    if (!inserted) throw new LeaveError("REFUSED", "the leave type was not stored — no row was written; retry the request");
    return toTypeDTO(inserted);
  });
}

export interface UpdateLeaveTypeQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly leaveTypeId: string;
  readonly name?: unknown;
  readonly paid?: unknown;
  readonly valueCrossing?: unknown;
  readonly requiresAttachment?: unknown;
  readonly isActive?: unknown;
}

/**
 * Edit a leave type. Code never changes (it is identity — deactivate and
 * create a new code instead). Changing value_crossing while live payroll
 * inputs reference the type is refused: the queue already promised the old
 * crossing to the run.
 */
export async function updateLeaveType(query: UpdateLeaveTypeQuery): Promise<LeaveTypeDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const leaveTypeId = requireId(query.leaveTypeId, "leaveTypeId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmLeaveManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const current = await loadLeaveType(db, orgId, leaveTypeId);
    if (query.valueCrossing !== undefined && query.valueCrossing !== current.value_crossing) {
      if (query.valueCrossing !== "none" && query.valueCrossing !== "payout" && query.valueCrossing !== "bank_in") {
        throw new LeaveError("INVALID_INPUT", "value_crossing is one of none, payout, bank_in — there is no taken movement kind");
      }
      const live = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_payroll_inputs i
          join hrm_leave_requests r on r.id = i.source_leave_request_id and r.org_id = i.org_id
         where i.org_id = ${orgId} and r.leave_type_id = ${leaveTypeId} and i.status <> 'voided'
      `)).rows[0]?.n ?? 0;
      if (live > 0) {
        throw new LeaveError(
          "REFUSED",
          `leave type ${current.code} still feeds ${live} live pay-run input rows — void or consume them before changing what the type raises, or deactivate this type and create a new code instead`,
        );
      }
    }
    const updated = (await db.execute<LeaveTypeRow>(sql`
      update hrm_leave_types
         set name = ${typeof query.name === "string" && query.name.trim().length > 0 ? query.name.trim() : current.name},
             paid = ${query.paid ?? current.paid},
             value_crossing = ${query.valueCrossing ?? current.value_crossing},
             requires_attachment = ${query.requiresAttachment ?? current.requires_attachment},
             is_active = ${query.isActive ?? current.is_active},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${leaveTypeId}
      returning id, code, name, paid, value_crossing, requires_attachment, is_active
    `)).rows[0];
    if (!updated) throw new LeaveError("REFUSED", "the leave type was not stored — no row was written; retry the request");
    return toTypeDTO(updated);
  });
}

function validateAccrualRule(rule: unknown): AccrualRule {
  if (typeof rule !== "object" || rule === null) throw new LeaveError("INVALID_INPUT", "accrual_rule declares kind none, per_period, per_year, or unlimited — record the rule");
  const record = rule as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "none" && kind !== "per_period" && kind !== "per_year" && kind !== "unlimited") {
    throw new LeaveError("INVALID_INPUT", "accrual_rule kind is one of none, per_period, per_year, unlimited — record the rule");
  }
  if (kind === "per_year" || kind === "per_period") {
    if (typeof record.hours !== "string") throw new LeaveError("INVALID_INPUT", `a ${kind} accrual rule must carry hours as an exact decimal — set hours or use kind none`);
    requireHours(record.hours, "accrual_rule.hours");
    if (kind === "per_period") {
      if (!Number.isInteger(record.periods_per_year) || (record.periods_per_year as number) <= 0) {
        throw new LeaveError("INVALID_INPUT", "a per_period accrual rule must carry periods_per_year (a positive integer) — without it a period cannot be pro-rated");
      }
    }
  }
  return record as unknown as AccrualRule;
}

function validateCarryoverRule(rule: unknown): CarryoverRule {
  if (typeof rule !== "object" || rule === null) throw new LeaveError("INVALID_INPUT", "carryover_rule declares kind none, carry_all, or carry_up_to — record the rule");
  const record = rule as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "none" && kind !== "carry_all" && kind !== "carry_up_to") {
    throw new LeaveError("INVALID_INPUT", "carryover_rule kind is one of none, carry_all, carry_up_to — record the rule");
  }
  if (kind === "carry_up_to") {
    if (typeof record.hours !== "string") throw new LeaveError("INVALID_INPUT", "a carry_up_to rule must carry hours — set the cap or use kind carry_all");
    requireHours(record.hours, "carryover_rule.hours");
  }
  if (record.expires_after_days !== undefined && record.expires_after_days !== null) {
    if (!Number.isInteger(record.expires_after_days) || (record.expires_after_days as number) < 0) {
      throw new LeaveError("INVALID_INPUT", "carryover expires_after_days is a non-negative integer of days — record the expiry");
    }
  }
  return record as unknown as CarryoverRule;
}

function validateAppliesTo(value: unknown): { employer_subsidiary_id: string | null; department_id: string | null } {
  if (typeof value !== "object" || value === null) {
    throw new LeaveError("INVALID_INPUT", "applies_to scopes by employer_subsidiary_id and department_id, each a uuid or null for org-wide — record the scope");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["employer_subsidiary_id", "department_id"] as const) {
    const entry = record[key];
    if (entry !== null && entry !== undefined && (typeof entry !== "string" || !UUID_RE.test(entry))) {
      throw new LeaveError("INVALID_INPUT", `applies_to.${key} is a uuid or null for org-wide — record the scope`);
    }
  }
  return {
    employer_subsidiary_id: (record.employer_subsidiary_id as string | null) ?? null,
    department_id: (record.department_id as string | null) ?? null,
  };
}

function toPolicyDTO(row: PolicyRow): LeavePolicyDTO {
  return {
    id: row.id,
    leaveTypeId: row.leave_type_id,
    appliesTo: row.applies_to,
    accrualRule: row.accrual_rule,
    carryoverRule: row.carryover_rule,
    minimumNoticeDays: row.minimum_notice_days,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    isActive: row.is_active,
  };
}

export interface CreateLeavePolicyQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly leaveTypeId: string;
  readonly appliesTo?: unknown;
  readonly accrualRule?: unknown;
  readonly carryoverRule?: unknown;
  readonly minimumNoticeDays?: unknown;
  readonly effectiveFrom: unknown;
  readonly effectiveTo?: unknown;
}

/** Create a leave policy: HR entitlement in TIME, effective-dated. */
export async function createLeavePolicy(query: CreateLeavePolicyQuery): Promise<LeavePolicyDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const leaveTypeId = requireId(query.leaveTypeId, "leaveTypeId");
  const appliesTo = validateAppliesTo(query.appliesTo ?? { employer_subsidiary_id: null, department_id: null });
  const accrualRule = validateAccrualRule(query.accrualRule ?? { kind: "none" });
  const carryoverRule = validateCarryoverRule(query.carryoverRule ?? { kind: "none" });
  const effectiveFrom = requireCivilDate(query.effectiveFrom, "effectiveFrom");
  const effectiveTo = query.effectiveTo === undefined || query.effectiveTo === null ? null : requireCivilDate(query.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new LeaveError("INVALID_INPUT", `effective end ${effectiveTo} must not precede start ${effectiveFrom} — close the old policy and open a new one instead`);
  }
  const notice = query.minimumNoticeDays ?? 0;
  if (!Number.isInteger(notice) || (notice as number) < 0) throw new LeaveError("INVALID_INPUT", "minimum_notice_days is a non-negative integer of days — record the notice");
  return withOrgTransaction(orgId, async () => {
    await requireHrmLeaveManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const type = await loadLeaveType(db, orgId, leaveTypeId);
    if (!type.is_active) throw new LeaveError("REFUSED", `leave type ${type.code} is inactive — reactivate it before adding a policy`);
    await assertNoSameScopeOverlap(db, orgId, leaveTypeId, appliesTo, effectiveFrom, effectiveTo);
    let inserted: PolicyRow | undefined;
    try {
      inserted = (await db.execute<PolicyRow>(sql`
        insert into hrm_leave_policies (org_id, leave_type_id, applies_to, accrual_rule, carryover_rule,
          minimum_notice_days, effective_from, effective_to, created_by, updated_by)
        values (${orgId}, ${leaveTypeId}, ${JSON.stringify(appliesTo)}::jsonb,
                ${JSON.stringify(accrualRule)}::jsonb, ${JSON.stringify(carryoverRule)}::jsonb,
                ${notice}, ${effectiveFrom}, ${effectiveTo}, ${actorId}, ${actorId})
        returning id, leave_type_id, applies_to, accrual_rule, carryover_rule,
          minimum_notice_days, effective_from::text as effective_from, effective_to::text as effective_to, is_active
      `)).rows[0];
    } catch (error) {
      // A concurrent create landing first hits the storage exclusion: name
      // the overlap instead of leaking a PG exclusion code. db.execute
      // wraps the PG error in a DrizzleQueryError, so the code rides on
      // cause — checking only the outer code would drop this refusal.
      const pgCode =
        typeof error === "object" && error !== null
          ? ((error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code)
          : undefined;
      if (pgCode === "23P01") {
        throw new LeaveError(
          "REFUSED",
          `another policy now covers this leave type and scope over ${effectiveFrom} to ${effectiveTo ?? "open"} — reload the policy list and close the overlapping window (set its effective_to) before opening this one`,
        );
      }
      throw error;
    }
    if (!inserted) throw new LeaveError("REFUSED", "the leave policy was not stored — no row was written; retry the request");
    return toPolicyDTO(inserted);
  });
}

/**
 * Same-scope overlap preflight for policy windows: one active window per
 * (org, leave type, scope pins). Overlapping same-scope policies resolved
 * arbitrarily at read time, so the create is refused with the conflicting
 * window and the remedy. The storage exclusion (0266) arbitrates the
 * concurrent-writer race and backstops the Setup drawer's in-place edits,
 * which surface through the shared 409 overlap mapping, never raw PG text.
 */
async function assertNoSameScopeOverlap(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
  appliesTo: { employer_subsidiary_id: string | null; department_id: string | null },
  effectiveFrom: string,
  effectiveTo: string | null,
): Promise<void> {
  const clash = (await exec.execute<{ id: string; effective_from: string; effective_to: string | null }>(sql`
    select id, effective_from::text as effective_from, effective_to::text as effective_to
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active
       and coalesce(applies_employer_subsidiary_id::text, '') = coalesce(${appliesTo.employer_subsidiary_id}::text, '')
       and coalesce(applies_department_id::text, '') = coalesce(${appliesTo.department_id}::text, '')
       and effective_from <= ${effectiveTo ?? "9999-12-31"}
       and (effective_to is null or effective_to >= ${effectiveFrom})
     limit 1
  `)).rows[0];
  if (clash) {
    const window = `${String(clash.effective_from).slice(0, 10)} to ${clash.effective_to ? String(clash.effective_to).slice(0, 10) : "open"}`;
    throw new LeaveError(
      "REFUSED",
      `policy ${clash.id} already covers this leave type and scope over ${window} — close that window (set its effective_to before ${effectiveFrom}) or deactivate it before opening ${effectiveFrom} to ${effectiveTo ?? "open"}`,
    );
  }
}

// --- Request lifecycle ------------------------------------------------------

type RequestRow = {
  id: string;
  employment_id: string;
  leave_type_id: string;
  starts_on: string;
  ends_on: string;
  hours: string;
  reason: string | null;
  status: LeaveRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  flow_instance_id: string | null;
  attachment_id: string | null;
  created_by: string | null;
};

const REQUEST_COLUMNS = sql`id, employment_id, leave_type_id,
  starts_on::text as starts_on, ends_on::text as ends_on, hours::text as hours,
  reason, status, decided_by, decided_at::text as decided_at, decision_reason,
  flow_instance_id, attachment_id, created_by`;

function toRequestDTO(row: RequestRow): LeaveRequestDTO {
  return {
    id: row.id,
    employmentId: row.employment_id,
    leaveTypeId: row.leave_type_id,
    startsOn: String(row.starts_on).slice(0, 10),
    endsOn: String(row.ends_on).slice(0, 10),
    hours: String(row.hours),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decisionReason: row.decision_reason,
    flowInstanceId: row.flow_instance_id,
  };
}

async function loadRequestForUpdate(exec: SqlExecutor, orgId: string, requestId: string): Promise<RequestRow> {
  const row = (await exec.execute<RequestRow>(sql`
    select ${REQUEST_COLUMNS} from hrm_leave_requests
     where org_id = ${orgId} and id = ${requestId} for update
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement — never report
  // which of the two, so existence cannot be probed across tenants).
  if (!row) throw new LeaveError("NOT_FOUND", "leave request not found in this organization — check the request id");
  return row;
}

/**
 * Live employment versions (recorded_until IS NULL) for the range check.
 * A day counts as live employment only under status active or on_leave —
 * offered is a future engagement and suspended/terminated are not service.
 */
async function liveEmploymentDays(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  startsOn: string,
  endsOn: string,
): Promise<Set<string>> {
  const rows = (await exec.execute<{ effective_from: string; effective_to: string | null; status: string }>(sql`
    select effective_from::text as effective_from, effective_to::text as effective_to, status
      from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
  `)).rows;
  const live = new Set<string>();
  for (const day of eachDayOfRange(startsOn, endsOn)) {
    for (const version of rows) {
      const to = version.effective_to ? String(version.effective_to).slice(0, 10) : null;
      const from = String(version.effective_from).slice(0, 10);
      if ((version.status === "active" || version.status === "on_leave") && from <= day && (to === null || day < to)) {
        live.add(day);
        break;
      }
    }
  }
  return live;
}

async function assertLiveEmploymentRange(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  startsOn: string,
  endsOn: string,
): Promise<void> {
  const live = await liveEmploymentDays(exec, orgId, employmentId, startsOn, endsOn);
  const missing = eachDayOfRange(startsOn, endsOn).filter((day) => !live.has(day));
  if (missing.length > 0) {
    throw new LeaveError(
      "REFUSED",
      `leave ${startsOn} to ${endsOn} falls outside live employment on ${missing[0]} — file only days the employment is active or on leave`,
    );
  }
}

async function assertNoApprovedOverlap(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  startsOn: string,
  endsOn: string,
  ignoreRequestId: string | null,
): Promise<void> {
  const rows = (await exec.execute<{ id: string; starts_on: string; ends_on: string }>(sql`
    select id, starts_on::text as starts_on, ends_on::text as ends_on
      from hrm_leave_requests
     where org_id = ${orgId} and employment_id = ${employmentId} and status = 'approved'
       and (${ignoreRequestId}::uuid is null or id <> ${ignoreRequestId}::uuid)
  `)).rows;
  for (const row of rows) {
    const from = String(row.starts_on).slice(0, 10);
    const to = String(row.ends_on).slice(0, 10);
    if (rangesOverlap(startsOn, endsOn, from, to)) {
      throw new LeaveError(
        "REFUSED",
        `leave ${startsOn} to ${endsOn} overlaps approved request ${row.id} (${from} to ${to}) — withdraw or cancel that request first, or file the non-overlapping days`,
      );
    }
  }
}

async function assertTimeBalance(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
  scope: PolicyScope,
  startsOn: string,
  endsOn: string,
  hours: string,
): Promise<void> {
  // Coverage is per day, never per request: a policy ending mid-range must
  // not smuggle the uncovered tail through on the first day's rule, and a
  // stricter successor must price the days it governs. One range query plus
  // the pure precedence sort — no per-day round trips.
  const rows = await policiesInRange(exec, orgId, leaveTypeId, startsOn, endsOn);
  const candidates = rows.map(policyToCandidate);
  let allUnlimited = true;
  for (const day of eachDayOfRange(startsOn, endsOn)) {
    const pick = selectPolicy(candidates, scope, day);
    // No policy declares no entitlement: fail closed by name, never accrue zero.
    if (!pick) {
      throw new LeaveError(
        "REFUSED",
        `no active leave policy covers ${day} of the requested ${startsOn} to ${endsOn} — create a policy for this type and scope covering ${day} before filing`,
      );
    }
    const governing = rows.find((row) => row.id === pick.id);
    if (!governing || (governing.accrual_rule as AccrualRule).kind !== "unlimited") {
      allUnlimited = false;
    }
  }
  if (allUnlimited) return;
  // The check reads through timeBalanceAsOf — the same function the drawer
  // displays — so the gate and the balance can never disagree. Read as of
  // the range end so accrual vesting inside the range (a successor's slice
  // covering the tail) counts toward the request it covers.
  const read = await timeBalanceAsOf(exec, orgId, scope.employmentId, leaveTypeId, endsOn);
  if (read.balance === null) return;
  if (cmpHours(read.balance, hours) < 0) {
    throw new LeaveError(
      "REFUSED",
      `policy time balance is ${read.balance} hours but the request needs ${hours} — shorten the request or record the absence unpaid`,
    );
  }
}

async function requireFileAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  onBehalf: boolean,
) {
  return onBehalf
    ? requireHrmLeaveManageOnEmployment(exec, orgId, actorId, employmentId)
    : requireOwnEmploymentForRequest(exec, orgId, actorId, employmentId);
}

export interface FileLeaveRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly leaveTypeId: string;
  readonly startsOn: unknown;
  readonly endsOn: unknown;
  readonly hours: unknown;
  readonly reason?: unknown;
  /** True when a manager files for another worker (manage + reason). */
  readonly onBehalf?: boolean;
}

/**
 * File a draft leave request. Self-service files only against the actor's
 * own employment; a manager files on behalf with a reason. Every refusal
 * below re-runs at submit: a draft is a parking spot, never a promise.
 */
export async function fileLeaveRequest(query: FileLeaveRequestQuery): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const leaveTypeId = requireId(query.leaveTypeId, "leaveTypeId");
  const startsOn = requireCivilDate(query.startsOn, "startsOn");
  const endsOn = requireCivilDate(query.endsOn, "endsOn");
  if (endsOn < startsOn) throw new LeaveError("INVALID_INPUT", `effective end ${endsOn} must not precede start ${startsOn} — file the range forward`);
  const hours = requireHours(query.hours, "hours");
  const reason = query.reason === undefined || query.reason === null ? null : requireReason(query.reason, "a leave request");
  if (query.onBehalf && reason === null) {
    throw new LeaveError("INVALID_INPUT", "filing on behalf carries a non-blank reason — record why the manager files for the worker");
  }
  return withOrgTransaction(orgId, async () => {
    await requireFileAccess(db, orgId, actorId, employmentId, query.onBehalf === true);
    await assertHrmEnabled(db, orgId);
    const type = await loadLeaveType(db, orgId, leaveTypeId);
    if (!type.is_active) throw new LeaveError("REFUSED", `leave type ${type.code} is inactive — reactivate it before filing`);
    await assertLiveEmploymentRange(db, orgId, employmentId, startsOn, endsOn);
    await assertNoApprovedOverlap(db, orgId, employmentId, startsOn, endsOn, null);
    // The gates resolve scope the same way the balance display does —
    // subsidiary from the employment, department from the primary
    // assignment — never a hardcoded null department.
    const scope = await policyScopeForEmployment(db, orgId, employmentId, startsOn);
    await assertTimeBalance(db, orgId, leaveTypeId, scope, startsOn, endsOn, hours);
    await assertNotice(db, orgId, leaveTypeId, scope, startsOn, query.onBehalf === true, reason);
    const inserted = (await db.execute<RequestRow>(sql`
      insert into hrm_leave_requests (org_id, employment_id, leave_type_id, starts_on, ends_on,
        hours, reason, status, created_by, updated_by)
      values (${orgId}, ${employmentId}, ${leaveTypeId}, ${startsOn}, ${endsOn},
        ${hours}, ${reason}, 'draft', ${actorId}, ${actorId})
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!inserted) throw new LeaveError("REFUSED", "the leave request was not stored — no row was written; retry the request");
    return toRequestDTO(inserted);
  });
}

async function assertNotice(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
  scope: PolicyScope,
  startsOn: string,
  onBehalf: boolean,
  reason: string | null,
): Promise<void> {
  const policy = await applicablePolicy(exec, orgId, leaveTypeId, scope, startsOn);
  const required = policy?.minimum_notice_days ?? 0;
  if (required <= 0) return;
  const today = await businessToday(orgId);
  if (startsOn <= today) {
    if (!(onBehalf && reason !== null)) {
      throw new LeaveError(
        "REFUSED",
        `this leave needs ${required} days notice but starts ${startsOn} — ask a manager holding hrm.leave.manage to file on your behalf with a reason`,
      );
    }
    return;
  }
  const noticeDays = eachDayOfRange(today, startsOn).length - 1;
  if (noticeDays < required && !(onBehalf && reason !== null)) {
    throw new LeaveError(
      "REFUSED",
      `this leave needs ${required} days notice but only ${noticeDays} remain before ${startsOn} — ask a manager holding hrm.leave.manage to file on your behalf with a reason`,
    );
  }
}

export interface SubmitLeaveRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
}

/**
 * Submit a draft for governed approval. Opens the native approval run
 * through the flows planning entrypoint (lazy import: the flows registry
 * loads this service's adapter, so a static import would cycle). A request
 * no enabled flow gates is refused with the configuration remedy — never
 * auto-approved. All filing validations re-run: a draft is a parking spot,
 * never a promise.
 */
export async function submitLeaveRequest(query: SubmitLeaveRequestQuery): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    const onBehalf = current.created_by !== null && current.created_by !== actorId;
    await requireFileAccess(db, orgId, actorId, current.employment_id, onBehalf);
    if (current.status !== "draft") {
      throw new LeaveError("BAD_STATE", `a ${current.status} request cannot be submitted — only drafts submit`);
    }
    const type = await loadLeaveType(db, orgId, current.leave_type_id);
    if (!type.is_active) throw new LeaveError("REFUSED", `leave type ${type.code} is inactive — reactivate it before submitting`);
    if (type.requires_attachment && !current.attachment_id) {
      throw new LeaveError("REFUSED", `leave type ${type.code} requires an attachment — attach the evidence before submitting`);
    }
    const startsOn = String(current.starts_on).slice(0, 10);
    const endsOn = String(current.ends_on).slice(0, 10);
    await assertLiveEmploymentRange(db, orgId, current.employment_id, startsOn, endsOn);
    await assertNoApprovedOverlap(db, orgId, current.employment_id, startsOn, endsOn, requestId);
    const scope = await policyScopeForEmployment(db, orgId, current.employment_id, startsOn);
    await assertTimeBalance(db, orgId, current.leave_type_id, scope, startsOn, endsOn, String(current.hours));
    await assertNotice(db, orgId, current.leave_type_id, scope, startsOn, onBehalf, current.reason);

    // Lazy: engine/src/flows/run.ts → registry → this service's adapter.
    const { runRecordFlows } = await import("../flows/run.ts");
    const flowResult = await runRecordFlows(
      { kind: "on_submit", source: "api" },
      HRM_LEAVE_REQUEST_SUBJECT_KIND,
      requestId,
      { orgId, userId: actorId },
    );
    const gatedRun = flowResult.runs.find((run) => run.gatesCreated > 0);
    if (flowResult.failed || !gatedRun) {
      const strayRunIds = flowResult.runs.map((run) => run.runId);
      if (strayRunIds.length > 0) {
        await db.execute(sql`
          update flow_gates set status = 'cancelled', updated_at = now()
           where run_id in (
             select jsonb_array_elements_text(${JSON.stringify(strayRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('pending', 'escalated')
        `);
        await db.execute(sql`
          update flow_runs set status = 'cancelled', finished_at = now()
           where id in (
             select jsonb_array_elements_text(${JSON.stringify(strayRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('running', 'waiting')
        `);
      }
      if (flowResult.failed) {
        throw new LeaveError("FLOW_ERROR", "approval routing failed for this leave — fix the approval flow, then submit again");
      }
      throw new LeaveError("NO_FLOW", "no enabled approval flow produced an approval gate for leave requests — configure a flow for leave requests before submitting");
    }
    const submitted = (await db.execute<RequestRow>(sql`
      update hrm_leave_requests
         set status = 'submitted', flow_instance_id = ${gatedRun.runId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'draft'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!submitted) {
      throw new LeaveError("BAD_STATE", "the request changed while submission was being recorded — reload it and submit again");
    }
    return toRequestDTO(submitted);
  });
}

/** Record the attachment a requires_attachment type demands (draft only). */
export async function recordLeaveAttachment(query: { orgId: string; actorId: string; requestId: string; attachmentId: unknown }): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const attachmentId = requireId(query.attachmentId, "attachmentId");
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    const onBehalf = current.created_by !== null && current.created_by !== actorId;
    await requireFileAccess(db, orgId, actorId, current.employment_id, onBehalf);
    if (current.status !== "draft") {
      throw new LeaveError("BAD_STATE", `a ${current.status} request is frozen — file a new request for a revised proposal instead`);
    }
    const updated = (await db.execute<RequestRow>(sql`
      update hrm_leave_requests
         set attachment_id = ${attachmentId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'draft'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!updated) throw new LeaveError("REFUSED", "the attachment was not recorded — no row was written; retry the request");
    return toRequestDTO(updated);
  });
}

export interface WithdrawLeaveRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly reason: unknown;
}

/**
 * Withdraw a draft or a submitted request. Approved requests never
 * withdraw — they cancel, which reverses absences and voids inputs.
 */
export async function withdrawLeaveRequest(query: WithdrawLeaveRequestQuery): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const reason = requireReason(query.reason, "a withdrawal");
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    const onBehalf = current.created_by !== null && current.created_by !== actorId;
    await requireFileAccess(db, orgId, actorId, current.employment_id, onBehalf);
    if (current.status !== "draft" && current.status !== "submitted") {
      throw new LeaveError("BAD_STATE", `a ${current.status} request cannot be withdrawn — cancel it instead`);
    }
    if (current.status === "submitted" && current.flow_instance_id) {
      await db.execute(sql`
        update flow_gates set status = 'cancelled', updated_at = now()
         where run_id = ${current.flow_instance_id} and org_id = ${orgId}
           and status in ('pending', 'escalated')
      `);
      await db.execute(sql`
        update flow_runs set status = 'cancelled', finished_at = now()
         where id = ${current.flow_instance_id} and org_id = ${orgId}
           and status in ('running', 'waiting')
      `);
    }
    // The withdrawal reason is audit evidence on the terminal row.
    const withdrawn = (await db.execute<RequestRow>(sql`
      update hrm_leave_requests
         set status = 'withdrawn', decision_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = ${current.status}
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!withdrawn) throw new LeaveError("BAD_STATE", "the request changed while withdrawal was being recorded — reload it and try again");
    return toRequestDTO(withdrawn);
  });
}

// --- Decision (Flows release path) ------------------------------------------

export interface ReleaseLeaveRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly outcome: "approved" | "rejected";
  readonly comment: unknown;
}

export type CommittedRunCover = {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};

/**
 * A COMMITTED run covering one party-day — queried the way the run itself
 * tests containment (period_start <= day and period_end >= day), scoped to
 * the party through its stubs. HR never computes period boundaries; it asks
 * the run rows. A voided document's run is history undone, never cover.
 */
export async function committedRunCoveringDay(
  exec: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  day: string,
): Promise<CommittedRunCover | null> {
  const row = (await exec.execute<CommittedRunCover>(sql`
    select r.document_id as "documentId", d.document_number as "documentNumber",
           r.period_start::text as "periodStart", r.period_end::text as "periodEnd"
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join pay_stubs s on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
                      and s.employee_party_id = ${employeePartyId}
     where r.org_id = ${orgId} and r.run_status = 'committed' and d.status <> 'voided'
       and r.period_start <= ${day} and r.period_end >= ${day}
     limit 1
  `)).rows[0];
  if (!row) return null;
  return {
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    periodStart: String(row.periodStart).slice(0, 10),
    periodEnd: String(row.periodEnd).slice(0, 10),
  };
}

/**
 * Release a submitted request from the Flows decide savepoint. Approve
 * writes the absences and, when the type crosses value, the pending payroll
 * inputs in ONE transaction with the status flip — absences plus inputs or
 * nothing. withOrgTransaction joins the caller's ambient tenant transaction
 * (the decide savepoint) instead of opening a nested one, so everything
 * below commits or rolls back with the decision.
 */
export async function releaseLeaveRequest(query: ReleaseLeaveRequestQuery): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  if (query.outcome !== "approved" && query.outcome !== "rejected") {
    throw new LeaveError("INVALID_INPUT", "outcome is approved or rejected — there is no third decision");
  }
  const comment = requireReason(query.comment, `a ${query.outcome} decision`);
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    if (current.status !== "submitted") {
      throw new LeaveError("BAD_STATE", `a ${current.status} request cannot be decided — only submitted requests decide`);
    }
    // Permission/scope half over the trusted subject loaded in-transaction.
    const subject = await requireHrmLeaveApprove(db, orgId, actorId, current.employment_id);
    // Identity half over trusted-DB-loaded parties.
    const approver = await loadActorPerson(db, orgId, actorId);
    if (!approver.partyId) {
      throw new LeaveError(
        "REFUSED",
        "leave approval refused: the approver has no linked person — link the approver to a person in Admin → Users → Link person before they decide",
      );
    }
    // No submitter, no decision: without submission evidence the
    // independence legs cannot be evaluated, and no protection may be implied.
    if (!current.created_by) {
      throw new LeaveError(
        "REFUSED",
        "this submitted request carries no submission evidence — withdraw it and file a new request",
      );
    }
    const submitter = await loadApprovalPerson(db, orgId, current.created_by);
    checkApprovalIdentitySeparation({ approver, submitter, subjectWorkerPartyId: subject.workerPartyId });
    const startsOn = String(current.starts_on).slice(0, 10);
    const endsOn = String(current.ends_on).slice(0, 10);
    if (query.outcome === "approved") {
      // Serialize decisions against one entitlement: row locks are per
      // request, so without this two concurrent approvals both read the
      // pre-approval balance and both commit, spending the entitlement
      // twice. The lock is transaction-scoped (released on commit or
      // rollback) and the wait is bounded by the statement timeout.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"leave-balance:" + orgId + ":" + current.employment_id + ":" + current.leave_type_id}, 0))`,
      );
      // Re-read the balance under the lock: a decision that landed first
      // has committed its absences (READ COMMITTED), so the loser sees the
      // spent entitlement and refuses instead of overspending it. The
      // request itself is excluded structurally — its absences are written
      // after this gate, so there is nothing of its own to count.
      const scope = await policyScopeForEmployment(db, orgId, current.employment_id, startsOn);
      await assertTimeBalance(db, orgId, current.leave_type_id, scope, startsOn, endsOn, String(current.hours));
    }
    const decided = (await db.execute<RequestRow>(sql`
      update hrm_leave_requests
         set status = ${query.outcome}, decided_by = ${actorId}, decided_at = now(),
             decision_reason = ${comment}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'submitted'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!decided) {
      throw new LeaveError("BAD_STATE", "the request changed while the decision was being recorded — reload it and decide again");
    }
    if (query.outcome === "rejected") return toRequestDTO(decided);
    try {
      await writeApprovalEffects(db, orgId, actorId, decided, subject.workerPartyId);
    } catch (error) {
      // A concurrent approval landing first hits the storage exclusion: name
      // the overlap instead of leaking a PG exclusion code. db.execute
      // wraps the PG error in a DrizzleQueryError, so the code rides on
      // cause — checking only the outer code would drop this refusal.
      const pgCode =
        typeof error === "object" && error !== null
          ? ((error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code)
          : undefined;
      if (pgCode === "23P01") {
        throw new LeaveError(
          "REFUSED",
          "another approved request now overlaps this range — reload the calendar and file the non-overlapping days",
        );
      }
      throw error;
    }
    return toRequestDTO(decided);
  });
}

/**
 * Approval effects, inside the decision transaction: absence rows plus
 * payroll inputs, or nothing. Days covered by a COMMITTED run refuse with
 * the retro remedy; days covered by a calculated-but-uncommitted run are
 * written pending and the commit gate catches them.
 */
async function writeApprovalEffects(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  request: RequestRow,
  workerPartyId: string,
): Promise<void> {
  const startsOn = String(request.starts_on).slice(0, 10);
  const endsOn = String(request.ends_on).slice(0, 10);
  const days = eachDayOfRange(startsOn, endsOn);
  const type = await loadLeaveType(exec, orgId, request.leave_type_id);
  for (const day of days) {
    const cover = await committedRunCoveringDay(exec, orgId, workerPartyId, day);
    if (cover) {
      throw new LeaveError(
        "STALE_RUN",
        `absence day ${day} is already covered by committed pay run ${cover.documentNumber} (${cover.periodStart} to ${cover.periodEnd}) — approval is refused; ask payroll to carry the day on a retro run instead of rewriting paid history`,
      );
    }
  }
  // Re-validate the overlap under the row lock: a concurrent approval may
  // have landed between submit and decide (the exclusion is the backstop).
  await assertNoApprovedOverlap(exec, orgId, request.employment_id, startsOn, endsOn, request.id);
  const perDay = splitHoursAcrossDays(String(request.hours), days.length);
  for (let index = 0; index < days.length; index += 1) {
    // The overlap re-validation above cannot arbitrate two approvals
    // deciding at once: both pass it and both write. The partial day guard
    // (0337) settles that race in storage, and the loser lands here —
    // translated to a named refusal, never a raw 23505.
    let absence: { id: string } | undefined;
    try {
      absence = (await exec.execute<{ id: string }>(sql`
        insert into hrm_absences (org_id, leave_request_id, employment_id, on_date, hours,
          leave_type_id, source, created_by, updated_by)
        values (${orgId}, ${request.id}, ${request.employment_id}, ${days[index]},
          ${perDay[index]}, ${request.leave_type_id}, 'request', ${actorId}, ${actorId})
        returning id
      `)).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new LeaveError(
          "REFUSED",
          `absence day ${days[index]} was just recorded by another approval — reload the request and decide again`,
        );
      }
      throw error;
    }
    if (!absence) {
      throw new LeaveError("REFUSED", `absence for ${days[index]} was not stored — no row was written; the decision rolled back, decide again`);
    }
    if (type.value_crossing === "payout" || type.value_crossing === "bank_in") {
      const input = (await exec.execute<{ id: string }>(sql`
        insert into hrm_payroll_inputs (org_id, employee_party_id, employment_id, kind,
          absence_date, hours, source_leave_request_id, status, created_by, updated_by)
        values (${orgId}, ${workerPartyId}, ${request.employment_id}, ${type.value_crossing},
          ${days[index]}, ${perDay[index]}, ${request.id}, 'pending', ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!input) {
        throw new LeaveError("REFUSED", `pay-run input for ${days[index]} was not stored — no row was written; the decision rolled back, decide again`);
      }
    }
  }
}

export interface CancelLeaveRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly reason: unknown;
}

/**
 * Cancel an approved request: reverses absences (reversing rows, never
 * updates) and voids inputs. Cancelling a request whose rows were consumed
 * by a COMMITTED run is refused with the retro remedy — a paid row is never
 * flipped to voided. Rows consumed by an uncommitted run or still pending
 * flip to voided (the link stays: release-then-reconsume drops them).
 */
export async function cancelLeaveRequest(query: CancelLeaveRequestQuery): Promise<LeaveRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const reason = requireReason(query.reason, "a cancellation");
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    const onBehalf = current.created_by !== null && current.created_by !== actorId;
    await requireFileAccess(db, orgId, actorId, current.employment_id, onBehalf);
    if (current.status !== "approved") {
      throw new LeaveError("BAD_STATE", `a ${current.status} request cannot be cancelled — withdraw it instead`);
    }
    const inputs = (await db.execute<{ id: string; status: string; consumed_by_run_document_id: string | null }>(sql`
      select id, status, consumed_by_run_document_id from hrm_payroll_inputs
       where org_id = ${orgId} and source_leave_request_id = ${requestId} and status <> 'voided'
    `)).rows;
    for (const input of inputs) {
      if (input.status === "consumed" && input.consumed_by_run_document_id) {
        const run = (await db.execute<{ run_status: string; document_number: string }>(sql`
          select r.run_status, d.document_number from pay_runs r
            join documents d on d.id = r.document_id and d.org_id = r.org_id
           where r.org_id = ${orgId} and r.document_id = ${input.consumed_by_run_document_id}
        `)).rows[0];
        if (run?.run_status === "committed") {
          throw new LeaveError(
            "STALE_RUN",
            `payroll input for this request was consumed by committed pay run ${run.document_number} — cancellation is refused; ask payroll to carry the correction on a retro run instead of voiding paid history`,
          );
        }
      }
    }
    // Reverse every live absence day with a negative-hours row. Reversal
    // rows carry leave_request_id NULL: the request-day unique would collide
    // with the row they reverse, and the recorded-day unique skips rows with
    // reversal_of set. Provenance is the reversal_of chain.
    const absences = (await db.execute<{ id: string; on_date: string; hours: string; leave_type_id: string }>(sql`
      select id, on_date::text as on_date, hours::text as hours, leave_type_id from hrm_absences
       where org_id = ${orgId} and leave_request_id = ${requestId} and reversal_of is null
    `)).rows;
    for (const absence of absences) {
      const already = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_absences
         where org_id = ${orgId} and reversal_of = ${absence.id}
      `)).rows[0]?.n ?? 0;
      if (already > 0) continue;
      const reversed = (await db.execute<{ id: string }>(sql`
        insert into hrm_absences (org_id, leave_request_id, employment_id, on_date, hours,
          leave_type_id, source, reversal_of, created_by, updated_by)
        values (${orgId}, null, ${current.employment_id}, ${String(absence.on_date).slice(0, 10)},
          ${`-${String(absence.hours)}`}, ${absence.leave_type_id}, 'request', ${absence.id}, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!reversed) {
        throw new LeaveError("REFUSED", `reversal for ${String(absence.on_date).slice(0, 10)} was not stored — no row was written; the cancellation rolled back, try again`);
      }
    }
    if (inputs.length > 0) {
      await db.execute(sql`
        update hrm_payroll_inputs set status = 'voided', updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and source_leave_request_id = ${requestId} and status <> 'voided'
      `);
    }
    // Storage owns the lifecycle shape: cancelled groups with the undecided
    // states (decided_by/decided_at NULL), so cancelling clears the approval
    // decision and records the cancel reason in decision_reason.
    const cancelled = (await db.execute<RequestRow>(sql`
      update hrm_leave_requests
         set status = 'cancelled', decided_by = null, decided_at = null,
             decision_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'approved'
      returning ${REQUEST_COLUMNS}
    `)).rows[0];
    if (!cancelled) throw new LeaveError("BAD_STATE", "the request changed while cancellation was being recorded — reload it and try again");
    return toRequestDTO(cancelled);
  });
}
