import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManage } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import {
  enqueueRecruitingEmailJob,
  escapeHtml,
  notifyUsers,
  pgUuidArray,
  requireDepthFeature,
  userIdsForParties,
  type RecruitingEmailEnqueuer,
} from "./depth.ts";
import {
  BOOKING_TOKEN_TTL_MS,
  createRecruitingToken,
  hashRecruitingToken,
  verifyRecruitingToken,
} from "./tokens.ts";

/**
 * Canonical interview-scheduling service (HR-18, 0229): candidate
 * self-booking over declared availability.
 *
 * - proposeSlots stores proposed rows from an interviewer pool's DECLARED
 *   availability windows (windows the pool declares in Setup — never read
 *   from a calendar) and mints ONE self-booking link (token + expiry)
 *   covering the batch. Only the token hash is stored.
 * - bookSlot is first-wins under concurrency: the conditional UPDATE names
 *   kind='proposed', so two candidates racing the same slot serialize —
 *   the loser gets a taken-slot refusal naming the remedy (pick another
 *   slot), never a double booking. Booking declines the sibling proposed
 *   slots and notifies the panel through the notifications table plus an
 *   email, all in the same transaction as the booking.
 * - reschedule keeps history: old rows go declined, new rows go proposed
 *   with a FRESH token (the old link dies with the batch it opened).
 * - The calendar provider integration is an org-declared connector behind
 *   sync connections: calendar_ref carries provider event ids, and the
 *   connector interface is declared here but left unimplemented-by-name.
 *   This service never performs OAuth.
 */

export interface SlotInput {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
}

export interface SlotDTO {
  readonly id: string;
  readonly interviewId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly kind: string;
  readonly expiresAt: string | null;
}

export interface ProposeResult {
  readonly slots: readonly SlotDTO[];
  /** The raw booking token — shown once and emailed, never stored. */
  readonly bookingToken: string;
  readonly bookingUrlPath: string;
  readonly expiresAt: string;
}

/** Declared availability window shape stored on interviewer pools. */
export interface AvailabilityWindow {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
}

/** Validate declared windows (pure, unit-tested): ordered, non-empty, honest timezones. */
export function validateAvailabilityWindows(windows: unknown): AvailabilityWindow[] {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new RecruitingError(
      "INVALID_INPUT",
      "propose at least one availability window — scheduling books from declared windows, never from a calendar",
    );
  }
  return windows.map((window, index) => {
    const startsAt = (window as { startsAt?: unknown }).startsAt;
    const endsAt = (window as { endsAt?: unknown }).endsAt;
    const timezone = (window as { timezone?: unknown }).timezone;
    if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) {
      throw new RecruitingError("INVALID_INPUT", `window ${index} needs an ISO startsAt — declare when the window opens`);
    }
    if (typeof endsAt !== "string" || Number.isNaN(Date.parse(endsAt))) {
      throw new RecruitingError("INVALID_INPUT", `window ${index} needs an ISO endsAt — declare when the window closes`);
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new RecruitingError("INVALID_INPUT", `window ${index} ends before it starts — declare an ordered window`);
    }
    if (typeof timezone !== "string" || timezone.trim().length === 0) {
      throw new RecruitingError("INVALID_INPUT", `window ${index} needs a timezone — declare where the clock lives`);
    }
    return { startsAt, endsAt, timezone: timezone.trim() };
  });
}

/**
 * The calendar-provider connector contract (org-declared, behind sync
 * connections). The generic layer builds the self-booking link and the
 * slot model; it does NOT build Google/Microsoft OAuth. A connector
 * implementing this interface pushes booked slots to the provider's
 * calendar and stores the provider event ids in calendar_ref.
 * Unimplemented by name: no connector is registered here.
 */
export interface SchedulingConnector {
  readonly key: string;
  pushBooking(args: {
    orgId: string;
    interviewId: string;
    slotId: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }): Promise<{ calendarRef: unknown } | null>;
}

type SlotRow = {
  id: string;
  interviewId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  kind: string;
  expiresAt: string | null;
};

function toSlotDTO(row: SlotRow): SlotDTO {
  return {
    id: row.id,
    interviewId: row.interviewId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    kind: row.kind,
    expiresAt: row.expiresAt,
  };
}

