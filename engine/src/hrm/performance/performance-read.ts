import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { businessToday, daysInCivilMonth, utcDateFromParts } from "../../platform/business-date.ts";
import {
  loadApprovalPerson,
  loadManagedEmploymentIds,
  loadOwnEmploymentIds,
  requireAggregatePerformanceRead,
  requireHrmRetentionRead,
} from "../authorization.ts";
import { HRM_FEATURE_KEY, loadHeadcountAsOf } from "../employment-read.ts";
import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import {
  computeTurnover,
  parseAppliesScope,
  parseCivilDay,
  type TurnoverResult,
} from "./performance-math.ts";
import { loadAnswers, loadReview, type ReviewAnswerDTO, type ReviewDTO } from "./reviews.ts";
import { requireGoalReadAuthority } from "./goals.ts";
import { employerSubsidiaryScope } from "./subsidiary-scope.ts";
import type { CycleDTO } from "./review-cycles.ts";

/**
 * Canonical performance and retention READ service (0196, HR-7).
 *
 * The privacy model is built in from the first row, enforced here — never
 * in the UI alone:
 * - HR (hrm.performance.read): every review in the allowed subsidiaries.
 * - The reviewer (author): their own reviews in any status (they must
 *   answer and submit them).
 * - The subject: their own reviews only once shared or acknowledged.
 * - A manager with reports and no grant: the reviews they author on their
 *   reports, plus their own shared reviews as a subject — nothing else.
 * - Nobody else sees a review: an unreadable id answers NOT_FOUND
 *   uniformly, so existence cannot be probed across the privacy boundary.
 * - Goals: the subject, the manager as of today, or HR.
 * - Exit records and turnover: hrm.retention.read (HR only).
 *
 * Turnover is terminations over average headcount per period and
 * department. Headcount legs reuse loadHeadcountAsOf — the canonical
 * headcount loader — so turnover callers hold hrm.employment.read beside
 * hrm.retention.read; leavers come from the version history with tenure
 * from first service date to termination, and voluntary/regrettable flags
 * from the exit records. Leavers without an exit record count as
 * involuntary until recorded (exitCoverage names the gap); the alternative
 * — dropping them — would undercount attrition silently.
 *
 * Authorization is hardwired to engine/src/hrm/authorization.ts. Do not
 * touch packages/payroll. Existing refusal classes are untouched.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertPerformanceFeature(db: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before reading performance",
    );
  }
}

/** Live performance grant without throwing: true widens to the HR scope. */
async function hasPerformanceGrant(db: SqlExecutor, orgId: string, actorId: string): Promise<boolean> {
  try {
    await requireAggregatePerformanceRead(db, orgId, actorId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Review ids the actor may read: everything in scope for HR, else the
 * reviews they author plus the reviews shared with them as subject. A
 * manager's reports add nothing beyond authorship — the manager reads a
 * report's review only by authoring it.
 */
async function readableReviewIds(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  granted: boolean,
  allowed: Set<string> | null,
): Promise<Set<string> | null> {
  if (granted && allowed === null) return null;
  if (granted) {
    const rows = (await db.execute<{ id: string }>(sql`
      select r.id from hrm_reviews r
      join worker_employments e
        on e.org_id = r.org_id and e.id = r.employment_id
     where r.org_id = ${orgId} and ${employerSubsidiaryScope(allowed, "e.employer_subsidiary_id")}
    `)).rows;
    return new Set(rows.map((row) => row.id));
  }
  const person = await loadApprovalPerson(db, orgId, actorId);
  if (!person.partyId) return new Set();
  const rows = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${orgId}
       and (reviewer_party_id = ${person.partyId}
            or (subject_party_id = ${person.partyId} and status in ('shared', 'acknowledged')))
  `)).rows;
  return new Set(rows.map((row) => row.id));
}

export interface CycleProgressDTO extends ReadCycleDTO {
  /** Reviews visible to the reader (HR scope, or the actor's own slice). */
  readonly scoped: boolean;
  readonly totalSelf: number;
  readonly submittedSelf: number;
  readonly totalManager: number;
  readonly submittedManager: number;
}

async function cycleProgress(
  db: SqlExecutor,
  orgId: string,
  cycleId: string,
  visible: Set<string> | null,
): Promise<{ totalSelf: number; submittedSelf: number; totalManager: number; submittedManager: number }> {
  const rows = (await db.execute<{
    id: string;
    kind: string;
    status: string;
  }>(sql`
    select id, kind, status from hrm_reviews
     where org_id = ${orgId} and cycle_id = ${cycleId}
  `)).rows.filter((row) => visible === null || visible.has(row.id));
  const submitted = new Set(["submitted", "calibrated", "shared", "acknowledged"]);
  return {
    totalSelf: rows.filter((r) => r.kind === "self").length,
    submittedSelf: rows.filter((r) => r.kind === "self" && submitted.has(r.status)).length,
    totalManager: rows.filter((r) => r.kind === "manager").length,
    submittedManager: rows.filter((r) => r.kind === "manager" && submitted.has(r.status)).length,
  };
}

/** A cycle as the read service renders it: the write-service shape plus the
 * template name the table and drawer show (joined here, in the service —
 * loaders never read domain tables directly). */
export interface ReadCycleDTO extends CycleDTO {
  readonly templateName: string;
}

async function loadCycleRow(db: SqlExecutor, orgId: string, cycleId: string): Promise<ReadCycleDTO> {
  const row = (await db.execute<{
    id: string;
    templateId: string;
    templateName: string;
    name: string;
    periodStartOn: string;
    periodEndOn: string;
    selfDueOn: string | null;
    managerDueOn: string | null;
    status: string;
    appliesTo: unknown;
    managerGapCount: number;
    openedAt: string | null;
    closedAt: string | null;
  }>(sql`
    select c.id,
           c.template_id as "templateId",
           t.name as "templateName",
           c.name,
           period_start_on::text as "periodStartOn",
           period_end_on::text as "periodEndOn",
           self_due_on::text as "selfDueOn",
           manager_due_on::text as "managerDueOn",
           status,
           applies_to as "appliesTo",
           manager_gap_count as "managerGapCount",
           opened_at as "openedAt",
           closed_at as "closedAt"
      from hrm_review_cycles c
      join hrm_review_templates t
        on t.org_id = c.org_id and t.id = c.template_id
     where c.org_id = ${orgId} and c.id = ${cycleId}
  `)).rows[0];
  if (!row) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `review cycle ${cycleId} is not visible in this organization — check the id or the organization`,
    );
  }
  if (!["draft", "open", "calibrating", "closed"].includes(row.status)) {
    throw new HrmPerformanceError("BAD_STATE", `review cycle ${cycleId} carries an unknown status`);
  }
  return {
    id: row.id,
    templateId: row.templateId,
    templateName: row.templateName,
    name: row.name,
    periodStartOn: row.periodStartOn,
    periodEndOn: row.periodEndOn,
    selfDueOn: row.selfDueOn,
    managerDueOn: row.managerDueOn,
    status: row.status as CycleDTO["status"],
    appliesTo: parseAppliesScope(row.appliesTo),
    managerGapCount: row.managerGapCount,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

/**
 * Cycles with progress. HR sees every cycle with org-wide counts; a
 * structural viewer (manager with reports, no grant) sees only the cycles
 * containing their own readable reviews, with counts over that slice.
 */
export async function listCycleProgress(args: {
  orgId: string;
  actorId: string;
}): Promise<CycleProgressDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const granted = await hasPerformanceGrant(db, orgId, actorId);
    const allowed = granted ? await actorAllowedSubsidiaryIds(db, orgId, actorId) : null;
    const visible = await readableReviewIds(db, orgId, actorId, granted, allowed);
    const cycles = (await db.execute<{ id: string }>(sql`
      select id from hrm_review_cycles
       where org_id = ${orgId}
       order by period_end_on desc, created_at desc
    `)).rows;
    const out: CycleProgressDTO[] = [];
    for (const { id } of cycles) {
      const cycle = await loadCycleRow(db, orgId, id);
      const progress = await cycleProgress(db, orgId, id, visible);
      // A structural viewer sees only cycles they participate in; HR sees all.
      if (!granted && progress.totalSelf + progress.totalManager === 0) continue;
      out.push({ ...cycle, scoped: !granted, ...progress });
    }
    return out;
  });
}

/**
 * One subject-safe projection for every subject-facing read: the
 * calibration justification (calibrationReason) is HR and reviewer
 * evidence, never subject evidence. HR (performance read grant) and the
 * review's own reviewer see the full row; a subject-only reader sees the
 * calibrated rating with its share note, never the reason. Applied here —
 * never in the UI alone — so every read surface strips identically.
 */
function projectReviewForReader(
  review: ReviewDTO,
  args: { granted: boolean; actorPartyId: string | null },
): ReviewDTO {
  if (args.granted) return review;
  if (args.actorPartyId !== null && args.actorPartyId === review.reviewerPartyId) return review;
  if (review.calibrationReason === null) return review;
  return { ...review, calibrationReason: null };
}

export interface CycleDetailDTO extends CycleProgressDTO {
  readonly reviews: ReviewDTO[];
}

/** One cycle with its readable reviews. Unreadable cycle ids answer NOT_FOUND. */
export async function getCycleDetail(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<CycleDetailDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const granted = await hasPerformanceGrant(db, orgId, actorId);
    const allowed = granted ? await actorAllowedSubsidiaryIds(db, orgId, actorId) : null;
    const visible = await readableReviewIds(db, orgId, actorId, granted, allowed);
    const cycle = await loadCycleRow(db, orgId, cycleId);
    const progress = await cycleProgress(db, orgId, cycleId, visible);
    if (!granted && progress.totalSelf + progress.totalManager === 0) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        `review cycle ${cycleId} is not visible in this organization — check the id or the organization`,
      );
    }
    const ids = (await db.execute<{ id: string }>(sql`
      select id from hrm_reviews
       where org_id = ${orgId} and cycle_id = ${cycleId}
       order by created_at
    `)).rows
      .map((row) => row.id)
      .filter((id) => visible === null || visible.has(id));
    const person = await loadApprovalPerson(db, orgId, actorId);
    const reviews: ReviewDTO[] = [];
    for (const id of ids) {
      reviews.push(projectReviewForReader(await readReviewRow(db, orgId, id), { granted, actorPartyId: person.partyId }));
    }
    return { ...cycle, scoped: !granted, ...progress, reviews };
  });
}

async function readReviewRow(db: SqlExecutor, orgId: string, reviewId: string): Promise<ReviewDTO> {
  const stored = await loadReview(db, orgId, reviewId);
  if (!["self", "manager", "peer"].includes(stored.kind)) {
    throw new HrmPerformanceError("BAD_STATE", `review ${reviewId} carries an unknown kind`);
  }
  if (!["pending", "submitted", "calibrated", "shared", "acknowledged"].includes(stored.status)) {
    throw new HrmPerformanceError("BAD_STATE", `review ${reviewId} carries an unknown status`);
  }
  return {
    id: stored.id,
    cycleId: stored.cycleId,
    cycleStatus: stored.cycleStatus,
    employmentId: stored.employmentId,
    subjectPartyId: stored.subjectPartyId,
    reviewerPartyId: stored.reviewerPartyId,
    kind: stored.kind as ReviewDTO["kind"],
    status: stored.status as ReviewDTO["status"],
    overallRating: stored.overallRating,
    calibratedRating: stored.calibratedRating,
    calibrationReason: stored.calibrationReason,
    calibratedShareNote: stored.calibratedShareNote,
    submittedAt: stored.submittedAt,
    sharedAt: stored.sharedAt,
    acknowledgedAt: stored.acknowledgedAt,
  };
}

export interface ReviewDetailDTO {
  readonly review: ReviewDTO;
  readonly answers: ReviewAnswerDTO[];
}

/**
 * One review with its snapshot answers. Readable by HR, by its reviewer,
 * and by its subject once shared — anyone else gets NOT_FOUND, never a
 * refusal that confirms the review exists.
 */
export async function getReviewDetail(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
}): Promise<ReviewDetailDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const granted = await hasPerformanceGrant(db, orgId, actorId);
    const allowed = granted ? await actorAllowedSubsidiaryIds(db, orgId, actorId) : null;
    const visible = await readableReviewIds(db, orgId, actorId, granted, allowed);
    if (visible !== null && !visible.has(reviewId)) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        `review ${reviewId} is not visible in this organization — check the id or the organization`,
      );
    }
    if (visible === null && allowed !== null) {
      // HR with a restricted subsidiary scope: the review's employment
      // must sit inside it, or the id answers as missing.
      const scope = (await db.execute<{ employerSubsidiaryId: string }>(sql`
        select e.employer_subsidiary_id as "employerSubsidiaryId"
          from hrm_reviews r
          join worker_employments e
            on e.org_id = r.org_id and e.id = r.employment_id
         where r.org_id = ${orgId} and r.id = ${reviewId}
      `)).rows[0];
      if (!scope || !allowed.has(scope.employerSubsidiaryId)) {
        throw new HrmPerformanceError(
          "NOT_FOUND",
          `review ${reviewId} is not visible in this organization — check the id or the organization`,
        );
      }
    }
    const stored = await readReviewRow(db, orgId, reviewId);
    const answers = await loadAnswers(db, orgId, reviewId);
    // HR-17 calibrated share: the employee-visible share shows the
    // calibrated rating with the note that calibration occurred — never
    // the delta, never the justification. Stripped through the shared
    // subject-safe projection, never in the UI alone.
    const person = await loadApprovalPerson(db, orgId, actorId);
    const review = projectReviewForReader(stored, { granted, actorPartyId: person.partyId });
    return { review, answers };
  });
}

export interface MyReviewsDTO {
  readonly asSubject: ReviewDTO[];
  readonly asReviewer: ReviewDTO[];
}

/** The self-service inbox: shared reviews to acknowledge, drafts to answer. */
export async function listMyReviews(args: { orgId: string; actorId: string }): Promise<MyReviewsDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const granted = await hasPerformanceGrant(db, orgId, actorId);
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (!person.partyId) return { asSubject: [], asReviewer: [] };
    const rows = (await db.execute<{ id: string; subjectPartyId: string }>(sql`
      select r.id, r.subject_party_id as "subjectPartyId"
        from hrm_reviews r
        join hrm_review_cycles c on c.org_id = r.org_id and c.id = r.cycle_id
       where r.org_id = ${orgId}
         and (r.reviewer_party_id = ${person.partyId}
              or (r.subject_party_id = ${person.partyId} and r.status in ('shared', 'acknowledged')))
       order by c.period_end_on desc, r.created_at desc
    `)).rows;
    const asSubject: ReviewDTO[] = [];
    const asReviewer: ReviewDTO[] = [];
    for (const row of rows) {
      const review = projectReviewForReader(await readReviewRow(db, orgId, row.id), {
        granted,
        actorPartyId: person.partyId,
      });
      if (row.subjectPartyId === person.partyId && review.reviewerPartyId !== person.partyId) {
        asSubject.push(review);
      } else {
        asReviewer.push(review);
      }
    }
    return { asSubject, asReviewer };
  });
}

// Standalone type alias (not an interface): drizzle's execute row generic
// requires Record<string, unknown>, which only object-literal type aliases
// satisfy through the implicit index signature.
export type GoalListDTO = {
  readonly id: string;
  readonly employmentId: string;
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: string;
  readonly progressPercent: number;
  readonly cycleId: string | null;
};

/**
 * Goals for employments the actor may see: their own, their reports' as of
 * today, or everything in scope for HR. One employmentId narrows; omitted
 * lists across the whole visible set.
 */
export async function listGoals(args: {
  orgId: string;
  actorId: string;
  employmentId?: string;
}): Promise<GoalListDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId = args.employmentId == null ? null : requireId("employmentId", args.employmentId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    let employments: string[];
    if (employmentId !== null) {
      await requireGoalReadAuthority(db, orgId, actorId, employmentId);
      employments = [employmentId];
    } else {
      const granted = await hasPerformanceGrant(db, orgId, actorId);
      const own = await loadOwnEmploymentIds(db, orgId, actorId);
      const managed = await loadManagedEmploymentIds(db, orgId, actorId, await businessToday(orgId));
      if (granted) {
        const allowed = await actorAllowedSubsidiaryIds(db, orgId, actorId);
        const scopeFilter = allowed === null
          ? sql``
          : sql`and ${employerSubsidiaryScope(allowed, "employer_subsidiary_id")}`;
        const rows = (await db.execute<{ id: string }>(sql`
          select id from worker_employments where org_id = ${orgId}
          ${scopeFilter}
        `)).rows;
        employments = [...new Set([...rows.map((r) => r.id), ...own, ...managed])];
      } else {
        employments = [...new Set([...own, ...managed])];
      }
    }
    if (employments.length === 0) return [];
    const params = employments.map((id) => sql`${id}::uuid`);
    const rows = (await db.execute<GoalListDTO>(sql`
      select id,
             employment_id as "employmentId",
             title,
             due_on::text as "dueOn",
             status,
             progress_percent as "progressPercent",
             cycle_id as "cycleId"
        from hrm_goals
       where org_id = ${orgId} and employment_id in (${sql.join(params, sql`, `)})
       order by due_on nulls last, created_at desc
    `)).rows;
    return rows;
  });
}

export interface TurnoverPeriodInput {
  readonly start: string;
  readonly end: string;
}

export interface TurnoverRowDTO extends TurnoverResult {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly headcountStart: number;
  readonly headcountEnd: number;
  readonly terminations: number;
  readonly voluntary: number;
  readonly involuntary: number;
  readonly regrettable: number;
  /** Leavers with an exit record / all leavers — the evidence gap. */
  readonly exitCoverage: number | null;
}

export interface TurnoverDTO {
  readonly periods: TurnoverRowDTO[];
}

/**
 * Turnover per period and department. HR-only (hrm.retention.read), and —
 * because the headcount legs reuse the canonical loader — the caller also
 * holds hrm.employment.read. Each leg reads as known at its own date (end
 * of day), so a termination recorded mid-period counts at the start and
 * not at the end; leavers come from the version history with tenure from
 * first service date to termination, and voluntary/regrettable flags from
 * the exit records. Leavers without an exit record count as involuntary
 * until recorded (exitCoverage names the gap); the alternative — dropping
 * them — would undercount attrition silently.
 */
export async function getTurnover(args: {
  orgId: string;
  actorId: string;
  periods: readonly TurnoverPeriodInput[];
  departmentId?: string | null;
}): Promise<TurnoverDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  if (!Array.isArray(args.periods) || args.periods.length === 0 || args.periods.length > 24) {
    throw new HrmPerformanceError(
      "INVALID_INPUT",
      "periods must list 1 to 24 {start, end} civil-date ranges",
    );
  }
  const periods = args.periods.map((p) => ({
    start: mathRefusal("INVALID_INPUT", () => parseCivilDay(p.start, "period start")),
    end: mathRefusal("INVALID_INPUT", () => parseCivilDay(p.end, "period end")),
  }));
  for (const p of periods) {
    if (p.end <= p.start) {
      throw new HrmPerformanceError(
        "INVALID_INPUT",
        `turnover period ends ${p.end} before it starts ${p.start}`,
      );
    }
  }
  const departmentId =
    args.departmentId == null ? null : requireId("departmentId", args.departmentId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireHrmRetentionRead(db, orgId, actorId);
    const out: TurnoverRowDTO[] = [];
    for (const period of periods) {
      // Each leg reads as known at its OWN date (end of day): a termination
      // recorded mid-period supersedes the start version, so as-known-now
      // would drop every mid-period leaver from the start headcount and
      // inflate the rate. Same-day late recordings belong to the next
      // reading — the standard no-restatement reporting semantic.
      const startHead = await loadHeadcountAsOf(db, {
        orgId,
        actorId,
        effectiveDate: period.start,
        knownAt: `${period.start}T23:59:59Z`,
      });
      const endHead = await loadHeadcountAsOf(db, {
        orgId,
        actorId,
        effectiveDate: period.end,
        knownAt: `${period.end}T23:59:59Z`,
      });
      // The numerator stays over the actor's own headcount denominator
      // below: a restricted HR counts only the leavers they cover.
      const leavers = await loadLeavers(db, orgId, period.start, period.end, departmentId, allowed);
      // Department grain: headcount groups collapse (subsidiary,
      // department) to department; leavers group by termination
      // department. Null department is its own row ("unassigned").
      const departments = new Set<string | null>();
      for (const g of [...startHead.groups, ...endHead.groups]) {
        if (departmentId !== null && g.departmentId !== departmentId) continue;
        departments.add(g.departmentId);
      }
      for (const leaver of leavers) departments.add(leaver.departmentId);
      if (departments.size === 0) departments.add(null);
      const names = await departmentNames(db, orgId, [...departments].filter((d) => d !== null) as string[]);
      for (const dept of departments) {
        const startCount = startHead.groups
          .filter((g) => g.departmentId === dept && (departmentId === null || g.departmentId === departmentId))
          .reduce((n, g) => n + g.headcount, 0);
        const endCount = endHead.groups
          .filter((g) => g.departmentId === dept && (departmentId === null || g.departmentId === departmentId))
          .reduce((n, g) => n + g.headcount, 0);
        const deptLeavers = leavers.filter((l) => l.departmentId === dept);
        const voluntary = deptLeavers.filter((l) => l.isVoluntary).length;
        const regrettable = deptLeavers.filter((l) => l.isRegrettable).length;
        const withExit = deptLeavers.filter((l) => l.hasExit).length;
        const math = mathRefusal("REFUSED", () =>
          computeTurnover({
            headcountStart: startCount,
            headcountEnd: endCount,
            terminations: deptLeavers.length,
            voluntary,
            regrettable,
            tenureDays: deptLeavers.map((l) => l.tenureDays),
          }),
        );
        out.push({
          periodStart: period.start,
          periodEnd: period.end,
          departmentId: dept,
          departmentName: dept === null ? null : (names.get(dept) ?? null),
          headcountStart: startCount,
          headcountEnd: endCount,
          terminations: deptLeavers.length,
          voluntary,
          involuntary: deptLeavers.length - voluntary,
          regrettable,
          exitCoverage: deptLeavers.length === 0 ? null : withExit / deptLeavers.length,
          ...math,
        });
      }
    }
    return { periods: out };
  });
}

type LeaverRow = {
  employmentId: string;
  departmentId: string | null;
  tenureDays: number;
  isVoluntary: boolean;
  isRegrettable: boolean;
  hasExit: boolean;
};

/**
 * Legal-entity scope for retention aggregates, on the joined employment
 * alias `e`: unrestricted HR keeps the org-wide numbers, a restricted HR
 * counts only the employments they cover. Callers return [] early on an
 * empty set — `in ()` is not valid SQL — so an empty scope matches nothing
 * instead of everything.
 */
function retentionScopeCondition(allowed: Set<string> | null) {
  return allowed === null
    ? sql``
    : sql`and ${employerSubsidiaryScope(allowed, "e.employer_subsidiary_id")}`;
}

async function loadLeavers(
  db: SqlExecutor,
  orgId: string,
  start: string,
  end: string,
  departmentId: string | null,
  allowed: Set<string> | null,
): Promise<LeaverRow[]> {
  if (allowed !== null && allowed.size === 0) return [];
  // Terminated versions starting inside (start, end]: the service ended in
  // this period. Recorded-live only for the termination itself — but the
  // first service date spans ALL versions: the opening version is
  // superseded by definition, and reading only live rows would tenure
  // every leaver at zero days.
  const rows = (await db.execute<{
    employmentId: string;
    terminatedFrom: string;
    firstFrom: string;
  }>(sql`
    select t.employment_id as "employmentId",
           t.effective_from::text as "terminatedFrom",
           (select min(effective_from)::text from worker_employment_versions
             where org_id = ${orgId} and employment_id = t.employment_id) as "firstFrom"
      from worker_employment_versions t
      join worker_employments e
        on e.org_id = t.org_id and e.id = t.employment_id
     where t.org_id = ${orgId}
       and t.status = 'terminated'
       and t.recorded_until is null
       and t.effective_from > ${start}::date
       and t.effective_from <= ${end}::date
       ${retentionScopeCondition(allowed)}
  `)).rows;
  const out: LeaverRow[] = [];
  for (const row of rows) {
    if (!row.firstFrom) continue;
    const tenureDays = Math.round(
      (Date.parse(`${row.terminatedFrom}T00:00:00Z`) - Date.parse(`${row.firstFrom}T00:00:00Z`)) / 86400000,
    );
    const dept = (await db.execute<{ departmentId: string | null }>(sql`
      select av.department_id as "departmentId"
        from employment_assignment_versions av
       where av.org_id = ${orgId}
         and av.employment_id = ${row.employmentId}
         and av.is_primary
         and av.recorded_until is null
         and av.effective_from <= ${row.terminatedFrom}::date
         and (av.effective_to is null or av.effective_to > ${row.terminatedFrom}::date)
       order by av.version_no desc
       limit 1
    `)).rows[0];
    const departmentId_ = dept?.departmentId ?? null;
    if (departmentId !== null && departmentId_ !== departmentId) continue;
    const exit = (await db.execute<{ isVoluntary: boolean; isRegrettable: boolean | null }>(sql`
      select is_voluntary as "isVoluntary", is_regrettable as "isRegrettable"
        from hrm_exit_records
       where org_id = ${orgId} and employment_id = ${row.employmentId}
    `)).rows[0];
    out.push({
      employmentId: row.employmentId,
      departmentId: departmentId_,
      tenureDays: Math.max(0, tenureDays),
      isVoluntary: exit?.isVoluntary ?? false,
      isRegrettable: exit?.isRegrettable ?? false,
      hasExit: !!exit,
    });
  }
  return out;
}

async function departmentNames(
  db: SqlExecutor,
  orgId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const params = ids.map((id) => sql`${id}::uuid`);
  const rows = (await db.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from departments
     where org_id = ${orgId} and id in (${sql.join(params, sql`, `)})
  `)).rows;
  return new Map(rows.map((row) => [row.id, row.name]));
}

export interface RetentionOverviewDTO {
  /** Last-12-months org-wide turnover (null rates when the org was empty). */
  readonly trailingTwelveMonths: TurnoverRowDTO | null;
  readonly regrettableLeavers: number;
  /** Terminated employments as of today with no exit record. */
  readonly missingExitRecords: {
    employmentId: string;
    workerPartyId: string;
    workerName: string;
    departmentName: string | null;
    terminatedFrom: string;
  }[];
  /** Exit records with no interview held. */
  readonly exitRecordsWithoutInterview: { exitId: string; employmentId: string }[];
}

/**
 * The Retention cockpit panel: trailing-twelve-months turnover, the
 * regrettable count, terminated employments missing their exit record, and
 * exit records missing their interview. HR-only.
 */
export async function getRetentionOverview(args: {
  orgId: string;
  actorId: string;
}): Promise<RetentionOverviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireHrmRetentionRead(db, orgId, actorId);
    const today = await businessToday(orgId);
    const start = shiftMonths(today, -12);
    // Start leg as known at its own date (a termination recorded since
    // would otherwise drop its leaver from the start headcount); the end
    // leg is today, read as known now.
    const startHead = await loadHeadcountAsOf(db, {
      orgId,
      actorId,
      effectiveDate: start,
      knownAt: `${start}T23:59:59Z`,
    });
    const endHead = await loadHeadcountAsOf(db, {
      orgId,
      actorId,
      effectiveDate: today,
      knownAt: new Date().toISOString(),
    });
    const leavers = await loadLeavers(db, orgId, start, today, null, allowed);
    const voluntary = leavers.filter((l) => l.isVoluntary).length;
    const regrettable = leavers.filter((l) => l.isRegrettable).length;
    const withExit = leavers.filter((l) => l.hasExit).length;
    const math = mathRefusal("REFUSED", () =>
      computeTurnover({
        headcountStart: startHead.total,
        headcountEnd: endHead.total,
        terminations: leavers.length,
        voluntary,
        regrettable,
        tenureDays: leavers.map((l) => l.tenureDays),
      }),
    );
    // Exit gaps list only the employments the actor can open: a
    // restricted HR never sees another legal entity's missing records or
    // uninterviewed exits.
    const missing = (allowed !== null && allowed.size === 0)
      ? []
      : (await db.execute<{
          employmentId: string;
          workerPartyId: string;
          workerName: string;
          departmentName: string | null;
          terminatedFrom: string;
        }>(sql`
      select e.id as "employmentId",
             e.worker_party_id as "workerPartyId",
             coalesce(p.display_name, '—') as "workerName",
             dept.name as "departmentName",
             v.effective_from::text as "terminatedFrom"
        from worker_employments e
        left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
        join worker_employment_versions v
          on v.org_id = e.org_id and v.employment_id = e.id
         and v.recorded_until is null
         and v.status = 'terminated'
         and v.effective_from <= ${today}::date
         and (v.effective_to is null or v.effective_to > ${today}::date)
        left join hrm_exit_records x
          on x.org_id = e.org_id and x.employment_id = e.id
        left join lateral (
          select d.name
            from employment_assignment_versions av
            join departments d on d.org_id = av.org_id and d.id = av.department_id
           where av.org_id = e.org_id and av.employment_id = e.id and av.is_primary
             and av.recorded_until is null
             and av.effective_from <= v.effective_from
             and (av.effective_to is null or av.effective_to > v.effective_from)
           order by av.version_no desc
           limit 1
        ) dept on true
       where e.org_id = ${orgId} and x.id is null
         ${retentionScopeCondition(allowed)}
       order by v.effective_from desc
    `)).rows;
    const noInterview = (allowed !== null && allowed.size === 0)
      ? []
      : (await db.execute<{ exitId: string; employmentId: string }>(sql`
      select x.id as "exitId", x.employment_id as "employmentId"
        from hrm_exit_records x
        join worker_employments e
          on e.org_id = x.org_id and e.id = x.employment_id
       where x.org_id = ${orgId} and x.interview_held_on is null
         ${retentionScopeCondition(allowed)}
       order by x.recorded_at desc
    `)).rows;
    return {
      trailingTwelveMonths: {
        periodStart: start,
        periodEnd: today,
        departmentId: null,
        departmentName: null,
        headcountStart: startHead.total,
        headcountEnd: endHead.total,
        terminations: leavers.length,
        voluntary,
        involuntary: leavers.length - voluntary,
        regrettable,
        exitCoverage: leavers.length === 0 ? null : withExit / leavers.length,
        ...math,
      },
      regrettableLeavers: regrettable,
      missingExitRecords: missing,
      exitRecordsWithoutInterview: noInterview,
    };
  });
}

/** Shift a civil date by whole months, clamped to month end. */
function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999; the clamp-then-setUTCDate shape is unchanged.
  const dt = utcDateFromParts(y!, m! - 1 + months, 1);
  const lastDay = daysInCivilMonth(dt.getUTCFullYear(), dt.getUTCMonth() + 1);
  dt.setUTCDate(Math.min(d!, lastDay));
  return dt.toISOString().slice(0, 10);
}
