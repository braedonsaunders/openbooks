import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import {
  entitlementBalances,
  planBalanceExcludingRun,
} from "../payroll/entitlements-db.ts";
import {
  HrmAuthorizationError,
  loadOwnEmploymentIds,
  requireAggregateLeaveManage,
  requireHrmLeaveRead,
} from "./authorization.ts";
import { EmploymentReadError, likeEscape } from "./employment-read.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { LeaveError } from "./leave-errors.ts";
import {
  accrualEarnedAcrossSegments,
  addHours,
  carryoverApplied,
  selectReigns,
  subHours,
  timeBalance,
  selectPolicy,
  type AccrualRule,
  type CarryoverRule,
  type PolicyCandidate,
} from "./leave-math.ts";

/**
 * HRM leave reads (HR-5). Two balances, never conflated in code or copy:
 *
 * - TIME: the policy accrual in hours minus approved absences, with
 *   carryover — HR's entitlement, computed here from hrm_leave_policies and
 *   hrm_absences. Labelled as time everywhere it surfaces.
 * - VALUE: the payroll bank in money/hours — read THROUGH the payroll
 *   entitlement functions (entitlementBalances, planBalanceExcludingRun),
 *   never re-implemented. The payroll module owns the definition; this
 *   module only carries the display label. Labelled as value everywhere it
 *   surfaces.
 */

export interface PolicyScope {
  readonly employmentId: string;
  readonly employerSubsidiaryId: string;
  readonly departmentId: string | null;
}

export type PolicyRow = {
  readonly id: string;
  readonly leave_type_id: string;
  readonly applies_to: { employer_subsidiary_id: string | null; department_id: string | null };
  readonly accrual_rule: AccrualRule;
  readonly carryover_rule: CarryoverRule;
  readonly minimum_notice_days: number;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly is_active: boolean;
};

