import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import {
  HrmAuthorizationError,
  loadApprovalPerson,
  requireAggregatePerformanceManage,
  requireAggregatePerformanceRead,
} from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import { assertRatingInScale, parseRatingScale } from "./performance-math.ts";

/**
 * Governed HRM reviews (0196, HR-7): submit, calibrate, share, acknowledge,
 * reopen. Every transition appends its review event in the SAME transaction
 * as the status write, so a partial effect cannot exist; every conditional
 * write asserts its affected row count.
 *
 * Authorship is identity, never input: the actor's party comes from
 * users.party_id on the transaction runner. Only the reviewer submits
 * their review; only HR (hrm.performance.manage) calibrates; the reviewer
 * or HR shares a manager or peer review to the subject; only the subject
 * acknowledges; only HR reopens a submitted or calibrated review with a
 * reason. A self review is already the subject's — sharing it is refused
 * as meaningless. Sharing while the cycle calibrates is refused: the
 * calibration round has not closed.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export type ReviewKind = "self" | "manager" | "peer";
export type ReviewStatus = "pending" | "submitted" | "calibrated" | "shared" | "acknowledged";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertPerformanceFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before answering reviews",
    );
  }
}

export interface ReviewDTO {
  readonly id: string;
  readonly cycleId: string;
  readonly cycleStatus: string;
  readonly employmentId: string;
  readonly subjectPartyId: string;
  readonly reviewerPartyId: string;
  readonly kind: ReviewKind;
  readonly status: ReviewStatus;
  readonly overallRating: string | null;
  readonly calibratedRating: string | null;
  readonly calibrationReason: string | null;
  // HR-17: the employee-visible share shows the calibrated rating with a
  // note that calibration occurred — never the delta, never the
  // justification (performance-read.ts strips calibrationReason for
  // subject-only readers).
  readonly calibratedShareNote: string | null;
  readonly submittedAt: string | null;
  readonly sharedAt: string | null;
  readonly acknowledgedAt: string | null;
}

/** One privacy projection shared by read and mutation responses. */
export function projectReviewForReader(
  review: ReviewDTO,
  args: { granted: boolean; actorPartyId: string | null },
): ReviewDTO {
  if (args.granted) return review;
  if (args.actorPartyId !== null && args.actorPartyId === review.reviewerPartyId) return review;
  if (review.calibrationReason === null) return review;
  return { ...review, calibrationReason: null };
}

async function projectReviewForActor(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  actorPartyId: string | null,
  review: ReviewDTO,
): Promise<ReviewDTO> {
  let granted = false;
  try {
    await requireAggregatePerformanceRead(exec, orgId, actorId);
    granted = true;
  } catch {
    // The caller may have a valid mutation grant without the broader read
    // grant; that must not widen the mutation response's private fields.
  }
  return projectReviewForReader(review, { granted, actorPartyId });
}

// Standalone type alias (not an interface): drizzle's execute row generic
// requires Record<string, unknown>, which only object-literal type aliases
// satisfy through the implicit index signature.
export type ReviewAnswerDTO = {
  readonly id: string;
  readonly sectionTitle: string;
  readonly questionPrompt: string | null;
  readonly position: number;
  readonly answerKind: string;
  readonly rating: string | null;
  readonly text: string | null;
  readonly required: boolean;
};

type StoredReview = {
  id: string;
  cycleId: string;
  cycleStatus: string;
  employmentId: string;
  employerSubsidiaryId: string;
  subjectPartyId: string;
  reviewerPartyId: string;
  kind: string;
  status: string;
  overallRating: string | null;
  calibratedRating: string | null;
  calibrationReason: string | null;
  calibratedShareNote: string | null;
  submittedAt: string | null;
  sharedAt: string | null;
  acknowledgedAt: string | null;
};

function toReviewDTO(row: StoredReview): ReviewDTO {
  if (!["self", "manager", "peer"].includes(row.kind)) {
    throw new HrmPerformanceError("BAD_STATE", `review ${row.id} carries an unknown kind`);
  }
  if (!["pending", "submitted", "calibrated", "shared", "acknowledged"].includes(row.status)) {
    throw new HrmPerformanceError("BAD_STATE", `review ${row.id} carries an unknown status`);
  }
  return {
    id: row.id,
    cycleId: row.cycleId,
    cycleStatus: row.cycleStatus,
    employmentId: row.employmentId,
    subjectPartyId: row.subjectPartyId,
    reviewerPartyId: row.reviewerPartyId,
    kind: row.kind as ReviewKind,
    status: row.status as ReviewStatus,
    overallRating: row.overallRating,
    calibratedRating: row.calibratedRating,
    calibrationReason: row.calibrationReason,
    calibratedShareNote: row.calibratedShareNote,
    submittedAt: row.submittedAt,
    sharedAt: row.sharedAt,
    acknowledgedAt: row.acknowledgedAt,
  };
}