async function interviewChain(
  exec: SqlExecutor,
  orgId: string,
  interviewId: string,
): Promise<{ requisitionId: string; candidateEmail: string | null; candidateName: string }> {
  const row = (await exec.execute<{
    requisitionId: string;
    candidateEmail: string | null;
    candidateName: string;
  }>(sql`
    select a.requisition_id as "requisitionId", c.email as "candidateEmail",
           c.display_name as "candidateName"
      from hrm_interviews i
      join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
      join hrm_candidates c on c.org_id = i.org_id and c.id = a.candidate_id
     where i.org_id = ${orgId} and i.id = ${interviewId}
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
  }
  return row;
}

async function panelParties(exec: SqlExecutor, orgId: string, interviewId: string): Promise<string[]> {
  const rows = (await exec.execute<{ partyId: string }>(sql`
    select party_id as "partyId" from hrm_interview_panel
     where org_id = ${orgId} and interview_id = ${interviewId} order by party_id
  `)).rows;
  return rows.map((row) => row.partyId);
}

export async function proposeSlots(query: {
  orgId: string;
  actorId: string;
  interviewId: string;
  windows: unknown;
  expiresAt?: unknown;
}): Promise<ProposeResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  const windows = validateAvailabilityWindows(query.windows);
  const expiresAt =
    typeof query.expiresAt === "string" && !Number.isNaN(Date.parse(query.expiresAt))
      ? new Date(query.expiresAt).toISOString()
      : new Date(Date.now() + BOOKING_TOKEN_TTL_MS).toISOString();
  return withOrgTransaction(orgId, async () => {
    const chain = await interviewChain(db, orgId, interviewId);
    await requireHrmRecruitingManage(db, orgId, actorId, chain.requisitionId);
    await requireDepthFeature(db, orgId, "hrmInterviewScheduling");
    const interview = (await db.execute<{ status: string }>(sql`
      select status from hrm_interviews where org_id = ${orgId} and id = ${interviewId}
    `)).rows[0];
    if (!interview) throw new RecruitingError("NOT_FOUND", "interview is not visible in this organization");
    if (interview.status !== "scheduled") {
      throw new RecruitingError(
        "REFUSED",
        `a ${interview.status} interview takes no new slots — schedule a fresh interview instead of reopening this one`,
      );
    }
    // A fresh link per batch: any live proposed batch for this interview is
    // declined first, so exactly one booking link is live at a time and an
    // old link can never book a superseded slot.
    await db.execute(sql`
      update hrm_interview_slots
         set kind = 'declined', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and interview_id = ${interviewId} and kind = 'proposed'
    `);
    const token = createRecruitingToken({
      purpose: "book",
      rowId: interviewId,
      expiresAt: Date.parse(expiresAt),
    });
    const tokenHash = hashRecruitingToken(token);
    const slots: SlotDTO[] = [];
    for (const window of windows) {
      const row = (await db.execute<SlotRow>(sql`
        insert into hrm_interview_slots
          (org_id, interview_id, starts_at, ends_at, timezone, kind,
           proposed_by, candidate_token_hash, expires_at, created_by, updated_by)
        values (${orgId}, ${interviewId}, ${window.startsAt}, ${window.endsAt}, ${window.timezone},
                'proposed', ${actorId}, ${tokenHash}, ${expiresAt}, ${actorId}, ${actorId})
        returning id, interview_id as "interviewId",
                  starts_at as "startsAt", ends_at as "endsAt", timezone, kind,
                  expires_at as "expiresAt"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the slot was not stored — no row was written; retry the request");
      slots.push(toSlotDTO(row));
    }
    if (slots.length === 0) {
      throw new RecruitingError("REFUSED", "no slots were stored — no rows were written; retry the request");
    }
    return {
      slots,
      bookingToken: token,
      bookingUrlPath: `/book/${token}`,
      expiresAt,
    };
  });
}

export interface BookSlotQuery {
  readonly bookingToken: string;
  readonly slotId: string;
  readonly candidateName: unknown;
  readonly enqueueEmail?: RecruitingEmailEnqueuer;
}

/**
 * Book one proposed slot through the sessionless link. First wins: the
 * conditional UPDATE carries kind='proposed', so concurrent attempts on
 * the same slot serialize and the loser is refused BY NAME (never double
 * booked). Token reuse after expiry is refused as expired; a second
 * booking on a taken slot is refused as taken.
 */
