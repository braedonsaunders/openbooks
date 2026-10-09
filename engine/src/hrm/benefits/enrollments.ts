import { recordEnrollmentContributionTerms, validateBenefitPlanActivation, type EnrollmentContributionInput } from './contributions.ts';
import { sql } from "drizzle-orm";
import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
import { lockFlowSubjectDecision } from "../../flows/decision-lock.ts";
import { cancelDispatchRuns } from "../../flows/dispatch-result.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { addCalendarDays, addMonthsClamped, businessToday } from "../../platform/business-date.ts";
import {
  requireHrmBenefitsManage,
  requireHrmBenefitsManageOnEmployment,
  requireOwnEmploymentForBenefits,
  requireOwnEmploymentForBenefitsSelf,
  lockEmploymentsForScope,
  type TrustedEmploymentSubject,
} from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import {
  loadBenefitPlan,
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
 * Elections record explicit fixed or policy-following contribution terms.
 * The plan chooses no approvals or native Flows; submitted terms are immutable. A change to an active enrolment ends it and opens a
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
  readonly classKey: string | null;
  readonly matchEligible: boolean | null;
  readonly status: EnrollmentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly currency: string;
  readonly electedAt: string;
  readonly electedBy: string | null;
  readonly endedReason: string | null;
  readonly flowRunId: string | null;
  readonly approvalHref: string | null;
}

const ENROLLMENT_COLUMNS = sql`id, employment_id as "employmentId", plan_id as "planId",
  window_id as "windowId", class_key as "classKey", match_eligible as "matchEligible", status,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  currency, elected_at::text as "electedAt", elected_by as "electedBy",
  ended_reason as "endedReason",flow_run_id as "flowRunId"`;

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
    classKey: row.classKey != null ? String(row.classKey) : null,
    matchEligible: typeof row.matchEligible === "boolean" ? row.matchEligible : null,
    status,
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
    currency: String(row.currency),
    electedAt: String(row.electedAt),
    electedBy: row.electedBy != null ? String(row.electedBy) : null,
    endedReason: row.endedReason != null ? String(row.endedReason) : null,
    flowRunId: row.flowRunId == null ? null : String(row.flowRunId),
    approvalHref: status === "pending_approval" && row.flowRunId != null ? "/approvals" : null,
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
    (version) => version.effectiveFrom <= date && (version.effectiveTo === null || version.effectiveTo > date),
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

interface EntryCheck {
  readonly windowId: string | null;
  readonly lifeEvent: boolean;
}

async function lockEnrollmentWindowAdmission(
  exec: SqlExecutor,
  orgId: string,
  windowId: string,
): Promise<void> {
  requireOneRow(
    (
      await exec.execute<{ id: string }>(sql`
        select id from hrm_enrollment_windows
         where org_id = ${orgId} and id = ${windowId}
         for share
      `)
    ).rows,
    "enrollment window",
  );
}