async function loadReview(exec: SqlExecutor, orgId: string, reviewId: string): Promise<StoredReview> {
  const row = (await exec.execute<StoredReview>(sql`
    select r.id,
           r.cycle_id as "cycleId",
           c.status as "cycleStatus",
           r.employment_id as "employmentId",
           e.employer_subsidiary_id as "employerSubsidiaryId",
           r.subject_party_id as "subjectPartyId",
           r.reviewer_party_id as "reviewerPartyId",
           r.kind, r.status,
           r.overall_rating::text as "overallRating",
           r.calibrated_rating::text as "calibratedRating",
           r.calibration_reason as "calibrationReason",
           r.calibrated_share_note as "calibratedShareNote",
           r.submitted_at as "submittedAt",
           r.shared_at as "sharedAt",
           r.acknowledged_at as "acknowledgedAt"
      from hrm_reviews r
      join hrm_review_cycles c
        on c.org_id = r.org_id and c.id = r.cycle_id
      join worker_employments e
        on e.org_id = r.org_id and e.id = r.employment_id
     where r.org_id = ${orgId} and r.id = ${reviewId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization.
  // Callers narrow this to NOT_FOUND uniformly so an unreadable review is
  // indistinguishable from a missing one (see performance-read.ts).
  if (!row) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `review ${reviewId} is not visible in this organization — check the id or the organization`,
    );
  }
  return row;
}

async function loadAnswers(
  exec: SqlExecutor,
  orgId: string,
  reviewId: string,
): Promise<ReviewAnswerDTO[]> {
  const rows = (await exec.execute<ReviewAnswerDTO>(sql`
    select id,
           section_title as "sectionTitle",
           question_prompt as "questionPrompt",
           position,
           answer_kind as "answerKind",
           rating::text as rating,
           text,
           required
      from hrm_review_answers
     where org_id = ${orgId} and review_id = ${reviewId}
     order by position
  `)).rows;
  return rows;
}

/**
 * HR mutations act through the aggregate manage grant, so the review's
 * employment must sit inside the actor's allowed subsidiary set — a
 * legal-entity-restricted HR calibrates, shares, and reopens only the
 * reviews they cover. Self-service transitions (submit by the reviewer,
 * acknowledge by the subject) prove authority by identity instead and
 * never reach this check.
 */
function assertReviewInScope(allowed: Set<string> | null, review: StoredReview): void {
  if (allowed === null) return;
  if (!allowed.has(review.employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      `review ${review.id} is not visible in this organization and legal-entity scope — ask an HR administrator covering its legal entity to act on it`,
    );
  }
}

/** The actor's person identity on the transaction runner — never caller input. */
async function actorParty(exec: SqlExecutor, orgId: string, actorId: string): Promise<string> {
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (!person.partyId) {
    throw new HrmPerformanceError(
      "FORBIDDEN",
      "this login has no linked person in this organization, so it cannot author a review — ask an administrator to link it",
    );
  }
  return person.partyId;
}

export interface SubmitAnswer {
  readonly answerId: string;
  readonly rating?: string | number | null;
  readonly text?: string | null;
}

/**
 * Submit a review: all required answers present, ratings inside the
 * template scale, overall rating (when given) inside the scale. Only the
 * reviewer submits — a peer cannot submit another's review, and HR cannot
 * submit for the reviewer. Refusals name the question to fix.
 */
export async function submitReview(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
  answers: readonly SubmitAnswer[];
  overallRating?: string | number | null;
}): Promise<ReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const partyId = await actorParty(db, orgId, actorId);
    const review = toReviewDTO(await loadReview(db, orgId, reviewId));
    if (review.reviewerPartyId !== partyId) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        `review ${reviewId} belongs to another reviewer — only its reviewer submits it`,
      );
    }
    if (review.status !== "pending") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} is ${review.status} — only a pending review submits`,
      );
    }
    const stored = await loadAnswers(db, orgId, reviewId);
    const byId = new Map(args.answers.map((a) => [a.answerId, a]));
    const template = (await db.execute<{ ratingScale: unknown }>(sql`
      select t.rating_scale as "ratingScale"
        from hrm_review_templates t
        join hrm_review_cycles c on c.org_id = t.org_id and c.template_id = t.id
       where c.org_id = ${orgId} and c.id = ${review.cycleId}
    `)).rows[0];
    if (!template) {
      throw new HrmPerformanceError(
        "TEMPLATE_NOT_FOUND",
        `review ${reviewId} names a template that is not visible in this organization — ask HR to fix the cycle`,
      );
    }
    const scale = mathRefusal("REFUSED", () => parseRatingScale(template.ratingScale));
    for (const answer of stored) {
      const supplied = byId.get(answer.id);
      const rating = supplied?.rating == null ? null : String(supplied.rating);
      const text = supplied?.text ?? null;
      const needsRating = answer.answerKind === "rating" || answer.answerKind === "rating_and_text";
      const needsText = answer.answerKind === "text" || answer.answerKind === "rating_and_text";
      if (answer.required && needsRating && (rating === null || rating.trim().length === 0)) {
        throw new HrmPerformanceError(
          "REFUSED",
          `the question ${JSON.stringify(answer.questionPrompt ?? answer.sectionTitle)} needs a rating — rate it inside the scale ${scale.min} to ${scale.max}`,
        );
      }
      if (answer.required && needsText && (text === null || text.trim().length === 0)) {
        throw new HrmPerformanceError(
          "REFUSED",
          `the question ${JSON.stringify(answer.questionPrompt ?? answer.sectionTitle)} needs a written answer — write it before submitting`,
        );
      }
      if (rating !== null && rating.trim().length > 0) {
        mathRefusal("REFUSED", () => assertRatingInScale(scale, rating.trim(), answer.questionPrompt ?? answer.sectionTitle));
      }
      await db.execute(sql`
        update hrm_review_answers
           set rating = ${rating === null || rating.trim().length === 0 ? null : rating.trim()}::numeric,
               text = ${text},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${answer.id}
      `);
    }
    const overall = args.overallRating == null || String(args.overallRating).trim().length === 0
      ? null
      : String(args.overallRating).trim();
    if (overall !== null) {
      mathRefusal("REFUSED", () => assertRatingInScale(scale, overall, "overall rating"));
    }
    const moved = (await db.execute(sql`
      update hrm_reviews
         set status = 'submitted', submitted_at = now(),
             overall_rating = coalesce(${overall}::numeric, overall_rating),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${reviewId} and status = 'pending'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} left pending while submitting — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
      values (${orgId}, ${reviewId}, 'submitted', ${actorId}, 'reviewer submitted')
    `);
    return toReviewDTO(await loadReview(db, orgId, reviewId));
  });
}

