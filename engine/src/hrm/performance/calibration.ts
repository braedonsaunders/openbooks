import { sql } from "drizzle-orm";
import { withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import {
  loadApprovalPerson,
  requireAggregatePerformanceManage,
} from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError } from "./errors.ts";
import { HRM_PERFORMANCE_CONTINUOUS_KEY } from "./one-on-ones.ts";

/**
 * Governed HRM calibration sessions (0228, HR-17): open a session over a
 * review cycle, change ratings with justification, set potential, revert,
 * and close — with the append-only calibration event as the audit trail
 * of every rating shift.
 *
 * Ratings here are NUMERIC, matching hrm_reviews overall_rating /
 * calibrated_rating (0196 stores numbers, not keys): proposed_rating
 * snapshots the review's overall_rating at entry time, and close writes
 * the decided calibrated_rating back onto hrm_reviews.calibrated_rating
 * in the SAME transaction as the close. Potential keys are text against
 * the org-declared scale labels from the review template.
 *
 * Entry rule: only submitted manager reviews enter. A review not yet
 * submitted is listed as missing with its reason — never silently
 * excluded. Changes after close are refused. The facilitator cannot
 * calibrate a review they authored (exclude-initiator): such reviews are
 * listed as missing with the facilitator_own reason and never get an
 * entry, so the conflict cannot be reached.
 *
 * The employee-visible share shows the calibrated rating with a note
 * that calibration occurred — never the delta, never the justification.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export const HRM_CALIBRATION_KEY = "hrmCalibration" as const;

export type CalibrationSessionStatus = "draft" | "open" | "closed";
export type CalibrationEventKind = "opened" | "rating_changed" | "potential_set" | "reverted" | "closed";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

export async function assertCalibrationFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before opening calibration",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmPerformance feature is disabled: enable it on Company Settings → Features before opening calibration",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_CALIBRATION_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmCalibration feature is disabled: enable it on Company Settings → Features before opening calibration",
    );
  }
}

export interface CalibrationEntryDTO {
  readonly id: string;
  readonly reviewId: string;
  readonly employmentId: string;
  readonly subjectName: string;
  readonly reviewerPartyId: string;
  readonly proposedRating: string | null;
  readonly calibratedRating: string | null;
  readonly potentialKey: string | null;
  readonly justification: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export interface MissingReviewDTO {
  readonly reviewId: string;
  readonly employmentId: string;
  readonly status: string;
  readonly kind: string;
  readonly reason: string;
}

export interface CalibrationSessionDTO {
  readonly id: string;
  readonly cycleId: string;
  readonly name: string;
  readonly scope: Record<string, unknown>;
  readonly status: CalibrationSessionStatus;
  readonly facilitatorPartyId: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly entries: readonly CalibrationEntryDTO[];
  readonly missing: readonly MissingReviewDTO[];
}

type StoredSession = {
  id: string;
  cycle_id: string;
  name: string;
  scope: unknown;
  status: CalibrationSessionStatus;
  facilitator_party_id: string | null;
  opened_at: string | null;
  closed_at: string | null;
};

type StoredEntry = {
  id: string;
  review_id: string;
  employment_id: string;
  subject_name: string;
  reviewer_party_id: string;
  proposed_rating: string | null;
  calibrated_rating: string | null;
  potential_key: string | null;
  justification: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

async function loadSession(exec: SqlExecutor, orgId: string, id: string): Promise<StoredSession | null> {
  const rows = (await exec.execute<StoredSession & { scope: unknown }>(sql`
    select id, cycle_id, name, scope, status, facilitator_party_id,
           opened_at::text as opened_at, closed_at::text as closed_at
      from hrm_calibration_sessions where org_id = ${orgId} and id = ${id}
  `)).rows;
  return rows[0] ?? null;
}

async function loadEntries(exec: SqlExecutor, orgId: string, sessionId: string): Promise<StoredEntry[]> {
  return (await exec.execute<StoredEntry>(sql`
    select e.id, e.review_id, r.employment_id, coalesce(p.display_name, '—') as subject_name, r.reviewer_party_id,
           e.proposed_rating::text as proposed_rating, e.calibrated_rating::text as calibrated_rating,
           e.potential_key, e.justification,
           e.decided_by::text as decided_by, e.decided_at::text as decided_at
      from hrm_calibration_entries e
      join hrm_reviews r on r.org_id = e.org_id and r.id = e.review_id
      join worker_employments we on we.org_id = e.org_id and we.id = r.employment_id
      left join parties p on p.org_id = e.org_id and p.id = we.worker_party_id
     where e.org_id = ${orgId} and e.session_id = ${sessionId}
     order by e.created_at
  `)).rows;
}

/**
 * Reviews in the cycle that did NOT enter the session, each with the
 * reason it stayed out — a review not yet submitted is listed as
 * missing, never silently excluded.
 */