async function lockEnrollmentPlanAdmission(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  planId: string,
): Promise<void> {
  await exec.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`hrm-benefit-election:${orgId}:${employmentId}:${planId}`}, 0)
    )
  `);
}

function isElectionRangeConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23P01"
  );
}

function electionRangeConflict(): BenefitsError {
  return new BenefitsError(
    "REFUSED",
    "this employment already holds this plan over those dates — change or end the existing enrolment instead of electing twice",
  );
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
           for share
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
  await validateBenefitPlanActivation(exec, orgId, planId, effectiveFrom);
  return plan;
}

async function requireContributionSubject(exec: SqlExecutor, orgId: string, planId: string, classKey: string | null | undefined, matchEligible: boolean | null | undefined): Promise<void> {
  if (matchEligible != null && typeof matchEligible !== 'boolean') throw new BenefitsError('INVALID_INPUT','Matching eligibility must be explicitly yes, no, or unknown');
  if (classKey != null) {
    const exists = (await exec.execute(sql`select id from hrm_benefit_contribution_classes where org_id=${orgId} and plan_id=${planId} and class_key=${classKey}`)).rows;
    if (!exists.length) throw new BenefitsError('REFUSED','The selected contribution class is not on this plan — choose a class declared in its Contributions');
  }
}

async function requireWaitingSatisfied(
  exec: SqlExecutor, orgId: string, employmentId: string,
  plan: BenefitPlanRow,
  effectiveFrom: string,
): Promise<void> {
  if (plan.waitingPeriodDays <= 0 && !(plan.waitingPeriodMonths && plan.waitingPeriodMonths > 0)) return;
  const subject=requireOneRow((await exec.execute<{service_start:string|null}>(sql`select service_start::text from worker_employments where org_id=${orgId} and id=${employmentId}`)).rows,'Benefit employment');
  if (subject.service_start === null) throw new BenefitsError('REFUSED',`Plan ${plan.code} has a service waiting period, but the original employment service start is unknown — record the supported employment service date before electing coverage`);
  const start=subject.service_start;
  const eligible = plan.waitingPeriodMonths ? addMonthsClamped(start, plan.waitingPeriodMonths) : addCalendarDays(start, plan.waitingPeriodDays);
  if (effectiveFrom < eligible) {
    throw new BenefitsError(
      "REFUSED",
      `plan ${plan.code} needs ${plan.waitingPeriodMonths ? `${plan.waitingPeriodMonths} calendar months` : `${plan.waitingPeriodDays} days`} of service — earliest election from ${eligible}`,
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
         and status in ('elected', 'pending_approval', 'active', 'ended')
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
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly lifeEventReason?: string | null;
  /** True when the actor elects for themself (structural self scope). */
  readonly contributionTerms?: readonly EnrollmentContributionInput[];
  readonly classKey?: string | null;
  readonly matchEligible?: boolean | null;
  readonly selfService?: boolean;
  /**
   * True when the actor elects from the Me workspace (HR-10): the
   * hrm.self.request gate plus own-employment proof instead of the
   * hrm.benefits.* grants plain employees do not hold.
   */
  readonly selfRequest?: boolean;
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
  return withOrgTransaction(orgId, async () => {
    if (windowId !== null) await lockEnrollmentWindowAdmission(db, orgId, windowId);
    await lockEmploymentsForScope(db, [employmentId], { orgId, actorId });
    await lockEnrollmentPlanAdmission(db, orgId, employmentId, planId);
    const subject = query.selfRequest
      ? await requireOwnEmploymentForBenefitsSelf(db, orgId, actorId, employmentId)
      : query.selfService
        ? await requireOwnEmploymentForBenefits(db, orgId, actorId, employmentId)
        : await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const versions = await liveEmploymentVersions(db, orgId, employmentId);
    coveringVersion(versions, effectiveFrom);
    const plan = await requireActivePlanInScope(db, orgId, subject, planId, effectiveFrom);
    await requireWaitingSatisfied(db, orgId, employmentId, plan, effectiveFrom);
    const entry = await checkEntry(db, orgId, subject, effectiveFrom, windowId, lifeEventReason);
    await requireNoOverlappingElection(db, orgId, employmentId, planId, effectiveFrom, effectiveTo);
    const status = "elected";
    let insertedRows: Record<string, unknown>[];
    try {
      insertedRows = (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, coverage_level_key, status,
             effective_from, effective_to, employee_amount_per_period,
             employer_amount_per_period, currency, elected_by, created_by, updated_by)
          values (${orgId}, ${employmentId}, ${planId}, ${entry.windowId}, null,
                  ${status}, ${effectiveFrom}::date, ${effectiveTo}::date,
                  null, null,
                  ${plan.currency}, ${actorId}, ${actorId}, ${actorId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows;
    } catch (error) {
      if (isElectionRangeConflict(error)) throw electionRangeConflict();
      throw error;
    }
    const inserted = requireOneRow(insertedRows, "recording the election");
    const dto = toEnrollmentDTO(inserted);
    const eventKind = entry.lifeEvent ? "life_event" : "elected";
    const eventReason = entry.lifeEvent
      ? `life event: ${lifeEventReason}`
      : entry.windowId !== null
        ? "elected inside the open window"
        : "elected";
    await requireContributionSubject(db, orgId, planId, query.classKey, query.matchEligible);
    await recordEnrollmentContributionTerms(db, orgId, actorId, dto.id, effectiveFrom, effectiveTo, query.contributionTerms);
    if (query.classKey !== undefined || query.matchEligible !== undefined) {
      const updated = (await db.execute(sql`update hrm_benefit_enrollments set class_key=${query.classKey ?? null},match_eligible=${query.matchEligible ?? null},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${dto.id} returning id`)).rows;
      requireOneRow(updated, "Recording benefit contribution class and matching eligibility");
    }
    await appendEvent(db, orgId, actorId, dto.id, eventKind, eventReason);
    await submitBenefitEnrollment(orgId, actorId, dto.id);
    return loadEnrollment(db, orgId, dto.id);
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
  readonly contributionTerms?: readonly EnrollmentContributionInput[];
  readonly classKey?: string | null;
  readonly matchEligible?: boolean | null;
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
    if (windowId !== null) await lockEnrollmentWindowAdmission(db, orgId, windowId);
    await lockEmploymentsForScope(db, [employmentId], { orgId, actorId });
    await lockEnrollmentPlanAdmission(db, orgId, employmentId, planId);
    const subject = query.selfService
      ? await requireOwnEmploymentForBenefits(db, orgId, actorId, employmentId)
      : await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const versions = await liveEmploymentVersions(db, orgId, employmentId);
    coveringVersion(versions, effectiveFrom);
    const plan = await requireActivePlanInScope(db, orgId, subject, planId, effectiveFrom);
    const entry = await checkEntry(db, orgId, subject, effectiveFrom, windowId, reason);
    await requireNoOverlappingElection(db, orgId, employmentId, planId, effectiveFrom, null);
    let insertedRows: Record<string, unknown>[];
    try {
      insertedRows = (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, status,
             effective_from, currency, elected_by, created_by, updated_by)
          values (${orgId}, ${employmentId}, ${planId}, ${entry.windowId}, 'waived',
                  ${effectiveFrom}::date, ${plan.currency}, ${actorId}, ${actorId}, ${actorId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows;
    } catch (error) {
      if (isElectionRangeConflict(error)) throw electionRangeConflict();
      throw error;
    }
    const inserted = requireOneRow(insertedRows, "recording the waiver");
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

/** Activation preserves the predecessor until the submitted replacement is authorized. */
async function activateBenefitEnrollment(orgId: string, actorId: string, enrollmentId: string, decision: Record<string, unknown>): Promise<void> {
  const enrollment = requireOneRow((await db.execute<Record<string, unknown>>(sql`select * from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId} for update`)).rows,'Activating benefit coverage');
  if (enrollment.replaces_enrollment_id != null) {
    const predecessorId = String(enrollment.replaces_enrollment_id);
    const endedDay = addCalendarDays(String(enrollment.effective_from).slice(0,10),-1);
    requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set status='ended',effective_to=${endedDay}::date,
      ended_reason='Replaced by an authorized contribution election',updated_by=${actorId},updated_at=now()
      where org_id=${orgId} and id=${predecessorId} and employment_id=${String(enrollment.employment_id)} and plan_id=${String(enrollment.plan_id)} and status='active' returning id`)).rows,'Ending predecessor coverage');
    await appendEvent(db,orgId,actorId,predecessorId,'ended','Replaced by an authorized contribution election');
  }
  requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set status='active',decision_snapshot=${JSON.stringify(decision)}::jsonb,
    updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${enrollmentId} and status in ('elected','pending_approval') returning id`)).rows,'Activating authorized benefit coverage');
  await appendEvent(db,orgId,actorId,enrollmentId,decision.mode==='human' ? 'approved' : 'activated',decision.mode==='not_required' ? 'No approval required by the plan setting' : 'Authorized through the native Benefits workflow');
}

async function submitBenefitEnrollment(orgId: string, actorId: string, enrollmentId: string): Promise<void> {
  await lockFlowSubjectDecision(orgId,BENEFIT_ENROLLMENT_SUBJECT_KIND,enrollmentId);
  const snapshot = requireOneRow((await db.execute<{source:Record<string,unknown>}>(sql`select public.benefit_enrollment_submission_source(${orgId}::uuid,${enrollmentId}::uuid) as source`)).rows,'Pinning benefit contribution submission').source;
  if (!snapshot) throw new BenefitsError('REFUSED','The enrollment is not an editable election — reopen its current record');
  requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${actorId},submitted_at=now(),submission_snapshot=${JSON.stringify(snapshot)}::jsonb,
    updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${enrollmentId} and status='elected' returning id`)).rows,'Recording contribution submission');
  if (snapshot.approvalMode==='none') {
    await activateBenefitEnrollment(orgId,actorId,enrollmentId,{outcome:'approved',mode:'not_required',approvalMode:'none',planId:snapshot.planId});
    return;
  }
  if (snapshot.approvalMode!=='flows') throw new BenefitsError('REFUSED','Choose no approvals or native Flows on this plan before submitting its elections');
  const { runRecordFlows } = await import('../../flows/run.ts');
  const result = await runRecordFlows({kind:'on_submit',source:'api'},BENEFIT_ENROLLMENT_SUBJECT_KIND,enrollmentId,{orgId,userId:actorId});
  if (result.failed) throw new BenefitsError('REFUSED',`Benefits workflow could not submit this election: ${result.runs.filter(r=>r.status==='failed').map(r=>`${r.flowName}: ${r.error ?? 'execution failed'}`).join('; ') || result.error || 'workflow dispatch failed'}. Correct its policy or approver assignment in Flows, then submit again.`);
  const gated = result.runs.find(r=>r.gatesCreated>0), direct=result.runs.find(r=>r.ungatedOutcome==='apply' && r.status==='completed' && r.gatesCreated===0);
  const run=gated ?? direct;
  if (!run) throw new BenefitsError('REFUSED','No Benefits enrollment policy matched this election — configure Benefits enrollment in Flows with approval steps or explicit direct processing');
  requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set status='pending_approval',flow_run_id=${run.runId},updated_by=${actorId},updated_at=now()
    where org_id=${orgId} and id=${enrollmentId} and status='elected' returning id`)).rows,'Submitting enrollment to native Flows');
  if (!gated && direct) {
    const runs=(await db.execute<{id:string;status:string;context:Record<string,unknown>}>(sql`select id,status,context from flow_runs where org_id=${orgId} and subject_kind=${BENEFIT_ENROLLMENT_SUBJECT_KIND} and subject_id=${enrollmentId} and trigger='on_submit' order by created_at,id`)).rows;
    await activateBenefitEnrollment(orgId,actorId,enrollmentId,{outcome:'approved',mode:'automatic',runId:run.runId,runs,gates:[]});
  }
}

/** Native gate release is the sole human decision path for contribution elections. */
export async function releaseBenefitEnrollmentApproval(query: {orgId:string;actorId:string;enrollmentId:string;outcome:'approved'|'rejected';comment?:string|null}): Promise<void> {
  const orgId=requireOrgId(query.orgId),actorId=requireActorId(query.actorId),enrollmentId=requireId(query.enrollmentId,'enrollmentId');
  await withOrgTransaction(orgId,async()=>{
    await requireHrmBenefitsManage(db,orgId,actorId);
    await assertHrmEnabled(db,orgId);
    await lockFlowSubjectDecision(orgId,BENEFIT_ENROLLMENT_SUBJECT_KIND,enrollmentId);
    const enrollment=await loadEnrollment(db,orgId,enrollmentId);
    const subject=await requireHrmBenefitsManageOnEmployment(db,orgId,actorId,enrollment.employmentId);
    if (enrollment.status!=='pending_approval') return;
    const gates=(await db.execute<{id:string;status:string;decided_by:string|null;decided_at:string|null}>(sql`select id,status,decided_by,decided_at::text from flow_gates
      where org_id=${orgId} and subject_kind=${BENEFIT_ENROLLMENT_SUBJECT_KIND} and subject_id=${enrollmentId} order by created_at,id`)).rows;
    if (gates.some(g=>g.status==='pending'||g.status==='escalated')) throw new BenefitsError('REFUSED','Benefit approval stages remain open — complete the assigned decisions in Approvals');
    if (!gates.some(g=>g.status===query.outcome && g.decided_by===actorId)) throw new BenefitsError('REFUSED','No matching native workflow decision authorizes this enrollment — decide its assigned gate in Approvals');
    const runs=(await db.execute<{id:string;status:string;context:Record<string,unknown>}>(sql`select id,status,context from flow_runs where org_id=${orgId} and subject_kind=${BENEFIT_ENROLLMENT_SUBJECT_KIND} and subject_id=${enrollmentId} and trigger='on_submit' order by created_at,id`)).rows;
    if (!enrollment.flowRunId || !runs.some(r=>r.id===enrollment.flowRunId) || runs.some(r=>r.status==='failed')) throw new BenefitsError('REFUSED','The enrollment workflow evidence is missing or failed — review its execution in Flows');
    const decision={outcome:query.outcome,mode:'human',runId:enrollment.flowRunId,runs,gates};
    if (query.outcome==='approved') {
      if (gates.some(g=>g.status==='rejected')) throw new BenefitsError('REFUSED','The election was rejected — create a successor rather than releasing the rejected proposal');
      await requireActivePlanInScope(db,orgId,subject,enrollment.planId,enrollment.effectiveFrom);
      await db.execute(sql`select set_config('openbooks.hrm_benefit_release',${`${orgId}:${enrollmentId}:${actorId}`},true)`);
      await activateBenefitEnrollment(orgId,actorId,enrollmentId,decision);
    } else {
      requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set status='cancelled',decision_snapshot=${JSON.stringify(decision)}::jsonb,updated_by=${actorId},updated_at=now()
        where org_id=${orgId} and id=${enrollmentId} and status='pending_approval' returning id`)).rows,'Rejecting proposed contribution elections');
      await appendEvent(db,orgId,actorId,enrollmentId,'cancelled',query.comment?.trim() || 'Rejected by the native approval workflow');
    }
  });
}