export async function bookSlot(query: BookSlotQuery): Promise<SlotDTO> {
  if (typeof query.bookingToken !== "string" || query.bookingToken.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a booking link is required — open the link the recruiter sent");
  }
  const claims = verifyRecruitingToken(query.bookingToken, "book");
  if (!claims) {
    throw new RecruitingError(
      "REFUSED",
      "this booking link is invalid or expired — ask the recruiter for a fresh link instead of reusing this one",
    );
  }
  const interviewId = claims.rowId;
  const tokenHash = hashRecruitingToken(query.bookingToken);
  // The token binds the interview but not the org: resolve the org through
  // the stored hash under bypass (the email-action route precedent;
  // same-org by construction — the hash was written by proposeSlots in the
  // interview's org), then run everything else under that org.
  const scope = await withBypassContext(async () => {
    const found = (await db.execute<{ orgId: string; expiresAt: string | null }>(sql`
      select org_id as "orgId", max(expires_at) as "expiresAt"
        from hrm_interview_slots
       where candidate_token_hash = ${tokenHash}
       group by org_id limit 2
    `)).rows;
    return found;
  });
  if (scope.length !== 1 || !scope[0]) {
    throw new RecruitingError(
      "REFUSED",
      "this booking link is no longer live — a reschedule replaces the link; ask the recruiter for the current one",
    );
  }
  const orgId = scope[0].orgId;
  return withOrgTransaction(orgId, async () => {
    const link = (await db.execute<{ expiresAt: string | null }>(sql`
      select max(expires_at) as "expiresAt" from hrm_interview_slots
       where org_id = ${orgId} and interview_id = ${interviewId}
         and candidate_token_hash = ${tokenHash} and kind = 'proposed'
    `)).rows[0];
    if (!link?.expiresAt || Date.parse(link.expiresAt) <= Date.now()) {
      throw new RecruitingError(
        "REFUSED",
        "this booking link expired — ask the recruiter for a fresh link instead of reusing this one",
      );
    }
    const slotId = requireId(query.slotId, "slotId");
    // FIRST WINS: exactly one concurrent booker flips proposed→booked; the
    // others match zero rows and are refused as taken below.
    const booked = (await db.execute<SlotRow>(sql`
      update hrm_interview_slots
         set kind = 'booked', booked_by_candidate_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${slotId} and interview_id = ${interviewId}
         and kind = 'proposed' and candidate_token_hash = ${tokenHash}
      returning id, interview_id as "interviewId",
                starts_at as "startsAt", ends_at as "endsAt", timezone, kind,
                expires_at as "expiresAt"
    `)).rows[0];
    if (!booked) {
      throw new RecruitingError(
        "REFUSED",
        "this slot was just taken — pick another proposed slot instead of retrying this one",
      );
    }
    await db.execute(sql`
      update hrm_interview_slots
         set kind = 'declined', updated_at = now()
       where org_id = ${orgId} and interview_id = ${interviewId}
         and kind = 'proposed' and id <> ${slotId}
    `);
    const chain = await interviewChain(db, orgId, interviewId);
    const parties = await panelParties(db, orgId, interviewId);
    const userIds = await userIdsForParties(db, orgId, parties);
    const when = new Date(booked.startsAt).toLocaleString("en-CA", { timeZone: booked.timezone });
    await notifyUsers(db, {
      orgId,
      actorId: null,
      notices: userIds.map((userId) => ({
        userId,
        kind: "interview_booked",
        title: `${chain.candidateName} booked an interview slot`,
        body: `${chain.candidateName} booked ${when} (${booked.timezone}). The other proposed slots were declined.`,
        href: "/hrm/recruiting",
      })),
    });
    const enqueue = query.enqueueEmail ?? enqueueRecruitingEmailJob;
    if (chain.candidateEmail) {
      await enqueue(
        {
          orgId,
          to: chain.candidateEmail,
          subject: "Your interview is booked",
          html: `<p>Your interview is booked for ${escapeHtml(when)} (${escapeHtml(booked.timezone)}).</p>`,
          text: `Your interview is booked for ${when} (${booked.timezone}).`,
        },
        { jobId: `interview-booked|${orgId}|${booked.id}` },
      );
    }
    return toSlotDTO(booked);
  });
}

/** Read the live proposed slots for a booking link (public, sessionless). */
export async function readBookingLink(bookingToken: string): Promise<{
  readonly interviewId: string;
  readonly candidateName: string;
  readonly slots: readonly SlotDTO[];
  readonly expiresAt: string | null;
}> {
  const claims = verifyRecruitingToken(bookingToken, "book");
  if (!claims) {
    throw new RecruitingError(
      "REFUSED",
      "this booking link is invalid or expired — ask the recruiter for a fresh link instead of reusing this one",
    );
  }
  const tokenHash = hashRecruitingToken(bookingToken);
  const rows = await withBypassContext(async () => {
    const found = (await db.execute<SlotRow & { orgId: string }>(sql`
      select org_id as "orgId", id, interview_id as "interviewId",
             starts_at as "startsAt", ends_at as "endsAt", timezone, kind,
             expires_at as "expiresAt"
        from hrm_interview_slots
       where candidate_token_hash = ${tokenHash} and kind = 'proposed'
       order by starts_at
    `)).rows;
    return found;
  });
  if (rows.length === 0) {
    throw new RecruitingError(
      "REFUSED",
      "this booking link has no open slots — every slot was booked or declined; ask the recruiter for a fresh link",
    );
  }
  const orgId = (rows[0] as SlotRow & { orgId: string }).orgId;
  // Scoped reads run inside the resolved org (public routes carry no
  // request-org RLS scope, so the explicit org predicate alone is not
  // enough under FORCE RLS).
  return withOrgTransaction(orgId, async () => {
    const chain = await interviewChain(db, orgId, claims.rowId);
    return {
      interviewId: claims.rowId,
      candidateName: chain.candidateName,
      slots: rows.map(toSlotDTO),
      expiresAt: rows[0]?.expiresAt ?? null,
    };
  });
}

