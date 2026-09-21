import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadOwnEmploymentIds, requireHrmSelfRead, requireHrmSelfRequest } from "../authorization.ts";
import { actorPartyOf, SelfServiceError } from "./actor.ts";
import { resolveTeamEmploymentIds } from "./team-read.ts";
import {
  listCycleProgress,
  listGoals,
  listMyReviews,
} from "../performance/performance-read.ts";
import {
  acknowledgeReview,
  submitReview,
  type ReviewDTO,
  type SubmitAnswer,
} from "../performance/reviews.ts";
import { updateGoalProgress } from "../performance/goals.ts";
import { changeEnrollment, electEnrollment } from "../benefits/enrollments.ts";

/**
 * Me-workspace reviews and benefits reads and writes (HR-10).
 *
 * Authority is hrm.self.read (reads) and hrm.self.request (writes) plus
 * the structural scope both keys imply: the party behind the login
 * (actorPartyOf — NO_LINK names the Admin → Users remedy) and the
 * actor's own employments (loadOwnEmploymentIds — a second person's ids
 * can never be named because they can never be supplied). Plain
 * employees hold no hrm.performance.* or hrm.benefits.* grant, so this
 * module never routes through those gates:
 *
 * - Reviews reads reuse the performance-read privacy scope
 *   (listMyReviews: own self reviews plus manager reviews shared with
 *   the subject — an unshared manager review never appears) and then
 *   strip every calibration field: a person never sees calibration
 *   (calibrated ratings, reasons, or the cycle's calibration gap count),
 *   only their own overall rating once shared.
 * - Benefits reads query the actor's own elections (with the STORED
 *   per-period amounts payroll deducts — never a recomputed figure),
 *   the open windows covering their employer subsidiary, their own
 *   dependents, and the plans offered to their subsidiary.
 * - Reviews writes delegate to the existing review/goal services
 *   (submitReview, acknowledgeReview, updateGoalProgress), which enforce
 *   reviewer/subject/worker identity themselves — never a new write path.
 * - Benefits writes delegate to the existing enrollment service
 *   (electEnrollment, changeEnrollment) through the selfRequest gate,
 *   which carries the same own-employment proof under hrm.self.request.
 *   A self-service change additionally requires an open window covering
 *   the employment on the change date — HR may change anytime, the
 *   workspace changes only inside a window.
 *
 * Every refusal a delegated service raises propagates untouched: the
 * route boundary maps it with its message (and remedy) intact.
 */

const HRM_FEATURE_KEY = "hrm" as const;

async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new SelfServiceError(
      "FORBIDDEN",
      "hrm feature is disabled: enable it on Company Settings → Features before using self-service",
    );
  }
}

function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new SelfServiceError("REFUSED", "orgId must be a non-empty string");
  }
  return orgId;
}

function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new SelfServiceError("REFUSED", "actorId must be a non-empty string");
  }
  return actorId;
}

// --- Reviews ---------------------------------------------------------------

/** One review as the subject sees it: calibration fields never leave HR. */
export interface MyReviewSlice {
  readonly id: string;
  readonly cycleId: string;
  readonly cycleName: string;
  readonly kind: "self" | "manager";
  readonly status: string;
  readonly overallRating: string | null;
  readonly submittedAt: string | null;
  readonly sharedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly selfDueOn: string | null;
  readonly managerDueOn: string | null;
  readonly drawerHref: string;
}

export interface MyReviewCycleGroup {
  readonly cycleId: string;
  readonly name: string;
  readonly periodStartOn: string;
  readonly periodEndOn: string;
  readonly selfDueOn: string | null;
  readonly managerDueOn: string | null;
  readonly status: string;
  /** The self-assessment the actor owes in this cycle, when instantiated. */
  readonly mySelf: MyReviewSlice | null;
  /** Manager reviews shared with the actor (never unshared ones). */
  readonly sharedWithMe: MyReviewSlice[];
}

export interface MyGoalRow {
  readonly id: string;
  readonly employmentId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: string;
  readonly progressPercent: number;
}

export interface MyReviewWorkspace {
  readonly cycles: MyReviewCycleGroup[];
  readonly goals: MyGoalRow[];
}