/**
 * Calibrate a review: HR sets the calibrated rating beside the original
 * (never overwriting it) with a reason. Only hrm.performance.manage.
 */
export async function calibrateReview(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
  calibratedRating: string | number;
  reason: string;
}): Promise<ReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  const rating = String(args.calibratedRating ?? "").trim();
  if (rating.length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "calibratedRating must be a decimal rating");
  }
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    throw new HrmPerformanceError(
      "REFUSED",
      `calibrating review ${reviewId} needs a reason — it is recorded beside the calibrated rating`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const stored = await loadReview(db, orgId, reviewId);
    assertReviewInScope(allowed, stored);
    const review = toReviewDTO(stored);
    if (review.status !== "submitted" && review.status !== "calibrated") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} is ${review.status} — only a submitted review calibrates`,
      );
    }
    const template = (await db.execute<{ ratingScale: unknown }>(sql`
      select t.rating_scale as "ratingScale"
        from hrm_review_templates t
        join hrm_review_cycles c on c.org_id = t.org_id and c.template_id = t.id
       where c.org_id = ${orgId} and c.id = ${review.cycleId}
    `)).rows[0];
    if (!template) {
      throw new HrmPerformanceError(
        "TEMPLATE_NOT_FOUND",
        `review ${reviewId} names a template that is not visible in this organization — ask HR to fix the cycle`,
      );
    }
    mathRefusal("REFUSED", () => assertRatingInScale(mathRefusal("REFUSED", () => parseRatingScale(template.ratingScale)), rating, "calibrated rating"));
    const moved = (await db.execute(sql`
      update hrm_reviews
         set status = 'calibrated', calibrated_rating = ${rating}::numeric,
             calibration_reason = ${args.reason.trim()},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${reviewId}
         and status in ('submitted', 'calibrated')
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} moved while calibrating — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
      values (${orgId}, ${reviewId}, 'calibrated', ${actorId}, ${args.reason.trim()})
    `);
    return toReviewDTO(await loadReview(db, orgId, reviewId));
  });
}

/**
 * Share a manager or peer review with its subject. Refused before the
 * calibration round closes: while the cycle calibrates, nothing leaks to
 * subjects. A self review is already the subject's — sharing it is refused
 * as meaningless. The reviewer or HR shares.
 */
export async function shareReview(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
}): Promise<ReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const partyId = await actorParty(db, orgId, actorId);
    const stored = await loadReview(db, orgId, reviewId);
    const review = toReviewDTO(stored);
    if (review.kind === "self") {
      throw new HrmPerformanceError(
        "REFUSED",
        `review ${reviewId} is a self review — it is already the subject's, so there is nothing to share`,
      );
    }
    if (review.reviewerPartyId !== partyId) {
      // Not the reviewer: HR may still share, inside their legal-entity scope.
      assertReviewInScope(await requireAggregatePerformanceManage(db, orgId, actorId), stored);
    }
    if (review.status !== "submitted" && review.status !== "calibrated") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} is ${review.status} — only a submitted or calibrated review shares`,
      );
    }
    if (review.cycleStatus === "calibrating") {
      throw new HrmPerformanceError(
        "REFUSED",
        `review ${reviewId} sits in a calibrating cycle — finish calibration (close the cycle) before sharing it with the subject`,
      );
    }
    const moved = (await db.execute(sql`
      update hrm_reviews
         set status = 'shared', shared_at = now(), updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${reviewId} and status in ('submitted', 'calibrated')
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} moved while sharing — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
      values (${orgId}, ${reviewId}, 'shared', ${actorId}, 'shared with the subject')
    `);
    return projectReviewForActor(db, orgId, actorId, partyId, toReviewDTO(await loadReview(db, orgId, reviewId)));
  });
}

/**
 * Acknowledge a shared review: the subject only. The self-service touch —
 * the read path exposes the shared review and nothing else.
 */
export async function acknowledgeReview(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
}): Promise<ReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const partyId = await actorParty(db, orgId, actorId);
    const review = toReviewDTO(await loadReview(db, orgId, reviewId));
    if (review.subjectPartyId !== partyId) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        `review ${reviewId} is shared with another subject — only the subject acknowledges it`,
      );
    }
    if (review.status !== "shared") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} is ${review.status} — only a shared review acknowledges`,
      );
    }
    const moved = (await db.execute(sql`
      update hrm_reviews
         set status = 'acknowledged', acknowledged_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${reviewId} and status = 'shared'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} moved while acknowledging — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
      values (${orgId}, ${reviewId}, 'acknowledged', ${actorId}, 'subject acknowledged')
    `);
    return projectReviewForActor(db, orgId, actorId, partyId, toReviewDTO(await loadReview(db, orgId, reviewId)));
  });
}