/**
 * Upcoming interview sittings for the Interviews surface
 * (loader-resolved): interview + candidate + requisition names, slot
 * state, and scorecard submitted/total per sitting. Names only — the
 * scorecard contents stay behind the blind read.
 */
export async function listUpcomingInterviews(query: {
  orgId: string;
  actorId: string;
}): Promise<
  readonly {
    id: string;
    kind: string;
    scheduledAt: string;
    status: string;
    candidateName: string;
    requisitionTitle: string;
    proposedSlots: number;
    bookedSlots: number;
    scorecardsSubmitted: number;
    scorecardsTotal: number;
  }[]
> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const { requireAggregateRecruitingRead } = await import("../authorization.ts");
    const allowed = await requireAggregateRecruitingRead(db, orgId, actorId);
    const rows = (await db.execute<{
      id: string;
      kind: string;
      scheduledAt: string;
      status: string;
      candidateName: string;
      requisitionTitle: string;
      proposedSlots: string;
      bookedSlots: string;
      scorecardsSubmitted: string;
      scorecardsTotal: string;
    }>(sql`
      select i.id, i.kind, i.scheduled_at as "scheduledAt", i.status,
             c.display_name as "candidateName", r.title as "requisitionTitle",
             (select count(*)::text from hrm_interview_slots s
               where s.org_id = i.org_id and s.interview_id = i.id and s.kind = 'proposed') as "proposedSlots",
             (select count(*)::text from hrm_interview_slots s
               where s.org_id = i.org_id and s.interview_id = i.id and s.kind = 'booked') as "bookedSlots",
             (select count(*)::text from hrm_scorecards k
               where k.org_id = i.org_id and k.interview_id = i.id and k.submitted_at is not null) as "scorecardsSubmitted",
             (select count(*)::text from hrm_scorecards k
               where k.org_id = i.org_id and k.interview_id = i.id) as "scorecardsTotal"
        from hrm_interviews i
        join hrm_applications a on a.org_id = i.org_id and a.id = i.application_id
        join hrm_candidates c on c.org_id = i.org_id and c.id = a.candidate_id
        join hrm_requisitions r on r.org_id = i.org_id and r.id = a.requisition_id
       where i.org_id = ${orgId} and i.status = 'scheduled'
         and (${allowed === null} or a.requisition_id = any(${allowed === null ? "{}" : pgUuidArray([...allowed])}::uuid[]))
       order by i.scheduled_at
       limit 200
    `)).rows;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      scheduledAt: row.scheduledAt,
      status: row.status,
      candidateName: row.candidateName,
      requisitionTitle: row.requisitionTitle,
      proposedSlots: Number(row.proposedSlots),
      bookedSlots: Number(row.bookedSlots),
      scorecardsSubmitted: Number(row.scorecardsSubmitted),
      scorecardsTotal: Number(row.scorecardsTotal),
    }));
  });
}

/** Upcoming/today slot reads for the Interviews surface (loader-resolved). */
export async function listInterviewSlots(query: {
  orgId: string;
  actorId: string;
  interviewId: string;
}): Promise<readonly SlotDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const interviewId = requireId(query.interviewId, "interviewId");
  return withOrgTransaction(orgId, async () => {
    const chain = await interviewChain(db, orgId, interviewId);
    await requireHrmRecruitingManage(db, orgId, actorId, chain.requisitionId);
    await requireDepthFeature(db, orgId, "hrmInterviewScheduling");
    const rows = (await db.execute<SlotRow>(sql`
      select id, interview_id as "interviewId",
             starts_at as "startsAt", ends_at as "endsAt", timezone, kind,
             expires_at as "expiresAt"
        from hrm_interview_slots
       where org_id = ${orgId} and interview_id = ${interviewId}
       order by starts_at
    `)).rows;
    return rows.map(toSlotDTO);
  });
}