function toSlice(review: ReviewDTO, cycleName: string, selfDueOn: string | null, managerDueOn: string | null): MyReviewSlice {
  if (review.kind !== "self" && review.kind !== "manager") {
    throw new SelfServiceError(
      "REFUSED",
      `review ${review.id} is a peer review — the Me workspace shows self and manager reviews only`,
    );
  }
  return {
    id: review.id,
    cycleId: review.cycleId,
    cycleName,
    kind: review.kind,
    status: review.status,
    // overallRating is the subject's own answer (self) or the shared
    // rating (manager). calibratedRating and calibrationReason stay
    // with HR: a person never sees calibration.
    overallRating: review.overallRating,
    submittedAt: review.submittedAt,
    sharedAt: review.sharedAt,
    acknowledgedAt: review.acknowledgedAt,
    selfDueOn,
    managerDueOn,
    drawerHref: `/hrm/performance?cycle=${encodeURIComponent(review.cycleId)}&review=${encodeURIComponent(review.id)}`,
  };
}

/**
 * The actor's own review cycles: self-assessments owed, manager reviews
 * shared with them, and their own goals with progress. An unshared
 * manager review never appears (listMyReviews admits subjects only once
 * shared); calibration never appears (stripped above and never selected
 * below — the cycle's calibration gap count is HR evidence, not a
 * subject figure).
 */
export async function getMyReviewWorkspace(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<MyReviewWorkspace> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    // NO_LINK before any scoped read: without a person there is no "own".
    await actorPartyOf(db, orgId, actorId);
    const mine = await listMyReviews({ orgId, actorId });
    const cycles = await listCycleProgress({ orgId, actorId });
    const byId = new Map(cycles.map((cycle) => [cycle.id, cycle]));
    const groups = new Map<string, { group: MyReviewCycleGroup; mySelf: MyReviewSlice | null; sharedWithMe: MyReviewSlice[] }>();
    const groupFor = (cycleId: string): { group: MyReviewCycleGroup; mySelf: MyReviewSlice | null; sharedWithMe: MyReviewSlice[] } | null => {
      const cycle = byId.get(cycleId);
      if (!cycle) return null;
      let entry = groups.get(cycleId);
      if (!entry) {
        entry = {
          group: {
            cycleId: cycle.id,
            name: cycle.name,
            periodStartOn: cycle.periodStartOn,
            periodEndOn: cycle.periodEndOn,
            selfDueOn: cycle.selfDueOn,
            managerDueOn: cycle.managerDueOn,
            status: cycle.status,
            mySelf: null,
            sharedWithMe: [],
          },
          mySelf: null,
          sharedWithMe: [],
        };
        groups.set(cycleId, entry);
      }
      return entry;
    };
    for (const review of mine.asReviewer) {
      if (review.kind !== "self") continue;
      const entry = groupFor(review.cycleId);
      if (!entry || entry.mySelf) continue;
      const cycle = byId.get(review.cycleId);
      entry.mySelf = toSlice(review, entry.group.name, cycle?.selfDueOn ?? null, cycle?.managerDueOn ?? null);
    }
    // asSubject holds only shared/acknowledged reviews by construction;
    // the kind guard in toSlice keeps peer reviews out of the workspace.
    for (const review of mine.asSubject) {
      if (review.kind !== "manager") continue;
      const entry = groupFor(review.cycleId);
      if (!entry) continue;
      const cycle = byId.get(review.cycleId);
      entry.sharedWithMe.push(toSlice(review, entry.group.name, cycle?.selfDueOn ?? null, cycle?.managerDueOn ?? null));
    }
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const goals: MyGoalRow[] = [];
    for (const employmentId of own) {
      for (const goal of await listGoals({ orgId, actorId, employmentId })) {
        goals.push({
          id: goal.id,
          employmentId: goal.employmentId,
          title: goal.title,
          dueOn: goal.dueOn,
          status: goal.status,
          progressPercent: goal.progressPercent,
        });
      }
    }
    return {
      cycles: [...groups.values()]
        .map((entry) => ({ ...entry.group, mySelf: entry.mySelf, sharedWithMe: entry.sharedWithMe }))
        .sort((a, b) => (a.periodEndOn < b.periodEndOn ? 1 : -1)),
      goals: goals.sort((a, b) => (a.dueOn ?? "9999-12-31") < (b.dueOn ?? "9999-12-31") ? -1 : 1),
    };
  });
}

