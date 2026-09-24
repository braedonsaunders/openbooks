import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import {
  actorOnInterviewPanel,
  loadApprovalPerson,
  requireHrmRecruitingManage,
  requireHrmRecruitingRead,
  requireOwnRequisitionForHiringManager,
} from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import { pgUuidArray, requireDepthFeature } from "./depth.ts";
import { listKitAttributes, loadKit } from "./kits.ts";

/**
 * Canonical scorecard service (HR-18, 0229): blind panel verdicts.
 *
 * - ensurePanelScorecards creates one draft scorecard per panel member;
 *   scheduling calls it when the interview is set up, and it is idempotent
 *   (existing rows are left alone — a re-run never resets a verdict).
 * - submitScorecard records the verdict: an overall plus a rating for
 *   every focus attribute (the panel row's focus_attribute_ids, else the
 *   kit's is_focus_default set). Rating keys must sit inside the kit's
 *   declared scale — storage pins the canonical vocabulary, the service
 *   pins the kit's subset. A submitted scorecard is immutable (the SQL
 *   trigger backstops the race); submitting twice names the remedy.
 * - readScorecardsForInterview enforces the BLIND RULE: an interviewer
 *   reads other interviewers' scorecards for the same interview ONLY after
 *   submitting their own. The hiring manager on their own requisition and
 *   holders of hrm.recruiting.manage read the full set. private_notes are
 *   author-only on every path — stripped for everyone else, manager
 *   included.
 * - scorecardSummary aggregates per attribute once submitted, with missing
 *   scorecards listed by name so the hiring manager knows whose verdict is
 *   outstanding. Aggregate rows carry counts only for non-authors (the
 *   report entity reads through this shape, never raw PII).
 */

export const RATING_VALUES: Record<string, number> = {
  strong_no: 1,
  no: 2,
  yes: 3,
  strong_yes: 4,
};

export interface ScorecardDTO {
  readonly id: string;
  readonly interviewId: string;
  readonly interviewerPartyId: string;
  readonly interviewerName: string | null;
  readonly overall: string | null;
  readonly submittedAt: string | null;
  /** Present only for the author. */
  readonly privateNotes: string | null;
  readonly sharedNotes: string | null;
  readonly ratings: readonly { attributeId: string; ratingKey: string | null; note: string | null }[];
}

export interface ScorecardSummary {
  readonly interviewId: string;
  readonly complete: boolean;
  readonly submittedCount: number;
  readonly totalCount: number;
  readonly missing: readonly string[];
  readonly overallCounts: Record<string, number>;
  readonly perAttribute: readonly {
    attributeId: string;
    category: string;
    attribute: string;
    ratings: number;
    average: number | null;
    counts: Record<string, number>;
  }[];
}

type ScorecardRow = {
  id: string;
  interviewId: string;
  interviewerPartyId: string;
  overall: string | null;
  submittedAt: string | null;
  privateNotes: string | null;
  sharedNotes: string | null;
};

type RatingRow = {
  scorecardId: string;
  attributeId: string;
  ratingKey: string;
  note: string | null;
};