/**
 * Reopen a submitted or calibrated review with a reason: back to pending
 * for correction. Only HR. Shared reviews never reopen — sharing is a
 * promise to the subject; correct forward in a new cycle instead.
 */
export async function reopenReview(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
  reason: string;
}): Promise<ReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const reviewId = requireId("reviewId", args.reviewId);
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    throw new HrmPerformanceError(
      "REFUSED",
      `reopening review ${reviewId} needs a reason — it is recorded as a reopened event`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const stored = await loadReview(db, orgId, reviewId);
    assertReviewInScope(allowed, stored);
    const review = toReviewDTO(stored);
    if (review.status !== "submitted" && review.status !== "calibrated") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} is ${review.status} — only a submitted or calibrated review reopens; a shared review stays shared, correct it forward in a new cycle`,
      );
    }
    // Back to pending clears the submission stamp (the submitted event
    // remains as evidence); answers and the author's rating stay for
    // correction, calibration stays beside them as history.
    const moved = (await db.execute(sql`
      update hrm_reviews
         set status = 'pending', submitted_at = null,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${reviewId} and status in ('submitted', 'calibrated')
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review ${reviewId} moved while reopening — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
      values (${orgId}, ${reviewId}, 'reopened', ${actorId}, ${args.reason.trim()})
    `);
    return toReviewDTO(await loadReview(db, orgId, reviewId));
  });
}

export { loadAnswers, loadReview };