async function loadMissing(
  exec: SqlExecutor,
  orgId: string,
  sessionId: string,
  cycleId: string,
  facilitatorPartyId: string | null,
): Promise<MissingReviewDTO[]> {
  const rows = (await exec.execute<{ reviewId: string; employmentId: string; status: string; kind: string; reviewerPartyId: string }>(sql`
    select r.id as "reviewId", r.employment_id as "employmentId", r.status, r.kind,
           r.reviewer_party_id as "reviewerPartyId"
      from hrm_reviews r
     where r.org_id = ${orgId} and r.cycle_id = ${cycleId}
       and not exists (select 1 from hrm_calibration_entries e
                        where e.org_id = ${orgId} and e.session_id = ${sessionId} and e.review_id = r.id)
     order by r.created_at
  `)).rows;
  return rows.map((row) => {
    let reason: string;
    if (facilitatorPartyId !== null && row.reviewerPartyId === facilitatorPartyId) {
      reason = "facilitator_own";
    } else if (row.kind !== "manager") {
      reason = "not_manager_review";
    } else if (row.status !== "submitted") {
      reason = "not_submitted";
    } else {
      reason = "not_in_scope";
    }
    return { reviewId: row.reviewId, employmentId: row.employmentId, status: row.status, kind: row.kind, reason };
  });
}

function toDTO(session: StoredSession, entries: readonly StoredEntry[], missing: readonly MissingReviewDTO[]): CalibrationSessionDTO {
  return {
    id: session.id,
    cycleId: session.cycle_id,
    name: session.name,
    scope: (session.scope ?? {}) as Record<string, unknown>,
    status: session.status,
    facilitatorPartyId: session.facilitator_party_id,
    openedAt: session.opened_at,
    closedAt: session.closed_at,
    entries: entries.map((e) => ({
      id: e.id, reviewId: e.review_id, employmentId: e.employment_id, subjectName: e.subject_name, reviewerPartyId: e.reviewer_party_id,
      proposedRating: e.proposed_rating, calibratedRating: e.calibrated_rating, potentialKey: e.potential_key,
      justification: e.justification, decidedBy: e.decided_by, decidedAt: e.decided_at,
    })),
    missing,
  };
}

async function recordEvent(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  sessionId: string,
  entryId: string | null,
  kind: CalibrationEventKind,
  fromKey: string | null,
  toKey: string | null,
  reason: string | null,
): Promise<void> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into hrm_calibration_events (org_id, session_id, entry_id, kind, from_key, to_key, actor_user_id, reason)
    values (${orgId}, ${sessionId}, ${entryId}, ${kind}, ${fromKey}, ${toKey}, ${actorId}, ${reason})
    returning id
  `)).rows[0];
  if (!inserted) throw new HrmPerformanceError("REFUSED", "the calibration event was not stored — no row was written; retry the action");
}

export async function createCalibrationSession(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
  name: string;
  scope?: Record<string, unknown> | null;
  facilitatorPartyId?: string | null;
}): Promise<CalibrationSessionDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  if (typeof args.name !== "string" || args.name.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a calibration session needs a name — say which group is being calibrated");
  }
  if (args.facilitatorPartyId !== undefined && args.facilitatorPartyId !== null) {
    requireId("facilitatorPartyId", args.facilitatorPartyId);
  }
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const cycle = (await exec.execute<{ id: string; status: string }>(sql`
      select id, status from hrm_review_cycles where org_id = ${orgId} and id = ${cycleId}
    `)).rows[0];
    if (!cycle) {
      throw new HrmPerformanceError("NOT_FOUND", "review cycle was not found — open the session over an existing cycle");
    }
    if (cycle.status === "closed") {
      throw new HrmPerformanceError("BAD_STATE", "this cycle is closed — calibration belongs to an open or calibrating cycle");
    }
    const inserted = (await exec.execute<{ id: string }>(sql`
      insert into hrm_calibration_sessions (org_id, cycle_id, name, scope, facilitator_party_id, created_by, updated_by)
      values (${orgId}, ${cycleId}, ${args.name.trim()}, ${JSON.stringify(args.scope ?? {})}::jsonb,
              ${args.facilitatorPartyId ?? null}, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new HrmPerformanceError("REFUSED", "the calibration session was not stored — no row was written; retry the action");
    const session = await loadSession(exec, orgId, inserted.id);
    if (!session) throw new HrmPerformanceError("REFUSED", "the calibration session was not stored — no row can be read back; retry the action");
    return toDTO(session, [], await loadMissing(exec, orgId, session.id, cycleId, session.facilitator_party_id));
  });
}

