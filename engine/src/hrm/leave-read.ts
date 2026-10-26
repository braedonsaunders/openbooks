import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { entitlementBalances } from "../payroll/entitlements-db.ts";
import {
  HrmAuthorizationError,
  loadOwnEmploymentIds,
  requireAggregateLeaveManage,
  requireHrmLeaveManageOnEmployment,
  requireHrmLeaveRead,
} from "./authorization.ts";
import { EmploymentReadError, likeEscape } from "./employment-read.ts";
import { parseCivilDate } from "./temporal.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { LeaveError } from "./leave-errors.ts";
import {
  accrualEarnedAcrossSegments,
  addHours,
  carryoverApplied,
  pinnedIds,
  requireRuleTiers,
  selectReigns,
  subHours,
  timeBalance,
  selectPolicy,
  type AccrualRule,
  type AccrualTenure,
  type AccrualSegment,
  type CarryoverRule,
  type PolicyCandidate,
  type PolicyMatchScope,
} from "./leave-math.ts";
import { inputGuards } from "./input-guards.ts";

export { strandedLeavePayrollInputs } from "../payroll/leave-payroll-inputs.ts";

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

const { requireOrgId, requireActorId } = inputGuards((message) => new EmploymentReadError(message));

export interface ClassificationWindow {
  readonly classificationId: string;
  /** Inclusive window start (YYYY-MM-DD). */
  readonly from: string;
  /** Inclusive window end, null = open-ended (construction convention). */
  readonly to: string | null;
}

/** Classifications held on a day: every window covering it (inclusive ends). */
export function classificationsOn(windows: readonly ClassificationWindow[], day: string): string[] {
  const held: string[] = [];
  for (const window of windows) {
    if (window.from <= day && (window.to === null || day <= window.to)) {
      held.push(window.classificationId);
    }
  }
  return held;
}

export interface PolicyScope {
  readonly employmentId: string;
  readonly employerSubsidiaryId: string;
  readonly departmentId: string | null;
  /**
   * The employment's classification windows. Matching resolves them per
   * date (a classification held for only part of a period governs only
   * that part), so the scope carries windows, never a single-day set.
   */
  readonly classificationWindows: readonly ClassificationWindow[];
}

/** The match input for one date: pins plus the classifications held that day. */
export function scopeForDay(scope: PolicyScope, day: string): PolicyMatchScope {
  return {
    employerSubsidiaryId: scope.employerSubsidiaryId,
    departmentId: scope.departmentId,
    employmentId: scope.employmentId,
    classificationIds: classificationsOn(scope.classificationWindows, day),
  };
}

export type PolicyRow = {
  readonly id: string;
  readonly leave_type_id: string;
  readonly applies_to: {
    employer_subsidiary_id: string | null;
    department_id: string | null;
    employment_ids?: string[] | null;
    classification_ids?: string[] | null;
  };
  readonly accrual_rule: AccrualRule;
  readonly carryover_rule: CarryoverRule;
  readonly minimum_notice_days: number;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly is_active: boolean;
};

/** Accrual-year start for a date: the calendar year. */
function accrualYearOf(date: string): string {
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
  const rows = await exec.execute<PolicyRow>(
    sql`
    select id, leave_type_id, applies_to, accrual_rule, carryover_rule,
           minimum_notice_days, effective_from::text as effective_from,
           effective_to::text as effective_to, is_active
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active
       and effective_from <= ${onDate} and (effective_to is null or effective_to >= ${onDate})
  `,
    "objects",
  );
  const picked = selectPolicy(rows.map(policyToCandidate), scopeForDay(scope, onDate), onDate);
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
  const rows = await exec.execute<PolicyRow>(
    sql`
    select id, leave_type_id, applies_to, accrual_rule, carryover_rule,
           minimum_notice_days, effective_from::text as effective_from,
           effective_to::text as effective_to, is_active
      from hrm_leave_policies
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId} and is_active
       and effective_from <= ${to} and (effective_to is null or effective_to >= ${from})
     order by effective_from, id
  `,
    "objects",
  );
  return rows;
}

