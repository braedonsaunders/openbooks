import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  requireHrmBenefitsManage,
  requireHrmBenefitsManageOnEmployment,
  requireOwnEmploymentForBenefits,
  type TrustedEmploymentSubject,
} from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import { addDaysCivil } from "./benefits-math.ts";
import {
  loadBenefitPlan,
  loadBenefitPlanLevels,
  resolveElectionCosts,
  validateBenefitPlanComponents,
  type BenefitPlanRow,
} from "./plans.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";

/**
 * HRM benefit election service (HR-8).
 *
 * Electing computes the per-period amounts from the plan basis and STORES
 * them on the election — a later plan price change never rewrites an
 * existing election. A change to an active enrolment ends it and opens a
 * new one from the change date, never an in-place rewrite. Every lifecycle
 * move appends its hrm_benefit_events row in the same transaction.
 *
 * Entry is an open window covering the employment, or a life event with a
 * reason. Termination ends every active enrolment automatically through
 * endEnrollmentsForTermination, called where the termination change is
 * applied, in the same transaction.
 */

export type EnrollmentStatus =
  | "elected"
  | "waived"
  | "pending_approval"
  | "active"
  | "ended"
  | "cancelled";

export interface EnrollmentDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly planId: string;
  readonly windowId: string | null;
  readonly coverageLevelKey: string | null;
  readonly status: EnrollmentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employeeAmountPerPeriod: string | null;
  readonly employerAmountPerPeriod: string | null;
  readonly currency: string;
  readonly electedAt: string;
  readonly electedBy: string | null;
  readonly endedReason: string | null;
}

const ENROLLMENT_COLUMNS = sql`id, employment_id as "employmentId", plan_id as "planId",
  window_id as "windowId", coverage_level_key as "coverageLevelKey", status,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  employee_amount_per_period::text as "employeeAmountPerPeriod",
  employer_amount_per_period::text as "employerAmountPerPeriod",
  currency, elected_at::text as "electedAt", elected_by as "electedBy",
  ended_reason as "endedReason"`;

function toEnrollmentDTO(row: Record<string, unknown>): EnrollmentDTO {
  const status = String(row.status);
  if (
    status !== "elected" &&
    status !== "waived" &&
    status !== "pending_approval" &&
    status !== "active" &&
    status !== "ended" &&
    status !== "cancelled"
  ) {
    throw new BenefitsError("REFUSED", "benefit enrollment carries an unknown status — reload and retry");
  }
  return {
    id: String(row.id),
    employmentId: String(row.employmentId),
    planId: String(row.planId),
    windowId: row.windowId != null ? String(row.windowId) : null,
    coverageLevelKey: row.coverageLevelKey != null ? String(row.coverageLevelKey) : null,
    status,
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
    employeeAmountPerPeriod:
      row.employeeAmountPerPeriod != null ? String(row.employeeAmountPerPeriod) : null,
    employerAmountPerPeriod:
      row.employerAmountPerPeriod != null ? String(row.employerAmountPerPeriod) : null,
    currency: String(row.currency),
    electedAt: String(row.electedAt),
    electedBy: row.electedBy != null ? String(row.electedBy) : null,
    endedReason: row.endedReason != null ? String(row.endedReason) : null,
  };
}

interface LiveVersion {
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

async function liveEmploymentVersions(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<LiveVersion[]> {
  const rows = (
    await exec.execute<{ status: string; effective_from: string; effective_to: string | null }>(sql`
      select status, effective_from::text as effective_from, effective_to::text as effective_to
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
    `)
  ).rows;
  return rows.map((row) => ({
    status: row.status,
    effectiveFrom: row.effective_from.slice(0, 10),
    effectiveTo: row.effective_to != null ? row.effective_to.slice(0, 10) : null,
  }));
}

/** In-service states that may hold coverage. Offered, suspended and
 * terminated employments hold none — elect after hire, reinstatement, or
 * never after termination. */
const IN_SERVICE_STATUSES = ["active", "on_leave"] as const;

/** The covering version on a date, or a refusal naming what the date needs. */
function coveringVersion(versions: readonly LiveVersion[], date: string): LiveVersion {
  const covering = versions.filter(
    (version) => version.effectiveFrom <= date && (version.effectiveTo === null || version.effectiveTo >= date),
  );
  if (covering.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      `no employment episode covers ${date} — elect from a date inside an employment episode`,
    );
  }
  const version = covering.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b));
  if (!(IN_SERVICE_STATUSES as readonly string[]).includes(version.status)) {
    throw new BenefitsError(
      "REFUSED",
      `employment is ${version.status} on ${date} — benefits elect only while active or on leave; hire, reinstate, then elect`,
    );
  }
  return version;
}