async function interviewRequisition(
  exec: SqlExecutor,
  orgId: string,
  interviewId: string,
): Promise<{ applicationId: string; requisitionId: string; kitId: string | null }> {
  const row = (await exec.execute<{
    applicationId: string;
    requisitionId: string;
    kitId: string | null;
  }>(sql`
    select i.application_id as "applicationId", a.requisition_id as "requisitionId",
           i.kit_id as "kitId"
      from hrm_interviews i
      join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
     where i.org_id = ${orgId} and i.id = ${interviewId}
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
  }
  return row;
}

async function panelPartyIds(exec: SqlExecutor, orgId: string, interviewId: string): Promise<string[]> {
  const rows = (await exec.execute<{ partyId: string }>(sql`
    select party_id as "partyId" from hrm_interview_panel
     where org_id = ${orgId} and interview_id = ${interviewId} order by party_id
  `)).rows;
  return rows.map((row) => row.partyId);
}

async function panelFocusAttributeIds(
  exec: SqlExecutor,
  orgId: string,
  interviewId: string,
  partyId: string,
): Promise<string[] | null> {
  const row = (await exec.execute<{ focusAttributeIds: string[] | null }>(sql`
    select focus_attribute_ids as "focusAttributeIds" from hrm_interview_panel
     where org_id = ${orgId} and interview_id = ${interviewId} and party_id = ${partyId}
  `)).rows[0];
  return row?.focusAttributeIds ?? null;
}

async function partyDisplayNames(
  exec: SqlExecutor,
  orgId: string,
  partyIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (partyIds.length === 0) return names;
  const rows = (await exec.execute<{ id: string; name: string }>(sql`
    select id, display_name as name from parties
     where org_id = ${orgId} and id = any(${pgUuidArray(partyIds)}::uuid[])
  `)).rows;
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

function toDTO(
  row: ScorecardRow,
  ratings: readonly RatingRow[],
  names: Map<string, string>,
  isAuthor: boolean,
): ScorecardDTO {
  return {
    id: row.id,
    interviewId: row.interviewId,
    interviewerPartyId: row.interviewerPartyId,
    interviewerName: names.get(row.interviewerPartyId) ?? null,
    overall: row.overall,
    submittedAt: row.submittedAt,
    privateNotes: isAuthor ? row.privateNotes : null,
    sharedNotes: row.sharedNotes,
    ratings: ratings
      .filter((rating) => rating.scorecardId === row.id)
      .map((rating) => ({ attributeId: rating.attributeId, ratingKey: rating.ratingKey, note: rating.note })),
  };
}

/**
 * Create draft scorecards for panel members missing one. Idempotent:
 * existing rows (including submitted verdicts) are never touched.
 */
export async function ensurePanelScorecards(query: {
  orgId: string;
  actorId: string;
  interviewId: string;
}): Promise<number> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    const chain = await interviewRequisition(db, orgId, interviewId);
    await requireHrmRecruitingManage(db, orgId, actorId, chain.requisitionId);
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const parties = await panelPartyIds(db, orgId, interviewId);
    let created = 0;
    for (const partyId of parties) {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_scorecards (org_id, interview_id, interviewer_party_id, created_by, updated_by)
        values (${orgId}, ${interviewId}, ${partyId}, ${actorId}, ${actorId})
        on conflict do nothing
        returning id
      `)).rows[0];
      // on conflict do nothing is load-bearing here, not a dropped write:
      // ensure runs on every schedule/reschedule, and an existing
      // scorecard — especially a submitted verdict — must never be reset
      // by a second ensure. The conflict IS the benign case.
      if (inserted) created += 1;
    }
    return created;
  });
}

export interface SubmitScorecardQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly interviewId: string;
  readonly overall: unknown;
  readonly ratings: Readonly<Record<string, unknown>>;
  readonly privateNotes?: unknown;
  readonly sharedNotes?: unknown;
}

/**
 * Submit the actor's own verdict. The actor submits ONLY their own
 * scorecard (resolved through their employee party — never a
 * caller-supplied party id). Ratings for every focus attribute are
 * required; other kit attributes are optional.
 */