export async function openCalibrationSession(args: { orgId: string; actorId: string; id: string }): Promise<CalibrationSessionDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const session = await loadSession(exec, orgId, id);
    if (!session) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
    if (session.status !== "draft") {
      throw new HrmPerformanceError("BAD_STATE", `only a draft session can be opened — this one is ${session.status}`);
    }
    // Only submitted manager reviews enter; the facilitator's own
    // reviews are excluded (exclude-initiator) so the conflict cannot
    // be reached. Everything else stays on the missing list with its
    // reason — never silently excluded.
    const candidates = (await exec.execute<{ id: string; overall_rating: string | null; reviewer_party_id: string }>(sql`
      select id, overall_rating::text as overall_rating, reviewer_party_id
        from hrm_reviews
       where org_id = ${orgId} and cycle_id = ${session.cycle_id} and kind = 'manager' and status = 'submitted'
    `)).rows;
    const updated = (await exec.execute<{ id: string }>(sql`
      update hrm_calibration_sessions set status = 'open', opened_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and status = 'draft'
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the session changed under you — reload it and try again");
    }
    for (const candidate of candidates) {
      if (session.facilitator_party_id !== null && candidate.reviewer_party_id === session.facilitator_party_id) continue;
      const entry = (await exec.execute<{ id: string }>(sql`
        insert into hrm_calibration_entries (org_id, session_id, review_id, proposed_rating, created_by, updated_by)
        values (${orgId}, ${id}, ${candidate.id}, ${candidate.overall_rating}::numeric, ${actorId}, ${actorId})
        on conflict do nothing
        returning id
      `)).rows[0];
      // on conflict do nothing is benign here: reopening an opened
      // session is refused above, so a conflict means two open calls
      // raced and one already entered this review — the read below
      // proves the entry exists either way.
      const entryId = entry?.id ?? (await exec.execute<{ id: string }>(sql`
        select id from hrm_calibration_entries where org_id = ${orgId} and session_id = ${id} and review_id = ${candidate.id}
      `)).rows[0]?.id;
      if (!entryId) {
        throw new HrmPerformanceError("REFUSED", "a calibration entry was not stored — no row can be read back; retry the action");
      }
    }
    await recordEvent(exec, orgId, actorId, id, null, "opened", null, null, null);
    const opened = await loadSession(exec, orgId, id);
    if (!opened) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
    return toDTO(opened, await loadEntries(exec, orgId, id), await loadMissing(exec, orgId, id, opened.cycle_id, opened.facilitator_party_id));
  });
}

async function requireOpenEntry(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  entryId: string,
): Promise<{ session: StoredSession; entry: StoredEntry }> {
  const entries = (await exec.execute<StoredEntry>(sql`
    select e.id, e.review_id, r.employment_id, coalesce(p.display_name, '—') as subject_name, r.reviewer_party_id,
           e.proposed_rating::text as proposed_rating, e.calibrated_rating::text as calibrated_rating,
           e.potential_key, e.justification,
           e.decided_by::text as decided_by, e.decided_at::text as decided_at
      from hrm_calibration_entries e
      join hrm_reviews r on r.org_id = e.org_id and r.id = e.review_id
      join worker_employments we on we.org_id = e.org_id and we.id = r.employment_id
      left join parties p on p.org_id = e.org_id and p.id = we.worker_party_id
     where e.org_id = ${orgId} and e.id = ${entryId}
  `)).rows;
  const entry = entries[0];
  if (!entry) throw new HrmPerformanceError("NOT_FOUND", "calibration entry was not found — it may belong to another session");
  const session = await loadSession(exec, orgId, (await exec.execute<{ session_id: string }>(sql`
    select session_id from hrm_calibration_entries where org_id = ${orgId} and id = ${entryId}
  `)).rows[0].session_id);
  if (!session) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
  if (session.status !== "open") {
    throw new HrmPerformanceError(
      "BAD_STATE",
      session.status === "closed"
        ? "this session is closed — ratings are final; open a new session to recalibrate"
        : "this session is still a draft — open it before changing ratings",
    );
  }
  // Exclude-initiator, enforced at change time as well as at entry:
  // the facilitator never decides their own review.
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (session.facilitator_party_id !== null && entry.reviewer_party_id === session.facilitator_party_id) {
    throw new HrmPerformanceError(
      "FORBIDDEN",
      "the facilitator cannot calibrate their own review — ask another facilitator to decide this entry",
    );
  }
  if (person.partyId !== null && entry.reviewer_party_id === person.partyId && person.partyId !== session.facilitator_party_id) {
    // A non-facilitator deciding their own review is the same conflict
    // under a different hat: refuse by name.
    throw new HrmPerformanceError(
      "FORBIDDEN",
      "you authored this review — calibration needs an independent decider; ask the session facilitator",
    );
  }
  return { session, entry };
}

export async function setCalibratedRating(args: {
  orgId: string;
  actorId: string;
  entryId: string;
  calibratedRating: string;
  justification: string;
}): Promise<CalibrationEntryDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const entryId = requireId("entryId", args.entryId);
  if (typeof args.justification !== "string" || args.justification.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "changing a calibrated rating needs a justification — say what evidence moved it");
  }
  const rating = Number(args.calibratedRating);
  if (!Number.isFinite(rating) || rating < 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "calibrated rating must be a non-negative number on the template scale");
  }
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const { session, entry } = await requireOpenEntry(exec, orgId, actorId, entryId);
    const fromKey = entry.calibrated_rating ?? entry.proposed_rating;
    const updated = (await exec.execute<StoredEntry>(sql`
      update hrm_calibration_entries
         set calibrated_rating = ${args.calibratedRating}::numeric, justification = ${args.justification.trim()},
             decided_by = ${actorId}, decided_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${entryId}
      returning id, review_id, calibrated_rating::text as calibrated_rating
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the entry changed under you — reload the grid and try again");
    }
    await recordEvent(exec, orgId, actorId, session.id, entryId, "rating_changed", fromKey, args.calibratedRating, args.justification.trim());
    const entries = await loadEntries(exec, orgId, session.id);
    const decided = entries.find((e) => e.id === entryId);
    if (!decided) throw new HrmPerformanceError("REFUSED", "the rating change was not stored — no row can be read back; retry the action");
    return {
      id: decided.id, reviewId: decided.review_id, employmentId: decided.employment_id,
      subjectName: decided.subject_name,
      reviewerPartyId: decided.reviewer_party_id, proposedRating: decided.proposed_rating,
      calibratedRating: decided.calibrated_rating, potentialKey: decided.potential_key,
      justification: decided.justification, decidedBy: decided.decided_by, decidedAt: decided.decided_at,
    };
  });
}