/** Earliest episode start: the hire date the waiting period counts from. */
function hireStart(versions: readonly LiveVersion[]): string {
  if (versions.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "employment has no recorded episodes — hire the employment before electing benefits",
    );
  }
  return versions.reduce((a, b) => (a.effectiveFrom <= b.effectiveFrom ? a : b)).effectiveFrom;
}

interface EntryCheck {
  readonly windowId: string | null;
  readonly lifeEvent: boolean;
}

async function liveDepartmentIds(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<string[]> {
  const rows = (
    await exec.execute<{ department_id: string | null }>(sql`
      select v.department_id
        from employment_assignment_versions v
        join employment_assignments s on s.org_id = v.org_id and s.id = v.assignment_id
       where v.org_id = ${orgId} and s.employment_id = ${employmentId}
         and v.recorded_until is null and v.department_id is not null
    `)
  ).rows;
  return [...new Set(rows.map((row) => String(row.department_id)))];
}

/**
 * The entry gate: an open window covering the employment (date containment
 * plus subsidiary and department scope), or a life event with a reason.
 * Returns which path admitted the election for the event record.
 */
async function checkEntry(
  exec: SqlExecutor,
  orgId: string,
  subject: TrustedEmploymentSubject,
  effectiveFrom: string,
  windowId: string | null,
  lifeEventReason: string | null,
): Promise<EntryCheck> {
  if (windowId !== null) {
    const row = requireOneRow(
      (
        await exec.execute<Record<string, unknown>>(sql`
          select status, opens_on::text as "opensOn", closes_on::text as "closesOn",
                 applies_to as "appliesTo", name
            from hrm_enrollment_windows
           where org_id = ${orgId} and id = ${windowId}
        `)
      ).rows,
      "enrollment window",
    );
    if (String(row.status) !== "open") {
      throw new BenefitsError(
        "REFUSED",
        `enrollment window is ${String(row.status)} — elect inside an open window, or record a life event with a reason`,
      );
    }
    if (effectiveFrom < String(row.opensOn).slice(0, 10) || effectiveFrom > String(row.closesOn).slice(0, 10)) {
      throw new BenefitsError(
        "REFUSED",
        `election from ${effectiveFrom} falls outside the window ${String(row.opensOn).slice(0, 10)}..${String(row.closesOn).slice(0, 10)} — elect inside the window dates, or record a life event with a reason`,
      );
    }
    const applies = (row.appliesTo ?? {}) as Record<string, unknown>;
    const scopeSub = typeof applies.employer_subsidiary_id === "string" ? applies.employer_subsidiary_id : null;
    if (scopeSub !== null && scopeSub !== subject.employerSubsidiaryId) {
      throw new BenefitsError(
        "REFUSED",
        "the window covers a different employer subsidiary than this employment — elect inside a window covering your employer, or record a life event with a reason",
      );
    }
    const scopeDept = typeof applies.department_id === "string" ? applies.department_id : null;
    if (scopeDept !== null) {
      const departments = await liveDepartmentIds(exec, orgId, subject.id);
      if (!departments.includes(scopeDept)) {
        throw new BenefitsError(
          "REFUSED",
          "the window covers a department this employment does not hold — elect inside a window covering your department, or record a life event with a reason",
        );
      }
    }
    return { windowId, lifeEvent: false };
  }
  if (lifeEventReason !== null) {
    return { windowId: null, lifeEvent: true };
  }
  throw new BenefitsError(
    "REFUSED",
    "no open window and no life event — elect inside an open window covering the employment, or record a life event with a reason",
  );
}

async function requireActivePlanInScope(
  exec: SqlExecutor,
  orgId: string,
  subject: TrustedEmploymentSubject,
  planId: string,
  effectiveFrom: string,
): Promise<BenefitPlanRow> {
  const plan = await loadBenefitPlan(exec, orgId, planId);
  if (!plan.isActive) {
    throw new BenefitsError(
      "REFUSED",
      `benefit plan ${plan.code} is retired — elect an active plan; history keeps the retired one`,
    );
  }
  if (effectiveFrom < plan.effectiveFrom || (plan.effectiveTo !== null && effectiveFrom > plan.effectiveTo)) {
    throw new BenefitsError(
      "REFUSED",
      `plan ${plan.code} is not offered from ${effectiveFrom} — elect inside ${plan.effectiveFrom}..${plan.effectiveTo ?? "open"}`,
    );
  }
  if (plan.employerSubsidiaryId !== null && plan.employerSubsidiaryId !== subject.employerSubsidiaryId) {
    throw new BenefitsError(
      "REFUSED",
      `plan ${plan.code} is not offered to this employment's employer subsidiary — elect a plan your employer offers`,
    );
  }
  return plan;
}

async function requireWaitingSatisfied(
  versions: readonly LiveVersion[],
  plan: BenefitPlanRow,
  effectiveFrom: string,
): Promise<void> {
  if (plan.waitingPeriodDays <= 0) return;
  const start = hireStart(versions);
  const eligible = addDaysCivil(start, plan.waitingPeriodDays);
  if (effectiveFrom < eligible) {
    throw new BenefitsError(
      "REFUSED",
      `plan ${plan.code} needs ${plan.waitingPeriodDays} days of service — earliest election from ${eligible}`,
    );
  }
}

async function requireNoOverlappingElection(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  planId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
): Promise<void> {
  const rows = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_benefit_enrollments
       where org_id = ${orgId} and employment_id = ${employmentId} and plan_id = ${planId}
         and status in ('elected', 'pending_approval', 'active')
         and effective_from <= ${effectiveTo ?? "9999-12-31"}
         and (effective_to is null or effective_to >= ${effectiveFrom})
       limit 1
    `)
  ).rows;
  if (rows.length > 0) {
    throw new BenefitsError(
      "REFUSED",
      "this employment already holds this plan over those dates — change or end the existing enrolment instead of electing twice",
    );
  }
}

async function appendEvent(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  enrollmentId: string,
  kind: string,
  reason: string,
): Promise<void> {
  await exec.execute(sql`
    insert into hrm_benefit_events (org_id, enrollment_id, kind, reason, actor, created_by)
    values (${orgId}, ${enrollmentId}, ${kind}, ${reason}, ${actorId}, ${actorId})
  `);
}

export interface ElectEnrollmentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly planId: string;
  readonly windowId?: string | null;
  readonly coverageLevelKey?: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly lifeEventReason?: string | null;
  /** True when the actor elects for themself (structural self scope). */
  readonly selfService?: boolean;
}

/**
 * Elect coverage. Amounts are computed from the plan basis and STORED, so
 * a later plan price change never rewrites the election. Approval-required
 * plans land in pending_approval; the rest activate at once (elected plus
 * activated events, one transaction).
 */
export async function electEnrollment(query: ElectEnrollmentQuery): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const planId = requireId(query.planId, "planId");
  const effectiveFrom = requireCivilDate(query.effectiveFrom, "effectiveFrom");
  const effectiveTo =
    query.effectiveTo === undefined || query.effectiveTo === null
      ? null
      : requireCivilDate(query.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "effective_to precedes effective_from — end the enrolment on or after its start",
    );
  }
  const windowId = query.windowId ?? null;
  const lifeEventReason =
    typeof query.lifeEventReason === "string" && query.lifeEventReason.trim().length > 0
      ? query.lifeEventReason.trim()
      : null;
  const coverageLevelKey = query.coverageLevelKey ?? null;
  return withOrgTransaction(orgId, async () => {
    const subject = query.selfService
      ? await requireOwnEmploymentForBenefits(db, orgId, actorId, employmentId)
      : await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const versions = await liveEmploymentVersions(db, orgId, employmentId);
    coveringVersion(versions, effectiveFrom);
    const plan = await requireActivePlanInScope(db, orgId, subject, planId, effectiveFrom);
    await requireWaitingSatisfied(versions, plan, effectiveFrom);
    const entry = await checkEntry(db, orgId, subject, effectiveFrom, windowId, lifeEventReason);
    const levels = await loadBenefitPlanLevels(db, orgId, planId);
    const costs = resolveElectionCosts(plan, levels, coverageLevelKey);
    await validateBenefitPlanComponents(db, orgId, plan, levels);
    await requireNoOverlappingElection(db, orgId, employmentId, planId, effectiveFrom, effectiveTo);
    const status = plan.requiresApproval ? "pending_approval" : "active";
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, coverage_level_key, status,
             effective_from, effective_to, employee_amount_per_period,
             employer_amount_per_period, currency, elected_by, created_by, updated_by)
          values (${orgId}, ${employmentId}, ${planId}, ${entry.windowId}, ${coverageLevelKey},
                  ${status}, ${effectiveFrom}::date, ${effectiveTo}::date,
                  ${costs.employeeAmountPerPeriod}, ${costs.employerAmountPerPeriod},
                  ${plan.currency}, ${actorId}, ${actorId}, ${actorId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "recording the election",
    );
    const dto = toEnrollmentDTO(inserted);
    const eventKind = entry.lifeEvent ? "life_event" : "elected";
    const eventReason = entry.lifeEvent
      ? `life event: ${lifeEventReason}`
      : entry.windowId !== null
        ? "elected inside the open window"
        : "elected";
    await appendEvent(db, orgId, actorId, dto.id, eventKind, eventReason);
    if (status === "active") {
      await appendEvent(db, orgId, actorId, dto.id, "activated", "plan needs no approval — active at election");
    }
    return dto;
  });
}

export interface WaiveEnrollmentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly planId: string;
  readonly windowId?: string | null;
  readonly effectiveFrom: string;
  readonly reason: string;
  readonly selfService?: boolean;
}

/** Decline coverage with an evidenced waiver row (no amounts, never silent). */
export async function waiveEnrollment(query: WaiveEnrollmentQuery): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const planId = requireId(query.planId, "planId");
  const effectiveFrom = requireCivilDate(query.effectiveFrom, "effectiveFrom");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "waiving coverage needs a reason — it is the waiver's evidence");
  }
  const windowId = query.windowId ?? null;
  return withOrgTransaction(orgId, async () => {
    const subject = query.selfService
      ? await requireOwnEmploymentForBenefits(db, orgId, actorId, employmentId)
      : await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const versions = await liveEmploymentVersions(db, orgId, employmentId);
    coveringVersion(versions, effectiveFrom);
    const plan = await requireActivePlanInScope(db, orgId, subject, planId, effectiveFrom);
    const entry = await checkEntry(db, orgId, subject, effectiveFrom, windowId, reason);
    await requireNoOverlappingElection(db, orgId, employmentId, planId, effectiveFrom, null);
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, status,
             effective_from, currency, elected_by, created_by, updated_by)
          values (${orgId}, ${employmentId}, ${planId}, ${entry.windowId}, 'waived',
                  ${effectiveFrom}::date, ${plan.currency}, ${actorId}, ${actorId}, ${actorId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "recording the waiver",
    );
    const dto = toEnrollmentDTO(inserted);
    await appendEvent(db, orgId, actorId, dto.id, "waived", reason);
    return dto;
  });
}

async function loadEnrollment(
  exec: SqlExecutor,
  orgId: string,
  enrollmentId: string,
): Promise<EnrollmentDTO> {
  const row = requireOneRow(
    (
      await exec.execute<Record<string, unknown>>(sql`
        select ${ENROLLMENT_COLUMNS} from hrm_benefit_enrollments
         where org_id = ${orgId} and id = ${enrollmentId}
      `)
    ).rows,
    "benefit enrollment",
  );
  return toEnrollmentDTO(row);
}

/** Approve a pending election (hrm.benefits.manage). */
export async function approveEnrollment(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
}): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const enrollment = await loadEnrollment(db, orgId, enrollmentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, enrollment.employmentId);
    if (enrollment.status !== "pending_approval") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrolment is ${enrollment.status} — only a pending approval is approved`,
      );
    }
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_enrollments
             set status = 'active', updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${enrollmentId} and status = 'pending_approval'
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "approving the enrolment",
    );
    await appendEvent(db, orgId, actorId, enrollmentId, "approved", "approved — active from its effective date");
    return toEnrollmentDTO(updated);
  });
}