/** Accrual-year start for a date: the calendar year. */
export function accrualYearOf(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/** Most-specific active policy for a type, scope, and date — or null. */
export async function applicablePolicy(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
  scope: PolicyScope,
  onDate: string,
): Promise<PolicyRow | null> {
  const rows = (await exec.execute<PolicyRow>(sql`
    select id, leave_type_id, applies_to, accrual_rule, carryover_rule,
           minimum_notice_days, effective_from::text as effective_from,
           effective_to::text as effective_to, is_active
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active
       and effective_from <= ${onDate} and (effective_to is null or effective_to >= ${onDate})
  `)).rows;
  const picked = selectPolicy(rows.map(policyToCandidate), scope, onDate);
  return rows.find((row) => row.id === picked?.id) ?? null;
}

/** Every active policy of a type whose window touches [from, to], oldest first. */
export async function policiesInRange(
  exec: SqlExecutor,
  orgId: string,
  leaveTypeId: string,
  from: string,
  to: string,
): Promise<PolicyRow[]> {
  const rows = (await exec.execute<PolicyRow>(sql`
    select id, leave_type_id, applies_to, accrual_rule, carryover_rule,
           minimum_notice_days, effective_from::text as effective_from,
           effective_to::text as effective_to, is_active
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active
       and effective_from <= ${to} and (effective_to is null or effective_to >= ${from})
     order by effective_from, id
  `)).rows;
  return rows;
}

/** Scope + window pins of a policy row for the pure precedence sort. */
export function policyToCandidate(row: PolicyRow): PolicyCandidate {
  return {
    id: row.id,
    employerSubsidiaryId: (row.applies_to?.employer_subsidiary_id as string | null) ?? null,
    departmentId: (row.applies_to?.department_id as string | null) ?? null,
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
  };
}

/** The policy row behind a resolved candidate, for carryover-rule reads. */
export function policyById(rows: readonly PolicyRow[], id: string | null | undefined): PolicyRow | null {
  if (!id) return null;
  return rows.find((row) => row.id === id) ?? null;
}

/** Net absence hours (reversals net out) for an employment, type, and window. */
export async function absenceHoursInWindow(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  leaveTypeId: string,
  from: string,
  to: string,
): Promise<string> {
  const rows = (await exec.execute<{ hours: string }>(sql`
    select hours::text as hours from hrm_absences
     where org_id = ${orgId} and employment_id = ${employmentId} and leave_type_id = ${leaveTypeId}
       and on_date >= ${from} and on_date <= ${to}
  `)).rows;
  let total = "0";
  for (const row of rows) total = addHours(total, String(row.hours));
  return total;
}

/**
 * The policy scope of an employment on a date: the subsidiary pin from the
 * employment row and the department pin from the primary assignment
 * effective that day. Every leave path (balance, file, submit, approve,
 * notice) resolves scope through this function, so the gate and the display
 * can never disagree about which policies cover the worker.
 */
export async function policyScopeForEmployment(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  asOf: string,
): Promise<PolicyScope> {
  const employment = (await exec.execute<{ worker_party_id: string; employer_subsidiary_id: string }>(sql`
    select worker_party_id, employer_subsidiary_id from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  if (!employment) {
    throw new LeaveError("NOT_FOUND", "employment not found in this organization — check the employment id");
  }
  // Primary assignment effective on the date carries the department pin.
  const assignment = (await exec.execute<{ department_id: string | null }>(sql`
    select department_id from employment_assignment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and is_primary and recorded_until is null
       and effective_from <= ${asOf} and (effective_to is null or effective_to > ${asOf})
     order by effective_from desc limit 1
  `)).rows[0];
  return {
    employmentId,
    employerSubsidiaryId: employment.employer_subsidiary_id,
    departmentId: assignment?.department_id ?? null,
  };
}

export interface TimeBalance {
  readonly kind: "time";
  readonly policyId: string | null;
  readonly earned: string | null;
  readonly carried: string;
  readonly taken: string;
  /** Exact decimal hours, or null for unlimited (unbounded — never a number). */
  readonly balance: string | null;
  readonly unlimited: boolean;
}

/**
 * Time balance as of a date: policy accrual minus approved absences, with
 * carryover. The filing gate reads through this function, so the check and
 * the display can never disagree. Null policy (no coverage) reads as a
 * null balance — the gate refuses by name; the display says uncovered.
 */
export async function timeBalanceAsOf(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  leaveTypeId: string,
  asOf: string,
): Promise<TimeBalance> {
  const scope = await policyScopeForEmployment(exec, orgId, employmentId, asOf);
  const policy = await applicablePolicy(exec, orgId, leaveTypeId, scope, asOf);
  if (!policy) {
    return { kind: "time", policyId: null, earned: null, carried: "0", taken: "0", balance: null, unlimited: false };
  }
  const accrual = policy.accrual_rule as AccrualRule;
  if (accrual.kind === "unlimited") {
    const yearStart = accrualYearOf(asOf);
    const taken = await absenceHoursInWindow(exec, orgId, employmentId, leaveTypeId, yearStart, asOf);
    return { kind: "time", policyId: policy.id, earned: null, carried: "0", taken, balance: null, unlimited: true };
  }
  // Accrual is earned per governing reign over its window: each day accrues
  // under its most-specific policy, so a mid-year successor earns the old
  // rate before the switch and the new rate after (never the current rule
  // backdated to January), and a department policy replaces — never stacks
  // with — the org-wide rule for its workers.
  const yearStart = accrualYearOf(asOf);
  const segments = await policiesInRange(exec, orgId, leaveTypeId, yearStart, asOf);
  const earned = accrualEarnedAcrossSegments(withRules(segments, scope, yearStart, asOf), yearStart, asOf);
  const taken = await absenceHoursInWindow(exec, orgId, employmentId, leaveTypeId, yearStart, asOf);
  // Carryover is earned under the policies in force for the prior year and
  // carried under the rule holding the year boundary — never under the
  // current policy reaching back.
  const priorYear = Number(yearStart.slice(0, 4)) - 1;
  const priorStart = `${priorYear}-01-01`;
  const priorEnd = `${priorYear}-12-31`;
  let carried = "0";
  const priorSegments = await policiesInRange(exec, orgId, leaveTypeId, priorStart, priorEnd);
  if (priorSegments.length > 0) {
    const priorEarned = accrualEarnedAcrossSegments(withRules(priorSegments, scope, priorStart, priorEnd), priorStart, priorEnd);
    if (priorEarned !== null) {
      const priorTaken = await absenceHoursInWindow(exec, orgId, employmentId, leaveTypeId, priorStart, priorEnd);
      const unused = subHours(priorEarned, priorTaken);
      const boundary = selectPolicy(priorSegments.map(policyToCandidate), scope, priorEnd);
      const boundaryRow = policyById(priorSegments, boundary?.id);
      if (boundaryRow) {
        carried = carryoverApplied(
          boundaryRow.carryover_rule as CarryoverRule,
          unused.startsWith("-") ? "0" : unused,
          yearStart,
          asOf,
        );
      }
    }
  }
  return {
    kind: "time",
    policyId: policy.id,
    earned,
    carried,
    taken,
    balance: timeBalance({ earned, carried, taken }),
    // Null earned means an in-year unlimited segment made the total
    // unbounded — the honest label is unlimited, not a priced number.
    unlimited: earned === null,
  };
}

/**
 * Governing reigns of policy rows for a scope and window: each day's
 * most-specific policy, run together so accrual prices every slice at the
 * rule that actually covered its first service day.
 */
function withRules(
  rows: readonly PolicyRow[],
  scope: PolicyScope,
  from: string,
  to: string,
) {
  return selectReigns(
    rows.map((row) => ({ ...policyToCandidate(row), rule: row.accrual_rule as AccrualRule })),
    scope,
    from,
    to,
  );
}

export interface ValueBalanceEntry {
  readonly kind: "value";
  readonly planId: string;
  readonly planCode: string;
  readonly planName: string;
  readonly unit: "money" | "hours";
  readonly balance: string;
  readonly balanceMoney: string | null;
  readonly balanceHours: string | null;
}

/**
 * VALUE balance for display: read through the payroll entitlement
 * functions, never re-implemented. When a pay run may be open the caller
 * passes its document id so the run's own movements are excluded — the same
 * way the run reads itself. The payroll module owns the definition; this
 * function only carries the value label the drawer shows.
 */
export async function payrollBankBalances(
  orgId: string,
  employeePartyId: string,
  opts: { asOf?: string; excludeRunDocumentId?: string | null; executor?: SqlExecutor } = {},
): Promise<ValueBalanceEntry[]> {
  const balances = await entitlementBalances(orgId, employeePartyId, opts.asOf, {
    executor: opts.executor,
    excludeRunDocumentId: opts.excludeRunDocumentId ?? null,
  });
  return balances.map((entry) => ({
    kind: "value" as const,
    planId: entry.plan.id,
    planCode: entry.plan.code,
    planName: entry.plan.name,
    unit: entry.plan.unit,
    balance: entry.balance,
    balanceMoney: entry.balanceMoney,
    balanceHours: entry.balanceHours,
  }));
}

/**
 * VALUE balance for one plan net of an open run's own movements — the read
 * the request drawer uses where a bank exists. Owned by payroll's
 * planBalanceExcludingRun; labelled value here.
 */
export async function payrollBankBalanceForPlan(
  orgId: string,
  planId: string,
  employeePartyId: string,
  onDate: string,
  excludeRunDocumentId: string | null,
  executor?: SqlExecutor,
): Promise<{ kind: "value"; planId: string; balance: string }> {
  const balance = await planBalanceExcludingRun(
    executor ?? db,
    orgId,
    planId,
    employeePartyId,
    onDate,
    excludeRunDocumentId,
  );
  return { kind: "value", planId, balance };
}

/** Today's business date for an org — the as-of the balances display. */
export async function leaveToday(orgId: string): Promise<string> {
  return businessToday(orgId);
}

export type LeaveTypeSummary = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly paid: boolean;
  readonly valueCrossing: "none" | "payout" | "bank_in";
  readonly isActive: boolean;
};

/** Leave-type taxonomy for an org, in code order. Authorization rides on the caller. */
export async function listLeaveTypes(exec: SqlExecutor, orgId: string): Promise<LeaveTypeSummary[]> {
  const rows = (await exec.execute<LeaveTypeSummary>(sql`
    select id, code, name, paid, value_crossing as "valueCrossing", is_active as "isActive"
      from hrm_leave_types where org_id = ${orgId} order by code
  `)).rows;
  return rows;
}

/** Active leave types as picker options (code — name). Authorization rides on the caller. */
export async function listLeaveTypeOptions(
  exec: SqlExecutor,
  orgId: string,
): Promise<{ id: string; label: string }[]> {
  const rows = (await exec.execute<{ id: string; code: string; name: string }>(sql`
    select id, code, name from hrm_leave_types
     where org_id = ${orgId} and is_active order by code limit 200
  `)).rows;
  return rows.map((row) => ({ id: row.id, label: `${row.code} — ${row.name}` }));
}

export interface LeaveFilingEmploymentOptionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Substring match on the worker's display name; empty matches all. */
  readonly q?: string;
  /** Bounded page size; defaults to 25, refuses above 100. */
  readonly limit?: number;
  /** Employment id to pin first (the draft's stored value under edit). */
  readonly includeEmploymentId?: string;
}

export interface LeaveFilingEmploymentOption {
  readonly employmentId: string;
  readonly label: string;
}

/**
 * Employments the actor may file leave on behalf of, for the drawer's
 * manager filing mode. Authority is the aggregate half of the filing gate
 * (requireAggregateLeaveManage — the same hrm.leave.manage grant plus
 * employer-subsidiary scope the per-employment filing gate enforces), so
 * the picker can never offer an employment the filing refusal would reject.
 * Labels name the person, the employer, and the live primary job title —
 * the drawer submits the employment id, never a name. An empty page is
 * truthful (the actor manages leave for nobody in scope), never a refusal.
 */
export async function loadLeaveFilingEmploymentOptions(
  exec: SqlExecutor,
  query: LeaveFilingEmploymentOptionsQuery,
): Promise<readonly LeaveFilingEmploymentOption[]> {
  const orgId = query.orgId;
  const actorId = query.actorId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new EmploymentReadError("orgId must be a non-empty string");
  }
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new EmploymentReadError("actorId must be a non-empty string");
  }
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new EmploymentReadError(
      "options limit must be an integer from 1 to 100 — the picker pages, it never dumps the roster",
    );
  }
  const allowed = await requireAggregateLeaveManage(exec, orgId, actorId);
  const fragment = (query.q ?? "").trim();
  const includeId = query.includeEmploymentId?.trim() ? query.includeEmploymentId.trim() : null;

  type FilingOptionRow = {
    employmentId: string;
    employerSubsidiaryId: string;
    personName: string;
    employerName: string;
    jobTitle: string | null;
  };
  const page = (await exec.execute<FilingOptionRow>(sql`
    select e.id::text as "employmentId",
           e.employer_subsidiary_id::text as "employerSubsidiaryId",
           p.display_name as "personName",
           s.name as "employerName",
           jt.job_title as "jobTitle"
      from worker_employments e
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
      left join lateral (
        select av.job_title
          from employment_assignment_versions av
         where av.org_id = e.org_id
           and av.employment_id = e.id
           and av.recorded_until is null
           and av.is_primary
         order by av.version_no desc
         limit 1
      ) jt on true
     where e.org_id = ${orgId}::uuid
       and e.employer_subsidiary_id is not null
       ${fragment ? sql`and p.display_name ilike ${`%${likeEscape(fragment)}%`} escape '\\'` : sql``}
     order by p.display_name, e.id
     limit ${limit}`)).rows.filter(
    (row) => allowed === null || allowed.has(row.employerSubsidiaryId),
  );
  // The pinned draft value is read by id, never by page position: it leads
  // even when it falls outside the bounded page. An unknown or out-of-scope
  // id stays absent rather than leaking existence.
  const pinned = includeId
    ? (await exec.execute<FilingOptionRow>(sql`
      select e.id::text as "employmentId",
             e.employer_subsidiary_id::text as "employerSubsidiaryId",
             p.display_name as "personName",
             s.name as "employerName",
             jt.job_title as "jobTitle"
        from worker_employments e
        join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
        join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
        left join lateral (
          select av.job_title
            from employment_assignment_versions av
           where av.org_id = e.org_id
             and av.employment_id = e.id
             and av.recorded_until is null
             and av.is_primary
           order by av.version_no desc
           limit 1
        ) jt on true
       where e.org_id = ${orgId}::uuid
         and e.id = ${includeId}::uuid
         and e.employer_subsidiary_id is not null`)).rows.filter(
        (row) => allowed === null || allowed.has(row.employerSubsidiaryId),
      )[0] ?? null
    : null;
  const rows = pinned ? [pinned, ...page.filter((row) => row.employmentId !== pinned.employmentId)] : page;

  return rows.slice(0, limit + (pinned ? 1 : 0)).map((row) => ({
    employmentId: row.employmentId,
    label: row.jobTitle
      ? `${row.personName} · ${row.employerName} · ${row.jobTitle}`
      : `${row.personName} · ${row.employerName}`,
  }));
}

/**
 * Public boundary: one tenant-scoped transaction, then the scoped
 * on-behalf employment options. Read only. The HRM feature switch rides on
 * the caller (the options route double-gates it with the manage grant),
 * exactly like every other read in this module.
 */
export async function listLeaveFilingEmploymentOptions(
  query: LeaveFilingEmploymentOptionsQuery,
): Promise<readonly LeaveFilingEmploymentOption[]> {
  return withOrgTransaction(query.orgId, async () => {
    return loadLeaveFilingEmploymentOptions(db, query);
  });
}

// --- Request reads ----------------------------------------------------------

export interface LeaveRequestSummary {
  readonly id: string;
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly leaveTypeId: string;
  readonly leaveTypeCode: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly hours: string;
  readonly reason: string | null;
  readonly status: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

const SUMMARY_COLUMNS = sql`r.id, r.employment_id, e.worker_party_id as worker_party_id,
  r.leave_type_id, t.code as leave_type_code,
  r.starts_on::text as starts_on, r.ends_on::text as ends_on, r.hours::text as hours,
  r.reason, r.status, r.decided_by, r.decided_at::text as decided_at, r.decision_reason`;

function toSummary(row: Record<string, unknown>): LeaveRequestSummary {
  return {
    id: String(row.id),
    employmentId: String(row.employment_id),
    workerPartyId: String(row.worker_party_id),
    leaveTypeId: String(row.leave_type_id),
    leaveTypeCode: String(row.leave_type_code),
    startsOn: String(row.starts_on).slice(0, 10),
    endsOn: String(row.ends_on).slice(0, 10),
    hours: String(row.hours),
    reason: row.reason != null ? String(row.reason) : null,
    status: String(row.status),
    decidedBy: row.decided_by != null ? String(row.decided_by) : null,
    decidedAt: row.decided_at != null ? String(row.decided_at) : null,
    decisionReason: row.decision_reason != null ? String(row.decision_reason) : null,
  };
}

async function loadSummaryRow(exec: SqlExecutor, orgId: string, requestId: string): Promise<Record<string, unknown>> {
  const row = (await exec.execute<Record<string, unknown>>(sql`
    select ${SUMMARY_COLUMNS} from hrm_leave_requests r
      join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = ${requestId}
  `)).rows[0];
  if (!row) throw new LeaveError("NOT_FOUND", "leave request not found in this organization — check the request id");
  return row;
}

/** One request, gated on its employment — never by a caller-supplied party. */
export async function getLeaveRequest(query: { orgId: string; actorId: string; requestId: string }): Promise<LeaveRequestSummary> {
  return withOrgTransaction(query.orgId, async () => {
    const row = await loadSummaryRow(db, query.orgId, query.requestId);
    await requireHrmLeaveRead(db, query.orgId, query.actorId, String(row.employment_id));
    return toSummary(row);
  });
}

/**
 * Self-service leave eligibility: the permission half of reading one's own
 * requests. One predicate, defined here where the reads live — the inbox
 * own-leg probe reuses it, so the gate and the probe can never disagree
 * about who may read their own requests. (The second half, a linked
 * employment, is loadOwnEmploymentIds in authorization.ts.)
 */
export async function mayReadOwnLeaveRequests(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<boolean> {
  return (
    (await actorHasPermission(exec, orgId, actorId, "hrm.leave.request")) ||
    (await actorHasPermission(exec, orgId, actorId, "hrm.leave.read"))
  );
}

/**
 * One of the actor's OWN requests. The second self-service touch, beside the
 * inbox: proof of ownership is the employment behind the login, never a
 * caller-supplied worker — anything else refuses without saying whether the
 * id exists.
 */
export async function getOwnLeaveRequest(query: { orgId: string; actorId: string; requestId: string }): Promise<LeaveRequestSummary> {
  return withOrgTransaction(query.orgId, async () => {
    const may = await mayReadOwnLeaveRequests(db, query.orgId, query.actorId);
    if (!may) {
      throw new HrmAuthorizationError(
        "Leave access requires the hrm.leave.request permission — ask an administrator to grant it in /admin/roles.",
      );
    }
    const row = await loadSummaryRow(db, query.orgId, query.requestId);
    const own = await loadOwnEmploymentIds(db, query.orgId, query.actorId);
    if (!own.includes(String(row.employment_id))) {
      throw new HrmAuthorizationError(
        "this leave request is not on your employment — open it from your own inbox",
      );
    }
    return toSummary(row);
  });
}

/** Requests for one employment, newest first. */
export async function listLeaveRequests(query: {
  orgId: string; actorId: string; employmentId: string; status?: string;
}): Promise<LeaveRequestSummary[]> {
  return withOrgTransaction(query.orgId, async () => {
    await requireHrmLeaveRead(db, query.orgId, query.actorId, query.employmentId);
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select ${SUMMARY_COLUMNS} from hrm_leave_requests r
        join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
        join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
       where r.org_id = ${query.orgId} and r.employment_id = ${query.employmentId}
         and (${query.status ?? null}::text is null or r.status = ${query.status ?? null}::text)
       order by r.starts_on desc, r.created_at desc
    `)).rows;
    return rows.map(toSummary);
  });
}