export async function setPotential(args: {
  orgId: string;
  actorId: string;
  entryId: string;
  potentialKey: string;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const entryId = requireId("entryId", args.entryId);
  if (typeof args.potentialKey !== "string" || args.potentialKey.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "potential needs a key from the org-declared scale — pick the label the template declares");
  }
  await withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const { session, entry } = await requireOpenEntry(exec, orgId, actorId, entryId);
    const updated = (await exec.execute<{ id: string }>(sql`
      update hrm_calibration_entries
         set potential_key = ${args.potentialKey.trim()}, decided_by = ${actorId}, decided_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${entryId}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the entry changed under you — reload the grid and try again");
    }
    await recordEvent(exec, orgId, actorId, session.id, entryId, "potential_set", entry.potential_key, args.potentialKey.trim(), null);
  });
}

export async function revertEntry(args: { orgId: string; actorId: string; entryId: string; reason: string }): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const entryId = requireId("entryId", args.entryId);
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "reverting a calibration needs a reason — say why the proposed rating stands");
  }
  await withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const { session, entry } = await requireOpenEntry(exec, orgId, actorId, entryId);
    const updated = (await exec.execute<{ id: string }>(sql`
      update hrm_calibration_entries
         set calibrated_rating = null, potential_key = null, justification = null,
             decided_by = null, decided_at = null, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${entryId}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the entry changed under you — reload the grid and try again");
    }
    await recordEvent(exec, orgId, actorId, session.id, entryId, "reverted", entry.calibrated_rating ?? entry.proposed_rating, entry.proposed_rating, args.reason.trim());
  });
}