export interface ChangeEnrollmentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly changeDate: string;
  readonly coverageLevelKey?: string | null;
  readonly reason: string;
}

/**
 * Change an active enrolment from a date: the old row ends the day before
 * and a new row opens from the change date with the (possibly new) tier —
 * never an in-place rewrite of stored amounts.
 */
export async function changeEnrollment(query: ChangeEnrollmentQuery): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const changeDate = requireCivilDate(query.changeDate, "changeDate");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "changing an enrolment needs a reason — it is recorded on both rows");
  }
  const coverageLevelKey = query.coverageLevelKey ?? undefined;
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const current = await loadEnrollment(db, orgId, enrollmentId);
    const subject = await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, current.employmentId);
    if (current.status !== "active") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrolment is ${current.status} — only an active enrolment is changed; elect anew otherwise`,
      );
    }
    if (changeDate <= current.effectiveFrom) {
      throw new BenefitsError(
        "REFUSED",
        `change date ${changeDate} is not after the enrolment start ${current.effectiveFrom} — change from a later date, or cancel and elect anew`,
      );
    }
    if (current.effectiveTo !== null && changeDate > current.effectiveTo) {
      throw new BenefitsError(
        "REFUSED",
        `change date ${changeDate} is past the enrolment end ${current.effectiveTo} — the enrolment already ended there`,
      );
    }
    const versions = await liveEmploymentVersions(db, orgId, current.employmentId);
    coveringVersion(versions, changeDate);
    const plan = await requireActivePlanInScope(db, orgId, subject, current.planId, changeDate);
    const levels = await loadBenefitPlanLevels(db, orgId, current.planId);
    const costs = resolveElectionCosts(
      plan,
      levels,
      coverageLevelKey === undefined ? current.coverageLevelKey : coverageLevelKey,
    );
    await validateBenefitPlanComponents(db, orgId, plan, levels);
    const endedDay = addDaysCivil(changeDate, -1);
    const closed = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_enrollments
             set status = 'ended', effective_to = ${endedDay}::date,
                 ended_reason = ${`changed from ${changeDate}: ${reason}`},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${enrollmentId} and status = 'active'
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "ending the previous enrolment",
    );
    await appendEvent(db, orgId, actorId, enrollmentId, "ended", `changed from ${changeDate}: ${reason}`);
    void closed;
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, coverage_level_key, status,
             effective_from, effective_to, employee_amount_per_period,
             employer_amount_per_period, currency, elected_by, created_by, updated_by)
          values (${orgId}, ${current.employmentId}, ${current.planId}, ${current.windowId},
                  ${coverageLevelKey === undefined ? current.coverageLevelKey : coverageLevelKey},
                  'active', ${changeDate}::date, ${current.effectiveTo}::date,
                  ${costs.employeeAmountPerPeriod}, ${costs.employerAmountPerPeriod},
                  ${plan.currency}, ${actorId}, ${actorId}, ${actorId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "opening the changed enrolment",
    );
    const dto = toEnrollmentDTO(inserted);
    await appendEvent(db, orgId, actorId, dto.id, "elected", `changed from ${changeDate}: ${reason}`);
    await appendEvent(db, orgId, actorId, dto.id, "changed", `continues enrolment ${enrollmentId} from ${changeDate}`);
    return dto;
  });
}

export interface EndEnrollmentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly endedOn?: string | null;
  readonly reason: string;
}

/** End an enrolment with a reason (ended rows are retained history). */
export async function endEnrollment(query: EndEnrollmentQuery): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "ending an enrolment needs a reason — it is the row's evidence");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const current = await loadEnrollment(db, orgId, enrollmentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, current.employmentId);
    if (current.status !== "active" && current.status !== "elected" && current.status !== "pending_approval") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrolment is ${current.status} — only a live enrolment is ended`,
      );
    }
    const endedOn =
      query.endedOn === undefined || query.endedOn === null
        ? await businessToday(orgId)
        : requireCivilDate(query.endedOn, "endedOn");
    if (endedOn < current.effectiveFrom) {
      throw new BenefitsError(
        "REFUSED",
        `end date ${endedOn} precedes the enrolment start ${current.effectiveFrom} — cancel instead of ending before it began`,
      );
    }
    const effectiveTo =
      current.effectiveTo !== null && current.effectiveTo < endedOn ? current.effectiveTo : endedOn;
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_enrollments
             set status = 'ended', effective_to = ${effectiveTo}::date,
                 ended_reason = ${reason}, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${enrollmentId}
             and status in ('active', 'elected', 'pending_approval')
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "ending the enrolment",
    );
    await appendEvent(db, orgId, actorId, enrollmentId, "ended", reason);
    return toEnrollmentDTO(updated);
  });
}