export interface OrgLeaveList {
  readonly requests: LeaveRequestSummary[];
  readonly truncated: boolean;
}

/**
 * Org-wide request list for queues and panels: one permission check and one
 * subsidiary-scoped query, newest start first. This is equivalent to applying
 * requireHrmLeaveRead to every row, without an employment-by-employment N+1.
 * The bound applies to visible requests (not the size of the roster), and one
 * extra row provides an honest truncation signal.
 */
export async function listOrgLeaveRequests(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<OrgLeaveList> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.leave.read"))) {
    throw new HrmAuthorizationError(
      "Leave access requires the hrm.leave.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 500);
  const rows = (await exec.execute<Record<string, unknown>>(sql`
    select ${SUMMARY_COLUMNS} from hrm_leave_requests r
      join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
     where r.org_id = ${orgId}
       and (${allowed === null}::boolean
            or e.employer_subsidiary_id in (
              select jsonb_array_elements_text(${allowed === null ? "[]" : JSON.stringify([...allowed])}::jsonb)::uuid
            ))
       and (${opts.status ?? null}::text is null or r.status = ${opts.status ?? null}::text)
     order by r.starts_on desc, r.created_at desc, r.id
     limit ${limit + 1}
  `)).rows;
  return {
    requests: rows.slice(0, limit).map(toSummary),
    truncated: rows.length > limit,
  };
}

/**
 * Self-service inbox: the actor's own employments' requests only. An
 * employee cannot read another's request — there is no employment parameter
 * to forge, only the party behind the login.
 */
export async function myLeaveRequests(query: { orgId: string; actorId: string }): Promise<LeaveRequestSummary[]> {
  return withOrgTransaction(query.orgId, async () => {
    const may = await mayReadOwnLeaveRequests(db, query.orgId, query.actorId);
    if (!may) {
      throw new HrmAuthorizationError(
        "Leave access requires the hrm.leave.request permission — ask an administrator to grant it in /admin/roles.",
      );
    }
    const own = await loadOwnEmploymentIds(db, query.orgId, query.actorId);
    if (own.length === 0) return [];
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select ${SUMMARY_COLUMNS} from hrm_leave_requests r
        join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
        join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
       where r.org_id = ${query.orgId}
         and r.employment_id in (select jsonb_array_elements_text(${JSON.stringify(own)}::jsonb)::uuid)
       order by r.starts_on desc, r.created_at desc
    `)).rows;
    return rows.map(toSummary);
  });
}