/** Submit the actor's own self-assessment through the existing service. */
export async function submitMySelfAssessment(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly reviewId: string;
  readonly answers: readonly SubmitAnswer[];
  readonly overallRating?: string | number | null;
}): Promise<ReviewDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    return submitReview({
      orgId,
      actorId,
      reviewId: query.reviewId,
      answers: query.answers,
      overallRating: query.overallRating,
    });
  });
}

/** Acknowledge a review shared with the actor through the existing service. */
export async function acknowledgeMyReview(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly reviewId: string;
}): Promise<ReviewDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    return acknowledgeReview({ orgId, actorId, reviewId: query.reviewId });
  });
}

/** Record progress on the actor's own goal through the existing service. */
export async function updateMyGoalProgress(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly goalId: string;
  readonly progressPercent: number;
  readonly note?: string | null;
}): Promise<{ id: string; status: string; progressPercent: number }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    const goal = await updateGoalProgress({
      orgId,
      actorId,
      goalId: query.goalId,
      progressPercent: query.progressPercent,
      note: query.note,
    });
    return { id: goal.id, status: goal.status, progressPercent: goal.progressPercent };
  });
}

// --- Manager owed reviews ----------------------------------------------------

export interface OwedReviewRow {
  readonly employmentId: string;
  readonly workerName: string;
  readonly cycleId: string;
  readonly cycleName: string;
  readonly reviewId: string;
  readonly kind: string;
  readonly status: string;
  readonly managerDueOn: string | null;
  readonly drawerHref: string;
}

/**
 * For each direct report, the manager review the actor owes in an open
 * cycle (pending or submitted), with a link to the existing performance
 * drawer. Read-only: answering rides the drawer, never a new surface.
 * Returns an empty list for a report-less caller — the Team tab refuses
 * before this is read, so empty is a fact here, never a refusal.
 */
export async function loadManagerOwedReviews(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<OwedReviewRow[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    const partyId = await actorPartyOf(db, orgId, actorId);
    const today = await businessToday(orgId);
    const reports = await resolveTeamEmploymentIds(db, orgId, actorId, today);
    if (reports.length === 0) return [];
    const params = reports.map((id) => sql`${id}::uuid`);
    const rows = (await db.execute<{
      employmentId: string;
      workerName: string;
      cycleId: string;
      cycleName: string;
      reviewId: string;
      kind: string;
      status: string;
      managerDueOn: string | null;
    }>(sql`
      select r.employment_id as "employmentId",
             p.display_name as "workerName",
             c.id as "cycleId", c.name as "cycleName",
             r.id as "reviewId", r.kind, r.status,
             c.manager_due_on::text as "managerDueOn"
        from hrm_reviews r
        join hrm_review_cycles c
          on c.org_id = r.org_id and c.id = r.cycle_id
        join worker_employments e
          on e.org_id = r.org_id and e.id = r.employment_id
        join parties p
          on p.org_id = r.org_id and p.id = e.worker_party_id
       where r.org_id = ${orgId}
         and c.status = 'open'
         and r.kind = 'manager'
         and r.status in ('pending', 'submitted')
         and r.reviewer_party_id = ${partyId}
         and r.employment_id in (${sql.join(params, sql`, `)})
       order by c.period_end_on desc, p.display_name
    `)).rows;
    return rows.map((row) => ({
      employmentId: row.employmentId,
      workerName: row.workerName,
      cycleId: row.cycleId,
      cycleName: row.cycleName,
      reviewId: row.reviewId,
      kind: row.kind,
      status: row.status,
      managerDueOn: row.managerDueOn != null ? String(row.managerDueOn).slice(0, 10) : null,
      drawerHref: `/hrm/performance?cycle=${encodeURIComponent(row.cycleId)}&review=${encodeURIComponent(row.reviewId)}`,
    }));
  });
}

// --- Benefits ------------------------------------------------------------------

export interface MyElectionRow {
  readonly id: string;
  readonly employmentId: string;
  readonly planCode: string;
  readonly planName: string;
  readonly coverageLevelKey: string | null;
  readonly coverageLabel: string | null;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** The STORED per-period amount payroll deducts — never recomputed here. */
  readonly employeeAmountPerPeriod: string | null;
  readonly employerAmountPerPeriod: string | null;
  readonly currency: string;
}