export interface ChangeEnrollmentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly contributionTerms?: readonly EnrollmentContributionInput[];
  readonly classKey?: string | null;
  readonly matchEligible?: boolean | null;
  readonly changeDate: string;
  readonly reason: string;
  /**
   * True when the actor changes from the Me workspace (HR-10): the
   * hrm.self.request gate plus own-employment proof instead of the HR
   * manage grants. The caller bounds the change to an open window.
   */
  readonly selfRequest?: boolean;
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
  return withOrgTransaction(orgId, async () => {
    // HR ordering is unchanged: the manage grant refuses before the
    // enrollment row is touched. The self path authorizes against the
    // row's own employment instead (it must load first to name it).
    if (query.selfRequest !== true) await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const current = await loadEnrollment(db, orgId, enrollmentId);
    const subject = query.selfRequest
      ? await requireOwnEmploymentForBenefitsSelf(db, orgId, actorId, current.employmentId)
      : await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, current.employmentId);
    if (current.status !== "active") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrolment is ${current.status} — only an active enrolment is changed; elect anew otherwise`,
      );
    }
    if (changeDate <= current.effectiveFrom) {
      throw new BenefitsError(
        "REFUSED",
        `change date ${changeDate} is not after the enrolment start ${current.effectiveFrom} — choose a change date after the enrollment start`,
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
    await lockEnrollmentPlanAdmission(db,orgId,current.employmentId,current.planId);
    const otherProposal=(await db.execute(sql`select id from hrm_benefit_enrollments where org_id=${orgId} and employment_id=${current.employmentId}
      and plan_id=${current.planId} and status in ('elected','pending_approval') limit 1`)).rows;
    if (otherProposal.length) throw new BenefitsError('REFUSED','A contribution change already awaits submission or approval — complete or cancel that proposal before creating another');
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_enrollments
            (org_id, employment_id, plan_id, window_id, coverage_level_key, status,
             effective_from, effective_to, employee_amount_per_period,
             employer_amount_per_period, currency, elected_by, created_by, updated_by,replaces_enrollment_id)
          values (${orgId}, ${current.employmentId}, ${current.planId}, ${current.windowId},
                  null,
                  'elected', ${changeDate}::date, ${current.effectiveTo}::date,
                  null, null,
                  ${plan.currency}, ${actorId}, ${actorId}, ${actorId},${enrollmentId})
          returning ${ENROLLMENT_COLUMNS}
        `)
      ).rows,
      "opening the changed enrolment",
    );
    const dto = toEnrollmentDTO(inserted);
    const priorTerms = (await db.execute<EnrollmentContributionInput>(sql`select rule_id as "ruleId",election_mode as "electionMode",elected_rate::text as "electedRate",declared_periods_per_year as "declaredPeriodsPerYear",source_decimal as "sourceDecimal",provenance from hrm_benefit_enrollment_terms where org_id=${orgId} and enrollment_id=${enrollmentId} and effective_from<=${changeDate}::date and (effective_to is null or effective_to>=${changeDate}::date)`)).rows;
    await recordEnrollmentContributionTerms(db, orgId, actorId, dto.id, changeDate, current.effectiveTo, query.contributionTerms ?? priorTerms);
    const subjectConfiguration = (await db.execute<{ class_key: string | null; match_eligible: boolean | null }>(sql`select class_key,match_eligible from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId}`)).rows[0]!;
    await requireContributionSubject(db, orgId, current.planId, query.classKey === undefined ? subjectConfiguration.class_key : query.classKey, query.matchEligible === undefined ? subjectConfiguration.match_eligible : query.matchEligible);
    requireOneRow((await db.execute(sql`update hrm_benefit_enrollments set class_key=${query.classKey === undefined ? subjectConfiguration.class_key : query.classKey},match_eligible=${query.matchEligible === undefined ? subjectConfiguration.match_eligible : query.matchEligible} where org_id=${orgId} and id=${dto.id} returning id`)).rows, "Recording replacement contribution class");
    await appendEvent(db, orgId, actorId, dto.id, "elected", `changed from ${changeDate}: ${reason}`);
    await appendEvent(db, orgId, actorId, dto.id, "changed", `continues enrolment ${enrollmentId} from ${changeDate}`);
    await submitBenefitEnrollment(orgId,actorId,dto.id);
    return loadEnrollment(db,orgId,dto.id);
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
    if (current.status !== "active") return cancelEnrollment({orgId,actorId,enrollmentId,reason});
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