/** Scope + window + targeting pins of a policy row for the pure precedence sort. */
export function policyToCandidate(row: PolicyRow): PolicyCandidate {
  return {
    id: row.id,
    employerSubsidiaryId: (row.applies_to?.employer_subsidiary_id as string | null) ?? null,
    departmentId: (row.applies_to?.department_id as string | null) ?? null,
    // Legacy rows predate targeting keys: absent reads as wildcard (null),
    // and empty lists read the same way (pinnedIds).
    employmentIds: pinnedIds(row.applies_to?.employment_ids as string[] | null | undefined),
    classificationIds: pinnedIds(row.applies_to?.classification_ids as string[] | null | undefined),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
  };
}

/** The policy row behind a resolved candidate, for carryover-rule reads. */
function policyById(rows: readonly PolicyRow[], id: string | null | undefined): PolicyRow | null {
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
  const rows = await exec.execute<{ hours: string }>(
    sql`
    select hours::text as hours from hrm_absences
     where org_id = ${orgId} and employment_id = ${employmentId} and leave_type_id = ${leaveTypeId}
       and on_date >= ${from} and on_date <= ${to}
  `,
    "objects",
  );
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
  const employment = (
    await exec.execute<{ worker_party_id: string; employer_subsidiary_id: string }>(
      sql`
    select worker_party_id, employer_subsidiary_id from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `,
      "objects",
    )
  )[0];
  if (!employment) {
    throw new LeaveError(
      "NOT_FOUND",
      "employment not found in this organization — check the employment id",
    );
  }
  // Primary assignment effective on the date carries the department pin.
  const assignment = (
    await exec.execute<{ department_id: string | null }>(
      sql`
    select department_id from employment_assignment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and is_primary and recorded_until is null
       and effective_from <= ${asOf} and (effective_to is null or effective_to > ${asOf})
     order by effective_from desc limit 1
  `,
      "objects",
    )
  )[0];
  return {
    employmentId,
    employerSubsidiaryId: employment.employer_subsidiary_id,
    departmentId: assignment?.department_id ?? null,
    classificationWindows: await classificationWindowsForEmployment(exec, orgId, employmentId),
  };
}

/**
 * Every classification window of an employment (inclusive ends, the
 * construction convention). Loaded once per balance read; matching
 * resolves the held set per date in memory, so one employment's windows
 * never cost a query per day.
 */