export interface MyWindowRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly status: string;
}

export interface MyDependentRow {
  readonly id: string;
  readonly displayName: string;
  readonly relationship: string;
}

export interface MyPlanLevelRow {
  readonly levelKey: string;
  readonly label: string;
  readonly employeeCost: string | null;
  readonly employerCost: string | null;
}

export interface MyPlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly requiresApproval: boolean;
  readonly levels: MyPlanLevelRow[];
}

export interface MyBenefitsWorkspace {
  readonly elections: MyElectionRow[];
  readonly openWindows: MyWindowRow[];
  readonly dependents: MyDependentRow[];
  readonly plans: MyPlanRow[];
}

type OwnEmployment = { id: string; subsidiaryId: string };

async function loadOwnEmployments(exec: SqlExecutor, orgId: string, actorId: string): Promise<OwnEmployment[]> {
  const rows = (await exec.execute<{ id: string; subsidiaryId: string }>(sql`
    select e.id, e.employer_subsidiary_id as "subsidiaryId"
      from worker_employments e
      join users u on u.org_id = e.org_id and u.id = ${actorId}
     where e.org_id = ${orgId} and e.worker_party_id = u.party_id and u.party_id is not null
  `)).rows;
  // Zero rows is a fact the caller reports (no employment yet), never a
  // forged id: every downstream predicate runs over these trusted rows.
  return rows.map((row) => ({ id: row.id, subsidiaryId: row.subsidiaryId }));
}

async function liveDepartmentIds(exec: SqlExecutor, orgId: string, employmentId: string): Promise<string[]> {
  const rows = (await exec.execute<{ department_id: string | null }>(sql`
    select v.department_id
      from employment_assignment_versions v
      join employment_assignments s on s.org_id = v.org_id and s.id = v.assignment_id
     where v.org_id = ${orgId} and s.employment_id = ${employmentId}
       and v.recorded_until is null and v.department_id is not null
  `)).rows;
  return [...new Set(rows.map((row) => String(row.department_id)))];
}

type WindowScope = { subsidiaryId: string | null; departmentId: string | null };

function windowScope(appliesTo: unknown): WindowScope {
  const applies = (appliesTo ?? {}) as Record<string, unknown>;
  return {
    subsidiaryId: typeof applies.employer_subsidiary_id === "string" ? applies.employer_subsidiary_id : null,
    departmentId: typeof applies.department_id === "string" ? applies.department_id : null,
  };
}

/**
 * The actor's benefits: current elections with the stored payroll
 * amounts, the open enrollment windows covering their employer
 * subsidiary, dependents on file, and the plans their employer offers
 * for the elect dialog. Gated on hrm.self.read plus the structural own
 * scope — never the hrm.benefits.* grants plain employees do not hold.
 */