/** Authorized coverage cancellation also closes every still-open native workflow gate. */
export async function cancelEnrollmentFlows(orgId: string, actorId: string, enrollmentId: string): Promise<void> {
  await lockFlowSubjectDecision(orgId,BENEFIT_ENROLLMENT_SUBJECT_KIND,enrollmentId);
  const runs=(await db.execute<{id:string}>(sql`select id from flow_runs where org_id=${orgId} and subject_kind=${BENEFIT_ENROLLMENT_SUBJECT_KIND} and subject_id=${enrollmentId}`)).rows;
  await cancelDispatchRuns(orgId,runs.map(r=>r.id),{actorId});
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
    await cancelEnrollmentFlows(orgId,actorId,enrollmentId);
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

/** Withdraw unused approved coverage without rewriting its submitted evidence. */
export async function withdrawUnusedEnrollment(query: {
  readonly orgId: string; readonly actorId: string; readonly enrollmentId: string; readonly reason: string;
}): Promise<EnrollmentDTO> {
  const orgId = requireOrgId(query.orgId), actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (!reason) throw new BenefitsError("INVALID_INPUT", "Withdrawing unused coverage needs a reason — describe the correction before replacing the election");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const subject = await loadEnrollment(db, orgId, enrollmentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, subject.employmentId);
    await lockEnrollmentPlanAdmission(db, orgId, subject.employmentId, subject.planId);
    // Match enrollment admission's plan-before-contribution lock ordering.
    // Calculation cannot add an allocation between usage check and withdrawal.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:benefit-recurring:${orgId}`},0))`);
    await db.execute(sql`select id from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId} for update`);
    const current = await loadEnrollment(db, orgId, enrollmentId);
    if (current.status !== "active") throw new BenefitsError("BAD_STATE", "Only active unused coverage can be withdrawn — reload the enrollment and choose its current record action");
    const used = (await db.execute(sql`select id from pay_run_benefit_allocations where org_id=${orgId} and enrollment_id=${enrollmentId} limit 1`)).rows;
    if (used.length) throw new BenefitsError("REFUSED", "This coverage has payroll allocation history — preserve it and use a dated successor; discard or recalculate editable payroll before withdrawing unused coverage");
    const proposals = (await db.execute(sql`select id from hrm_benefit_enrollments where org_id=${orgId} and replaces_enrollment_id=${enrollmentId} and status in ('elected','pending_approval') limit 1`)).rows;
    if (proposals.length) throw new BenefitsError("REFUSED", "A successor election awaits approval — complete or cancel that proposal before withdrawing unused coverage");
    await db.execute(sql`select set_config('openbooks.hrm_benefit_withdrawal',${`${orgId}:${enrollmentId}:${actorId}`},true)`);
    const updated = requireOneRow((await db.execute<Record<string, unknown>>(sql`update hrm_benefit_enrollments
      set status='cancelled',ended_reason=${reason},updated_by=${actorId},updated_at=now()
      where org_id=${orgId} and id=${enrollmentId} and status='active' returning ${ENROLLMENT_COLUMNS}`)).rows, "Withdrawing unused benefit coverage");
    await db.execute(sql`select set_config('openbooks.hrm_benefit_withdrawal','',true)`);
    await appendEvent(db, orgId, actorId, enrollmentId, "cancelled", `Unused coverage withdrawn: ${reason}`);
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
  const lastCovered = addCalendarDays(terminatedOn, -1);
  // Only rows still covering at termination: already-lapsed rows keep
  // their history untouched.
  const live = (
    await exec.execute<{ id: string; effective_from: string; status: string }>(sql`
      select id, status, effective_from::text as effective_from
        from hrm_benefit_enrollments
       where org_id = ${orgId} and employment_id = ${employmentId}
         and status in ('elected', 'pending_approval', 'active')
         and (effective_to is null or effective_to >= ${terminatedOn}::date)
    `)
  ).rows;
  for (const row of live) {
    const startsAfter = row.effective_from.slice(0, 10) > lastCovered;
    if (startsAfter || row.status!=="active") {
      if (row.status!=="active") await cancelEnrollmentFlows(orgId,actorId,row.id);
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