export async function classificationWindowsForEmployment(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<ClassificationWindow[]> {
  const rows = await exec.execute<{
    classification_id: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    sql`
    select classification_id::text as classification_id,
           effective_from::text as effective_from, effective_to::text as effective_to
      from hrm_employment_classifications
     where org_id = ${orgId} and employment_id = ${employmentId}
     order by effective_from
  `,
    "objects",
  );
  return rows.map((row) => ({
    classificationId: row.classification_id,
    from: String(row.effective_from).slice(0, 10),
    to: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
  }));
}

/**
 * The service start behind service-based accrual tiers (null = unknown).
 * Unknown tenure accrues base hours; the balance read flags that so an
 * operator can fix the start date instead of silently under-accruing.
 */
export async function serviceStartForEmployment(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<string | null> {
  const row = (
    await exec.execute<{ service_start: string | null }>(
      sql`
    select service_start::text as service_start from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `,
      "objects",
    )
  )[0];
  if (!row) {
    throw new LeaveError(
      "NOT_FOUND",
      "employment not found in this organization — check the employment id",
    );
  }
  return row.service_start ? String(row.service_start).slice(0, 10) : null;
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
  /**
   * True when a tiered policy governed accrual but the employment has no
   * service start, so tiers priced at base hours. The operator fixes the
   * start date; the balance never silently under-accrues.
   */
  readonly serviceStartUnknown: boolean;
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
  const serviceStart = await serviceStartForEmployment(exec, orgId, employmentId);
  // Tiers resolve per accrual event from completed service on that event's
  // date — never once from the balance day — so the entitlement reproduces
  // for any past as-of date and an anniversary never re-rates earlier events.
  const tenure: AccrualTenure = { serviceStart };
  const policy = await applicablePolicy(exec, orgId, leaveTypeId, scope, asOf);
  if (!policy) {
    return {
      kind: "time",
      policyId: null,
      earned: null,
      carried: "0",
      taken: "0",
      balance: null,
      unlimited: false,
      serviceStartUnknown: false,
    };
  }
  const accrual = policy.accrual_rule as AccrualRule;
  if (accrual.kind === "unlimited") {
    const yearStart = accrualYearOf(asOf);
    const taken = await absenceHoursInWindow(
      exec,
      orgId,
      employmentId,
      leaveTypeId,
      yearStart,
      asOf,
    );
    return {
      kind: "time",
      policyId: policy.id,
      earned: null,
      carried: "0",
      taken,
      balance: null,
      unlimited: true,
      serviceStartUnknown: false,
    };
  }
  // Accrual is earned per governing reign over its window: each day accrues
  // under its most-specific policy, so a mid-year successor earns the old
  // rate before the switch and the new rate after (never the current rule
  // backdated to January), and a department policy replaces — never stacks
  // with — the org-wide rule for its workers.
  const yearStart = accrualYearOf(asOf);
  const segments = await policiesInRange(exec, orgId, leaveTypeId, yearStart, asOf);
  const reigns = withRules(segments, scope, yearStart, asOf);
  const earned = accrualEarnedAcrossSegments(reigns, yearStart, asOf, tenure);
  const taken = await absenceHoursInWindow(exec, orgId, employmentId, leaveTypeId, yearStart, asOf);
  // Carryover is earned under the policies in force for the prior year and
  // carried under the rule holding the year boundary — never under the
  // current policy reaching back.
  const priorYear = Number(yearStart.slice(0, 4)) - 1;
  const priorStart = `${priorYear}-01-01`;
  const priorEnd = `${priorYear}-12-31`;
  let carried = "0";
  const priorSegments = await policiesInRange(exec, orgId, leaveTypeId, priorStart, priorEnd);
  const priorReigns: AccrualSegment[] =
    priorSegments.length > 0 ? withRules(priorSegments, scope, priorStart, priorEnd) : [];
  if (priorSegments.length > 0) {
    const priorEarned = accrualEarnedAcrossSegments(priorReigns, priorStart, priorEnd, tenure);
    if (priorEarned !== null) {
      const priorTaken = await absenceHoursInWindow(
        exec,
        orgId,
        employmentId,
        leaveTypeId,
        priorStart,
        priorEnd,
      );
      const unused = subHours(priorEarned, priorTaken);
      const boundary = selectPolicy(
        priorSegments.map(policyToCandidate),
        scopeForDay(scope, priorEnd),
        priorEnd,
      );
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
    serviceStartUnknown:
      serviceStart === null &&
      [...reigns, ...priorReigns].some((reign) => requireRuleTiers(reign.rule) !== null),
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
): AccrualSegment[] {
  return selectReigns(
    rows.map((row) => ({ ...policyToCandidate(row), rule: row.accrual_rule as AccrualRule })),
    (day) => scopeForDay(scope, day),
    from,
    to,
  );
}

export interface LeaveTypeBalance {
  readonly leaveTypeId: string;
  readonly code: string;
  readonly name: string;
  /** Earned plus carried; null when the entitlement is unbounded. */
  readonly entitlement: string | null;
  /** Absence hours in the accrual year through asOf. */
  readonly taken: string;
  /** Draft and submitted request hours starting on or before asOf. */
  readonly pending: string;
  /** Entitlement minus taken minus pending; null when unbounded. */
  readonly remaining: string | null;
  /** The time balance (entitlement minus taken), straight from timeBalanceAsOf. */
  readonly balance: string | null;
  readonly unlimited: boolean;
  /** True when tiered accrual priced at base hours for an unknown service start. */
  readonly serviceStartUnknown: boolean;
}

function requireBalanceDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new LeaveError(
      "INVALID_INPUT",
      "asOf must be a real YYYY-MM-DD calendar date in years 0001 through 9999",
    );
  }
  try {
    parseCivilDate(value);
    return value;
  } catch {
    throw new LeaveError(
      "INVALID_INPUT",
      "asOf must be a real YYYY-MM-DD calendar date in years 0001 through 9999",
    );
  }
}

async function pendingRequestHours(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  leaveTypeId: string,
  asOf: string,
): Promise<string> {
  const rows = await exec.execute<{ hours: string }>(
    sql`
    select hours::text as hours from hrm_leave_requests
     where org_id = ${orgId} and employment_id = ${employmentId} and leave_type_id = ${leaveTypeId}
       and status in ('draft', 'submitted') and starts_on <= ${asOf}
  `,
    "objects",
  );
  let total = "0";
  for (const row of rows) total = addHours(total, String(row.hours));
  return total;
}

/**
 * Per-employee, per-leave-type balances as of a date. Reads through
 * timeBalanceAsOf — the same function the filing gate and the drawer use —
 * so the display can never disagree with the gate. No second calculator:
 * entitlement and taken come from the time balance, pending sums the
 * undecided requests, and remaining is exact-decimal subtraction through
 * leave-math. Scope rides on the caller (own employments, an already-gated
 * path), exactly like listLeaveTypes; the single-employment entry below
 * gates per employment.
 */
export async function leaveEmploymentBalances(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  asOf: string,
): Promise<LeaveTypeBalance[]> {
  const date = requireBalanceDate(asOf);
  const types = await listLeaveTypes(exec, orgId);
  const out: LeaveTypeBalance[] = [];
  for (const type of types) {
    if (!type.isActive) continue;
    const read = await timeBalanceAsOf(exec, orgId, employmentId, type.id, date);
    const pending = await pendingRequestHours(exec, orgId, employmentId, type.id, date);
    const entitlement =
      read.unlimited || read.earned === null ? null : addHours(read.earned, read.carried);
    out.push({
      leaveTypeId: type.id,
      code: type.code,
      name: type.name,
      entitlement,
      taken: read.taken,
      pending,
      remaining: entitlement === null ? null : subHours(subHours(entitlement, read.taken), pending),
      balance: read.balance,
      unlimited: read.unlimited,
      serviceStartUnknown: read.serviceStartUnknown,
    });
  }
  return out;
}

/**
 * One employment's balances, gated on that employment — never by a
 * caller-supplied party. Readers come through the read grant; managers
 * recording through the manage grant on the same employment, so the
 * record-absence form can always show the effect before saving.
 */
export async function leaveBalancesForEmployment(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  asOf: string,
): Promise<LeaveTypeBalance[]> {
  const mayRead = await actorHasPermission(exec, orgId, actorId, "hrm.leave.read");
  if (!mayRead) await requireHrmLeaveManageOnEmployment(exec, orgId, actorId, employmentId);
  else await requireHrmLeaveRead(exec, orgId, actorId, employmentId);
  return leaveEmploymentBalances(exec, orgId, employmentId, asOf);
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
export async function listLeaveTypes(
  exec: SqlExecutor,
  orgId: string,
): Promise<LeaveTypeSummary[]> {
  const rows = await exec.execute<LeaveTypeSummary>(
    sql`
    select id, code, name, paid, value_crossing as "valueCrossing", is_active as "isActive"
      from hrm_leave_types where org_id = ${orgId} order by code
  `,
    "objects",
  );
  return rows;
}

/** Active leave types as picker options (code — name). Authorization rides on the caller. */
export async function listLeaveTypeOptions(
  exec: SqlExecutor,
  orgId: string,
): Promise<{ id: string; label: string; requiresAttachment: boolean }[]> {
  const rows = await exec.execute<{
    id: string;
    code: string;
    name: string;
    requires_attachment: boolean;
  }>(
    sql`
    select id, code, name, requires_attachment from hrm_leave_types
     where org_id = ${orgId} and is_active order by code limit 200
  `,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    label: `${row.code} — ${row.name}`,
    requiresAttachment: row.requires_attachment,
  }));
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
async function loadLeaveFilingEmploymentOptions(
  exec: SqlExecutor,
  query: LeaveFilingEmploymentOptionsQuery,
): Promise<readonly LeaveFilingEmploymentOption[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
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
  // The legal-entity scope is a SQL predicate, never a post-page JS
  // filter: filtering AFTER the LIMIT lets out-of-scope rows displace
  // fileable in-scope ones and returns an empty page with results pending.
  const scopePredicate = subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, allowed);
  const page = await exec.execute<FilingOptionRow>(
    sql`
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
       ${scopePredicate}
     order by p.display_name, e.id
     limit ${limit}`,
    "objects",
  );
  // The pinned draft value is read by id, never by page position: it leads
  // even when it falls outside the bounded page. An unknown or out-of-scope
  // id stays absent rather than leaking existence.
  const pinned = includeId
    ? ((
        await exec.execute<FilingOptionRow>(
          sql`
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
         and e.employer_subsidiary_id is not null
         ${scopePredicate}`,
          "objects",
        )
      )[0] ?? null)
    : null;
  const rows = pinned
    ? [pinned, ...page.filter((row) => row.employmentId !== pinned.employmentId)]
    : page;

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

export interface OwnLeaveEmploymentOption {
  readonly employmentId: string;
  readonly label: string;
}

/**
 * The actor's OWN employments for self-service filing. Authority is the same
 * ownership the filing gate enforces (requireOwnEmploymentForRequest), so
 * the picker can never offer an employment the filing refusal would reject.
 * Labels mirror the on-behalf picker (person, employer, live primary job
 * title) — the drawer submits the employment id, never a name. An actor
 * linked to no employment gets [] (truthful empty, never a refusal).
 */
export async function listOwnLeaveEmploymentOptions(query: {
  orgId: string;
  actorId: string;
}): Promise<readonly OwnLeaveEmploymentOption[]> {
  return withOrgTransaction(query.orgId, async () => {
    const own = await loadOwnEmploymentIds(db, query.orgId, query.actorId);
    if (own.length === 0) return [];
    type OwnOptionRow = {
      employmentId: string;
      personName: string;
      employerName: string;
      jobTitle: string | null;
    };
    // Bare JS arrays must never be interpolated into ANY() (they bind as row
    // constructors); each id is its own parameter.
    const ids = own.map((id) => sql`${id}::uuid`);
    const rows = await db.execute<OwnOptionRow>(
      sql`
      select e.id::text as "employmentId",
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
       where e.org_id = ${query.orgId}::uuid
         and e.id in (${sql.join(ids, sql`, `)})
       order by p.display_name, e.id`,
      "objects",
    );
    return rows.map((row) => ({
      employmentId: row.employmentId,
      label: row.jobTitle
        ? `${row.personName} · ${row.employerName} · ${row.jobTitle}`
        : `${row.personName} · ${row.employerName}`,
    }));
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
  readonly attachmentId: string | null;
  readonly requiresAttachment: boolean;
  /** 'request' for filed requests, 'recorded' for manager-recorded absence days. */
  readonly source: "request" | "recorded";
  /** The absence row for recorded days; null for requests. */
  readonly absenceId: string | null;
}

const SUMMARY_COLUMNS = sql`r.id, r.employment_id, e.worker_party_id as worker_party_id,
  r.leave_type_id, t.code as leave_type_code,
  r.starts_on::text as starts_on, r.ends_on::text as ends_on, r.hours::text as hours,
  r.reason, r.status, r.decided_by, r.decided_at::text as decided_at, r.decision_reason,
  r.attachment_id, t.requires_attachment,
  'request' as source, null::uuid as absence_id`;

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
    attachmentId: row.attachment_id != null ? String(row.attachment_id) : null,
    requiresAttachment: row.requires_attachment === true,
    source: row.source === "recorded" ? "recorded" : "request",
    absenceId: row.absence_id != null ? String(row.absence_id) : null,
  };
}

async function loadSummaryRow(
  exec: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  const row = (
    await exec.execute<Record<string, unknown>>(
      sql`
    select ${SUMMARY_COLUMNS} from hrm_leave_requests r
      join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = ${requestId}
  `,
      "objects",
    )
  )[0];
  if (!row)
    throw new LeaveError(
      "NOT_FOUND",
      "leave request not found in this organization — check the request id",
    );
  return row;
}

/** One request, gated on its employment — never by a caller-supplied party. */
export async function getLeaveRequest(query: {
  orgId: string;
  actorId: string;
  requestId: string;
}): Promise<LeaveRequestSummary> {
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
export async function getOwnLeaveRequest(query: {
  orgId: string;
  actorId: string;
  requestId: string;
}): Promise<LeaveRequestSummary> {
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
  orgId: string;
  actorId: string;
  employmentId: string;
  status?: string;
}): Promise<LeaveRequestSummary[]> {
  return withOrgTransaction(query.orgId, async () => {
    await requireHrmLeaveRead(db, query.orgId, query.actorId, query.employmentId);
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select ${SUMMARY_COLUMNS} from hrm_leave_requests r
        join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
        join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
       where r.org_id = ${query.orgId} and r.employment_id = ${query.employmentId}
         and (${query.status ?? null}::text is null or r.status = ${query.status ?? null}::text)
       order by r.starts_on desc, r.created_at desc
    `,
      "objects",
    );
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
  const scopeList = sql`select jsonb_array_elements_text(${allowed === null ? "[]" : JSON.stringify([...allowed])}::jsonb)::uuid`;
  // Recorded absence days ride the SAME bounded scoped query as the
  // requests (one statement, one subsidiary scope, one truncation signal) —
  // never a second list beside it. Reversal rows are not facts and stay
  // out; a recorded day reads as its own summary with status 'recorded'.
  const rows = await exec.execute<Record<string, unknown>>(
    sql`
    select * from (
      select ${SUMMARY_COLUMNS}, r.starts_on as sort_date, r.created_at as sort_created
        from hrm_leave_requests r
        join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
        join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
       where r.org_id = ${orgId}
         and (${allowed === null}::boolean or e.employer_subsidiary_id in (${scopeList}))
      union all
      select a.id, a.employment_id, e.worker_party_id,
        a.leave_type_id, t.code as leave_type_code,
        a.on_date::text as starts_on, a.on_date::text as ends_on, a.hours::text as hours,
        a.reason, 'recorded' as status, null::uuid as decided_by, null::text as decided_at, null::text as decision_reason,
        null::uuid as attachment_id, false as requires_attachment,
        'recorded' as source, a.id as absence_id,
        a.on_date as sort_date, a.created_at as sort_created
        from hrm_absences a
        join hrm_leave_types t on t.id = a.leave_type_id and t.org_id = a.org_id
        join worker_employments e on e.id = a.employment_id and e.org_id = a.org_id
       where a.org_id = ${orgId} and a.source = 'recorded' and a.reversal_of is null
         and (${allowed === null}::boolean or e.employer_subsidiary_id in (${scopeList}))
    ) combined
     where (${opts.status ?? null}::text is null or combined.status = ${opts.status ?? null}::text)
     order by sort_date desc, sort_created desc, id
     limit ${limit + 1}
  `,
    "objects",
  );
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
export async function myLeaveRequests(query: {
  orgId: string;
  actorId: string;
}): Promise<LeaveRequestSummary[]> {
  return withOrgTransaction(query.orgId, async () => {
    const may = await mayReadOwnLeaveRequests(db, query.orgId, query.actorId);
    if (!may) {
      throw new HrmAuthorizationError(
        "Leave access requires the hrm.leave.request permission — ask an administrator to grant it in /admin/roles.",
      );
    }
    const own = await loadOwnEmploymentIds(db, query.orgId, query.actorId);
    if (own.length === 0) return [];
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select ${SUMMARY_COLUMNS} from hrm_leave_requests r
        join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
        join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
       where r.org_id = ${query.orgId}
         and r.employment_id in (select jsonb_array_elements_text(${JSON.stringify(own)}::jsonb)::uuid)
       order by r.starts_on desc, r.created_at desc
    `,
      "objects",
    );
    return rows.map(toSummary);
  });
}