export async function getMyBenefitsWorkspace(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<MyBenefitsWorkspace> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRead(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    const own = await loadOwnEmployments(db, orgId, actorId);
    const today = await businessToday(orgId);
    const elections: MyElectionRow[] = [];
    const dependents: MyDependentRow[] = [];
    for (const employment of own) {
      const rows = (await db.execute<Record<string, unknown>>(sql`
        select e.id, e.employment_id as "employmentId",
               plan.code as "planCode", plan.name as "planName",
               e.coverage_level_key as "coverageLevelKey",
               lvl.label as "coverageLabel",
               e.status,
               e.effective_from::text as "effectiveFrom",
               e.effective_to::text as "effectiveTo",
               e.employee_amount_per_period::text as "employeeAmountPerPeriod",
               e.employer_amount_per_period::text as "employerAmountPerPeriod",
               e.currency
          from hrm_benefit_enrollments e
          join hrm_benefit_plans plan on plan.org_id = e.org_id and plan.id = e.plan_id
          left join hrm_benefit_plan_levels lvl
            on lvl.org_id = e.org_id and lvl.plan_id = e.plan_id and lvl.level_key = e.coverage_level_key
         where e.org_id = ${orgId} and e.employment_id = ${employment.id}
         order by e.effective_from desc, plan.code
      `)).rows;
      for (const row of rows) {
        elections.push({
          id: String(row.id),
          employmentId: String(row.employmentId),
          planCode: String(row.planCode),
          planName: String(row.planName),
          coverageLevelKey: row.coverageLevelKey != null ? String(row.coverageLevelKey) : null,
          coverageLabel: row.coverageLabel != null ? String(row.coverageLabel) : null,
          status: String(row.status),
          effectiveFrom: String(row.effectiveFrom).slice(0, 10),
          effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
          employeeAmountPerPeriod: row.employeeAmountPerPeriod != null ? String(row.employeeAmountPerPeriod) : null,
          employerAmountPerPeriod: row.employerAmountPerPeriod != null ? String(row.employerAmountPerPeriod) : null,
          currency: String(row.currency),
        });
      }
      const deps = (await db.execute<Record<string, unknown>>(sql`
        select id, display_name as "displayName", relationship
          from hrm_benefit_dependents
         where org_id = ${orgId} and employment_id = ${employment.id} and is_active
         order by display_name
      `)).rows;
      for (const row of deps) {
        dependents.push({
          id: String(row.id),
          displayName: String(row.displayName),
          relationship: String(row.relationship),
        });
      }
    }
    const subsidiaries = [...new Set(own.map((e) => e.subsidiaryId))];
    const windows = (await db.execute<Record<string, unknown>>(sql`
      select id, name, kind,
             opens_on::text as "opensOn", closes_on::text as "closesOn",
             status, applies_to as "appliesTo"
        from hrm_enrollment_windows
       where org_id = ${orgId} and status = 'open'
         and opens_on <= ${today}::date and closes_on >= ${today}::date
       order by closes_on
    `)).rows;
    const openWindows: MyWindowRow[] = [];
    for (const row of windows) {
      const scope = windowScope(row.appliesTo);
      if (scope.subsidiaryId !== null && !subsidiaries.includes(scope.subsidiaryId)) continue;
      if (scope.departmentId !== null) {
        let covered = false;
        for (const employment of own) {
          if (scope.subsidiaryId !== null && employment.subsidiaryId !== scope.subsidiaryId) continue;
          if ((await liveDepartmentIds(db, orgId, employment.id)).includes(scope.departmentId)) {
            covered = true;
            break;
          }
        }
        if (!covered) continue;
      }
      openWindows.push({
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind),
        opensOn: String(row.opensOn).slice(0, 10),
        closesOn: String(row.closesOn).slice(0, 10),
        status: String(row.status),
      });
    }
    const plans: MyPlanRow[] = [];
    if (subsidiaries.length > 0) {
      const subParams = subsidiaries.map((id) => sql`${id}::uuid`);
      const planRows = (await db.execute<Record<string, unknown>>(sql`
        select id, code, name, kind, currency,
               effective_from::text as "effectiveFrom",
               effective_to::text as "effectiveTo",
               requires_approval as "requiresApproval"
          from hrm_benefit_plans
         where org_id = ${orgId} and is_active
           and effective_from <= ${today}::date
           and (effective_to is null or effective_to >= ${today}::date)
           and (employer_subsidiary_id is null or employer_subsidiary_id in (${sql.join(subParams, sql`, `)}))
         order by code
      `)).rows;
      for (const row of planRows) {
        const levels = (await db.execute<Record<string, unknown>>(sql`
          select level_key as "levelKey", label,
                 employee_cost::text as "employeeCost",
                 employer_cost::text as "employerCost"
            from hrm_benefit_plan_levels
           where org_id = ${orgId} and plan_id = ${String(row.id)}
           order by position
        `)).rows;
        plans.push({
          id: String(row.id),
          code: String(row.code),
          name: String(row.name),
          kind: String(row.kind),
          currency: String(row.currency),
          effectiveFrom: String(row.effectiveFrom).slice(0, 10),
          effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
          requiresApproval: row.requiresApproval === true,
          levels: levels.map((level) => ({
            levelKey: String(level.levelKey),
            label: String(level.label),
            employeeCost: level.employeeCost != null ? String(level.employeeCost) : null,
            employerCost: level.employerCost != null ? String(level.employerCost) : null,
          })),
        });
      }
    }
    return { elections, openWindows, dependents, plans };
  });
}