export async function submitScorecard(query: SubmitScorecardQuery): Promise<ScorecardDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const chain = await interviewRequisition(db, orgId, interviewId);
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (!person.partyId) {
      throw new RecruitingError(
        "REFUSED",
        "scorecards file against an employee party — this identity has no party in this organization, so there is no panel seat to submit from",
      );
    }
    if (!(await actorOnInterviewPanel(db, orgId, actorId, interviewId))) {
      throw new RecruitingError(
        "REFUSED",
        "only a panel member submits a scorecard for this interview — ask the organizer to add you to the panel first",
      );
    }
    const card = (await db.execute<ScorecardRow>(sql`
      select id, interview_id as "interviewId", interviewer_party_id as "interviewerPartyId",
             overall, submitted_at as "submittedAt",
             private_notes as "privateNotes", shared_notes as "sharedNotes"
        from hrm_scorecards
       where org_id = ${orgId} and interview_id = ${interviewId}
         and interviewer_party_id = ${person.partyId}
    `)).rows[0];
    if (!card) {
      throw new RecruitingError(
        "NOT_FOUND",
        "no scorecard shell exists for this panel seat — ask the organizer to re-run interview setup before submitting",
      );
    }
    if (card.submittedAt) {
      throw new RecruitingError(
        "REFUSED",
        "this scorecard is already submitted and immutable — the verdict stands as recorded",
      );
    }
    const kit = chain.kitId ? await loadKit(db, orgId, chain.kitId) : null;
    const scale = kit?.ratingScale ?? ["strong_no", "no", "yes", "strong_yes"];
    const overall = typeof query.overall === "string" ? query.overall : null;
    if (!overall || !scale.includes(overall)) {
      throw new RecruitingError(
        "INVALID_INPUT",
        `an overall verdict is required from this kit's scale (${scale.join(", ")}) — pick the verdict the interview earned`,
      );
    }
    const focus = (await panelFocusAttributeIds(db, orgId, interviewId, person.partyId)) ?? (
      kit
        ? (await listKitAttributes(db, orgId, kit.id)).filter((attr) => attr.isFocusDefault).map((attr) => attr.id)
        : []
    );
    const ratings = query.ratings ?? {};
    const missing = focus.filter(
      (attributeId) => typeof ratings[attributeId] !== "string" || !(ratings[attributeId] as string).length,
    );
    if (missing.length > 0) {
      throw new RecruitingError(
        "INVALID_INPUT",
        `${missing.length} focus attribute(s) have no rating — rate every focus attribute before submitting; other attributes are optional`,
      );
    }
    const entries = Object.entries(ratings);
    for (const [attributeId, ratingKey] of entries) {
      if (typeof ratingKey !== "string" || !scale.includes(ratingKey)) {
        throw new RecruitingError(
          "INVALID_INPUT",
          `rating for attribute ${attributeId} must come from this kit's scale (${scale.join(", ")}) — re-rate it from the declared keys`,
        );
      }
    }
    if (kit) {
      const valid = new Set((await listKitAttributes(db, orgId, kit.id)).map((attr) => attr.id));
      for (const [attributeId] of entries) {
        if (!valid.has(attributeId)) {
          throw new RecruitingError(
            "INVALID_INPUT",
            `attribute ${attributeId} is not on this interview's kit — rate the kit's attributes instead of inventing one`,
          );
        }
      }
    }
    const privateNotes =
      query.privateNotes == null || String(query.privateNotes).trim().length === 0
        ? null
        : String(query.privateNotes);
    const sharedNotes =
      query.sharedNotes == null || String(query.sharedNotes).trim().length === 0
        ? null
        : String(query.sharedNotes);
    for (const [attributeId, ratingKey] of entries) {
      const written = (await db.execute<{ id: string }>(sql`
        insert into hrm_scorecard_ratings (org_id, scorecard_id, attribute_id, rating_key, created_by, updated_by)
        values (${orgId}, ${card.id}, ${attributeId}, ${ratingKey}, ${actorId}, ${actorId})
        on conflict (org_id, scorecard_id, attribute_id)
        do update set rating_key = excluded.rating_key, updated_by = excluded.updated_by, updated_at = now()
        returning id
      `)).rows[0];
      if (!written) {
        throw new RecruitingError("REFUSED", "the rating was not stored — no row was written; retry the request");
      }
    }
    const updated = (await db.execute<ScorecardRow>(sql`
      update hrm_scorecards
         set overall = ${overall}, submitted_at = now(),
             private_notes = ${privateNotes}, shared_notes = ${sharedNotes},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${card.id} and submitted_at is null
      returning id, interview_id as "interviewId", interviewer_party_id as "interviewerPartyId",
                overall, submitted_at as "submittedAt",
                private_notes as "privateNotes", shared_notes as "sharedNotes"
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError(
        "REFUSED",
        "this scorecard was submitted concurrently — the first submission stands; reload and read the recorded verdict",
      );
    }
    const allRatings = (await db.execute<RatingRow>(sql`
      select scorecard_id as "scorecardId", attribute_id as "attributeId", rating_key as "ratingKey", note
        from hrm_scorecard_ratings where org_id = ${orgId} and scorecard_id = ${card.id}
    `)).rows;
    const names = await partyDisplayNames(db, orgId, [person.partyId]);
    return toDTO(updated, allRatings, names, true);
  });
}

export interface ScorecardReadQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly interviewId: string;
}

/**
 * Read the interview's scorecards under the blind rule. Returns the
 * viewer's own card plus (when visible) the others; never another
 * interviewer's private_notes.
 */
export async function readScorecardsForInterview(query: ScorecardReadQuery): Promise<{
  readonly mine: ScorecardDTO | null;
  readonly others: readonly ScorecardDTO[];
  readonly blinded: boolean;
}> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const chain = await interviewRequisition(db, orgId, interviewId);
    let privileged = false;
    try {
      await requireHrmRecruitingManage(db, orgId, actorId, chain.requisitionId);
      privileged = true;
    } catch {
      try {
        await requireOwnRequisitionForHiringManager(db, orgId, actorId, chain.requisitionId);
        privileged = true;
      } catch {
        privileged = false;
      }
    }
    const person = await loadApprovalPerson(db, orgId, actorId).catch(() => null);
    const onPanel = person?.partyId
      ? await actorOnInterviewPanel(db, orgId, actorId, interviewId)
      : false;
    if (!privileged && !onPanel) {
      try {
        await requireHrmRecruitingRead(db, orgId, actorId, chain.requisitionId);
      } catch {
        throw new RecruitingError(
          "REFUSED",
          "scorecards are visible to the panel, the hiring manager, and holders of hrm.recruiting.read — ask the organizer for a panel seat",
        );
      }
      // A reader with the read grant but no panel seat and no manager
      // scope sees nothing identifiable: the blind rule's shape for
      // non-participants.
      return { mine: null, others: [], blinded: true };
    }
    const cards = (await db.execute<ScorecardRow>(sql`
      select id, interview_id as "interviewId", interviewer_party_id as "interviewerPartyId",
             overall, submitted_at as "submittedAt",
             private_notes as "privateNotes", shared_notes as "sharedNotes"
        from hrm_scorecards
       where org_id = ${orgId} and interview_id = ${interviewId}
       order by interviewer_party_id
    `)).rows;
    const ratings = (await db.execute<RatingRow>(sql`
      select r.scorecard_id as "scorecardId", r.attribute_id as "attributeId",
             r.rating_key as "ratingKey", r.note
        from hrm_scorecard_ratings r
        join hrm_scorecards s on s.org_id = r.org_id and s.id = r.scorecard_id
       where r.org_id = ${orgId} and s.interview_id = ${interviewId}
    `)).rows;
    const names = await partyDisplayNames(
      db,
      orgId,
      cards.map((card) => card.interviewerPartyId),
    );
    const mine = person?.partyId
      ? (cards.find((card) => card.interviewerPartyId === person.partyId) ?? null)
      : null;
    const mineSubmitted = mine?.submittedAt != null;
    // THE BLIND RULE: others' verdicts open to an interviewer only after
    // their own submission. Managers and manage-holders read the full set.
    const showOthers = privileged || mineSubmitted;
    const others = showOthers
      ? cards
          .filter((card) => card.id !== mine?.id)
          .map((card) => toDTO(card, ratings, names, false))
      : [];
    return {
      mine: mine ? toDTO(mine, ratings, names, true) : null,
      others,
      blinded: !showOthers,
    };
  });
}

/**
 * Scorecard summary: aggregates over submitted verdicts. Privileged viewers
 * (manage holders, the hiring manager on their own requisition) see missing
 * seats by name; holders of the read grant on the interview's requisition
 * get the same aggregates as a read-safe projection with names withheld —
 * panel membership is not every reader's business. Private notes never
 * appear on either path (only the author reads them, via the cards shape).
 */
export async function scorecardSummary(query: ScorecardReadQuery): Promise<ScorecardSummary> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const chain = await interviewRequisition(db, orgId, interviewId);
    let privileged = false;
    try {
      await requireHrmRecruitingManage(db, orgId, actorId, chain.requisitionId);
      privileged = true;
    } catch {
      try {
        await requireOwnRequisitionForHiringManager(db, orgId, actorId, chain.requisitionId);
        privileged = true;
      } catch {
        privileged = false;
      }
    }
    if (!privileged) {
      await requireHrmRecruitingRead(db, orgId, actorId, chain.requisitionId);
    }
    const cards = (await db.execute<ScorecardRow>(sql`
      select id, interview_id as "interviewId", interviewer_party_id as "interviewerPartyId",
             overall, submitted_at as "submittedAt",
             private_notes as "privateNotes", shared_notes as "sharedNotes"
        from hrm_scorecards
       where org_id = ${orgId} and interview_id = ${interviewId}
       order by interviewer_party_id
    `)).rows;
    const ratings = (await db.execute<RatingRow>(sql`
      select r.scorecard_id as "scorecardId", r.attribute_id as "attributeId",
             r.rating_key as "ratingKey", r.note
        from hrm_scorecard_ratings r
        join hrm_scorecards s on s.org_id = r.org_id and s.id = r.scorecard_id
       where r.org_id = ${orgId} and s.interview_id = ${interviewId}
    `)).rows;
    const names = await partyDisplayNames(
      db,
      orgId,
      cards.map((card) => card.interviewerPartyId),
    );
    const submitted = cards.filter((card) => card.submittedAt != null);
    const missing = cards
      .filter((card) => card.submittedAt == null)
      .map((card) => names.get(card.interviewerPartyId) ?? card.interviewerPartyId);
    const overallCounts: Record<string, number> = {};
    for (const card of submitted) {
      if (card.overall) overallCounts[card.overall] = (overallCounts[card.overall] ?? 0) + 1;
    }
    const kit = chain.kitId ? await loadKit(db, orgId, chain.kitId) : null;
    const attributes = kit ? await listKitAttributes(db, orgId, kit.id) : [];
    const perAttribute = attributes.map((attr) => {
      const attrRatings = ratings.filter((rating) => rating.attributeId === attr.id);
      const counts: Record<string, number> = {};
      let total = 0;
      for (const rating of attrRatings) {
        counts[rating.ratingKey] = (counts[rating.ratingKey] ?? 0) + 1;
        total += RATING_VALUES[rating.ratingKey] ?? 0;
      }
      return {
        attributeId: attr.id,
        category: attr.category,
        attribute: attr.attribute,
        ratings: attrRatings.length,
        average: attrRatings.length > 0 ? total / attrRatings.length : null,
        counts,
      };
    });
    return {
      interviewId,
      complete: cards.length > 0 && missing.length === 0,
      submittedCount: submitted.length,
      totalCount: cards.length,
      // Read-safe projection: counts stay, names are privileged-only.
      missing: privileged ? missing : [],
      overallCounts,
      perAttribute,
    };
  });
}

/**
 * Pure blind-rule core for unit tests: which cards a viewer may see.
 * Authors always see their own; others open only after the viewer's own
 * submission, or when the viewer is privileged (manager/manage).
 */
export function blindVisibleCardIds(args: {
  viewerPartyId: string | null;
  privileged: boolean;
  cards: readonly { id: string; interviewerPartyId: string; submittedAt: string | null }[];
}): { mine: string | null; otherIds: readonly string[]; blinded: boolean } {
  const mine = args.cards.find((card) => card.interviewerPartyId === args.viewerPartyId) ?? null;
  const showOthers = args.privileged || (mine?.submittedAt != null);
  return {
    mine: mine?.id ?? null,
    otherIds: showOthers ? args.cards.filter((card) => card.id !== mine?.id).map((card) => card.id) : [],
    blinded: !showOthers,
  };
}