export async function closeCalibrationSession(args: {
  orgId: string;
  actorId: string;
  id: string;
}): Promise<CalibrationSessionDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const session = await loadSession(exec, orgId, id);
    if (!session) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
    if (session.status !== "open") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        session.status === "closed"
          ? "this session is already closed — ratings are final; open a new session to recalibrate"
          : "this session is still a draft — open it before closing",
      );
    }
    const entries = await loadEntries(exec, orgId, id);
    // Close writes every decided calibrated rating back onto its review
    // in the SAME transaction as the close: partial write-back cannot
    // exist. The share shows the calibrated rating with a note that
    // calibration occurred — never the delta, never the justification.
    for (const entry of entries) {
      if (entry.calibrated_rating === null) continue;
      const updated = (await exec.execute<{ id: string }>(sql`
        update hrm_reviews
           set calibrated_rating = ${entry.calibrated_rating}::numeric,
               calibration_reason = ${entry.justification ?? "decided in calibration"},
               calibrated_share_note = ${`Calibrated in ${session.name} — the rating shown reflects the calibration round.`},
               calibrated_shared_at = now(), status = 'calibrated',
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${entry.review_id} and status = 'submitted'
        returning id
      `)).rows;
      if (updated.length !== 1) {
        throw new HrmPerformanceError(
          "STALE_REVISION",
          "a review left the submitted state while the session closed — reload the grid and close again",
        );
      }
      await exec.execute(sql`
        insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
        values (${orgId}, ${entry.review_id}, 'calibrated', ${actorId}, ${`calibration session ${session.name}`})
      `);
    }
    const closed = (await exec.execute<{ id: string }>(sql`
      update hrm_calibration_sessions set status = 'closed', closed_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and status = 'open'
      returning id
    `)).rows;
    if (closed.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the session changed under you — reload it and try again");
    }
    await recordEvent(exec, orgId, actorId, id, null, "closed", null, null, null);
    const done = await loadSession(exec, orgId, id);
    if (!done) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
    return toDTO(done, await loadEntries(exec, orgId, id), await loadMissing(exec, orgId, id, done.cycle_id, done.facilitator_party_id));
  });
}

export async function getCalibrationSession(args: {
  orgId: string;
  actorId: string;
  id: string;
}): Promise<CalibrationSessionDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const session = await loadSession(exec, orgId, id);
    if (!session) throw new HrmPerformanceError("NOT_FOUND", "calibration session was not found — it may belong to another organization");
    return toDTO(session, await loadEntries(exec, orgId, id), await loadMissing(exec, orgId, id, session.cycle_id, session.facilitator_party_id));
  });
}

export async function listCalibrationSessions(args: {
  orgId: string;
  actorId: string;
  cycleId?: string;
}): Promise<readonly { id: string; cycleId: string; name: string; status: CalibrationSessionStatus; openedAt: string | null; closedAt: string | null }[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async (exec) => {
    await assertCalibrationFeature(exec, orgId);
    await requireAggregatePerformanceManage(exec, orgId, actorId);
    const cycleFilter = args.cycleId ? sql` and cycle_id = ${args.cycleId}` : sql``;
    return (await exec.execute<{ id: string; cycleId: string; name: string; status: CalibrationSessionStatus; openedAt: string | null; closedAt: string | null }>(sql`
      select id, cycle_id as "cycleId", name, status,
             opened_at::text as "openedAt", closed_at::text as "closedAt"
        from hrm_calibration_sessions where org_id = ${orgId}${cycleFilter} order by created_at desc
    `)).rows;
  });
}

/**
 * Distribution strip for the calibration grid: counts per proposed and
 * per calibrated rating key. Keys are the template scale's own labels —
 * never a hardcoded set.
 */
export async function calibrationDistribution(args: {
  orgId: string;
  actorId: string;
  id: string;
}): Promise<{ readonly proposed: Readonly<Record<string, number>>; readonly calibrated: Readonly<Record<string, number>> }> {
  const session = await getCalibrationSession(args);
  const proposed: Record<string, number> = {};
  const calibrated: Record<string, number> = {};
  for (const entry of session.entries) {
    const p = entry.proposedRating ?? "unrated";
    const c = entry.calibratedRating ?? "undecided";
    proposed[p] = (proposed[p] ?? 0) + 1;
    calibrated[c] = (calibrated[c] ?? 0) + 1;
  }
  return { proposed, calibrated };
}