/** Elect coverage from the Me workspace through the existing service. */
export async function electMyBenefit(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly planId: string;
  readonly windowId?: string | null;
  readonly coverageLevelKey?: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly lifeEventReason?: string | null;
}): Promise<{ id: string; status: string }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    const enrollment = await electEnrollment({
      orgId,
      actorId,
      employmentId: query.employmentId,
      planId: query.planId,
      windowId: query.windowId,
      coverageLevelKey: query.coverageLevelKey,
      effectiveFrom: query.effectiveFrom,
      effectiveTo: query.effectiveTo,
      lifeEventReason: query.lifeEventReason,
      selfRequest: true,
    });
    return { id: enrollment.id, status: enrollment.status };
  });
}

/**
 * Change an active election from the Me workspace: the change date must
 * sit inside an open window covering the employment (subsidiary and
 * department scope, date containment) — outside one the workspace
 * refuses by name instead of recording a windowless change. HR keeps the
 * unconstrained path; this bound lives here, where the self scope lives.
 */
export async function changeMyBenefit(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly changeDate: string;
  readonly coverageLevelKey?: string | null;
  readonly reason: string;
}): Promise<{ id: string; status: string }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    const changeDate = typeof query.changeDate === "string" ? query.changeDate.slice(0, 10) : "";
    const enrollment = (await db.execute<{ employmentId: string }>(sql`
      select employment_id as "employmentId" from hrm_benefit_enrollments
       where org_id = ${orgId} and id = ${query.enrollmentId}
    `)).rows[0];
    if (!enrollment) {
      throw new SelfServiceError(
        "NOT_FOUND",
        "benefit enrollment not found in this organization — reload and retry",
      );
    }
    const own = await loadOwnEmployments(db, orgId, actorId);
    const mine = own.find((e) => e.id === enrollment.employmentId);
    if (!mine) {
      throw new SelfServiceError(
        "FORBIDDEN",
        "that enrollment belongs to another employment — the Me workspace changes only your own elections",
      );
    }
    const windows = (await db.execute<Record<string, unknown>>(sql`
      select applies_to as "appliesTo"
        from hrm_enrollment_windows
       where org_id = ${orgId} and status = 'open'
         and opens_on <= ${changeDate}::date and closes_on >= ${changeDate}::date
    `)).rows;
    let covered = false;
    for (const row of windows) {
      const scope = windowScope(row.appliesTo);
      if (scope.subsidiaryId !== null && scope.subsidiaryId !== mine.subsidiaryId) continue;
      if (scope.departmentId !== null) {
        if (!(await liveDepartmentIds(db, orgId, mine.id)).includes(scope.departmentId)) continue;
      }
      covered = true;
      break;
    }
    if (!covered) {
      throw new SelfServiceError(
        "REFUSED",
        `no open enrollment window covers ${changeDate} for your employment — change inside an open window covering your employer, or ask HR holding hrm.benefits.manage to change outside one`,
      );
    }
    const changed = await changeEnrollment({
      orgId,
      actorId,
      enrollmentId: query.enrollmentId,
      changeDate,
      coverageLevelKey: query.coverageLevelKey,
      reason: query.reason,
      selfRequest: true,
    });
    return { id: changed.id, status: changed.status };
  });
}

// --- Tab capabilities ----------------------------------------------------------

/**
 * Which Me tabs exist as facts: Reviews hides when the org holds no
 * review cycles at all, Benefits when it holds no benefit plans at all.
 * Hidden is a fact, never a refusal — the pages still render their empty
 * states on direct navigation.
 */
export async function selfWorkspaceCapabilities(orgId: string): Promise<{
  readonly hasReviewCycles: boolean;
  readonly hasBenefitPlans: boolean;
}> {
  const org = requireOrgId(orgId);
  return withOrgTransaction(org, async () => {
    const cycles = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_review_cycles where org_id = ${org}
    `)).rows[0]?.n;
    const plans = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_benefit_plans where org_id = ${org}
    `)).rows[0]?.n;
    return { hasReviewCycles: Number(cycles ?? "0") > 0, hasBenefitPlans: Number(plans ?? "0") > 0 };
  });
}