/** Cancel a not-yet-active enrolment. Active rows end; they are never cancelled. */
export async function cancelEnrollment(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly reason: string;
}): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError("INVALID_INPUT", "cancelling an enrolment needs a reason");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const current = await loadEnrollment(db, orgId, enrollmentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, current.employmentId);
    if (current.status !== "elected" && current.status !== "pending_approval") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrolment is ${current.status} — only a not-yet-active enrolment is cancelled; end an active one`,
      );
    }
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_enrollments
             set status = 'cancelled', ended_reason = ${reason},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${enrollmentId}
             and status in ('elected', 'pending_approval')
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "cancelling the enrolment",
    );
    await appendEvent(db, orgId, actorId, enrollmentId, "cancelled", reason);
    return toEnrollmentDTO(updated);
  });
}

/**
 * Termination hook: ends every live enrolment of the employment in the same
 * transaction the termination change applies in. Rows starting after the
 * last covered day are cancelled (a future election for a terminated worker
 * is void); the rest end with the termination named. Called with the
 * termination-apply transaction runner — never opens its own.
 */
export async function endEnrollmentsForTermination(
  exec: SqlExecutor,
  args: {
    readonly orgId: string;
    readonly actorId: string;
    readonly employmentId: string;
    readonly terminatedOn: string;
  },
): Promise<number> {
  const { orgId, actorId, employmentId, terminatedOn } = args;
  const lastCovered = addDaysCivil(terminatedOn, -1);
  // Only rows still covering at termination: already-lapsed rows keep
  // their history untouched.
  const live = (
    await exec.execute<{ id: string; effective_from: string }>(sql`
      select id, effective_from::text as effective_from
        from hrm_benefit_enrollments
       where org_id = ${orgId} and employment_id = ${employmentId}
         and status in ('elected', 'pending_approval', 'active')
         and (effective_to is null or effective_to >= ${terminatedOn}::date)
    `)
  ).rows;
  for (const row of live) {
    const startsAfter = row.effective_from.slice(0, 10) > lastCovered;
    if (startsAfter) {
      const cancelled = (
        await exec.execute(sql`
          update hrm_benefit_enrollments
             set status = 'cancelled',
                 ended_reason = ${`employment terminated ${terminatedOn} before coverage began`},
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${row.id}
             and status in ('elected', 'pending_approval', 'active')
          returning id
        `)
      ).rows;
      if (cancelled.length !== 1) {
        throw new BenefitsError(
          "REFUSED",
          "an enrolment changed while the termination was applying — retry the decision",
        );
      }
      await appendEvent(
        exec,
        orgId,
        actorId,
        row.id,
        "cancelled",
        `employment terminated ${terminatedOn} before coverage began`,
      );
      continue;
    }
    const ended = (
      await exec.execute(sql`
        update hrm_benefit_enrollments
           set status = 'ended',
               effective_to = least(coalesce(effective_to, '9999-12-31'::date), ${lastCovered}::date),
               ended_reason = ${`employment terminated ${terminatedOn}`},
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${row.id}
           and status in ('elected', 'pending_approval', 'active')
        returning id
      `)
    ).rows;
    if (ended.length !== 1) {
      throw new BenefitsError(
        "REFUSED",
        "an enrolment changed while the termination was applying — retry the decision",
      );
    }
    await appendEvent(exec, orgId, actorId, row.id, "ended", `employment terminated ${terminatedOn}`);
  }
  return live.length;
}
