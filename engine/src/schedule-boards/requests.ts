import { lockApprovalSubject, readNativeApprovalDecision } from "../platform/approval-routing.ts";
/**
 * Shift requests: an employee asks to release, change or swap their own
 * published future booking from My schedule.
 *
 * A swap first needs the named colleague's acceptance. A request awaiting a
 * decision is submitted to any enabled Shift request Flow. Approval is
 * optional and owned by Flows: when a Flow raises an approval gate, the
 * request waits and the gate's decision applies or declines it; who may
 * decide, including separation from the people the request involves, is the
 * Flow's policy. When no Flow gates it, the request is applied at once and
 * records that no approval applied.
 *
 * Applying a request changes the bookings in the same transaction: the
 * booking is released, replaced with the requested times, or exchanged with
 * the colleague's booking. The booking ledger's guards check availability,
 * recorded leave, required qualifications and double booking, so a request
 * that would conflict is refused and nothing changes.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import {
  boardAuthority,
  getBoard,
  requireBoardCapability,
  type ScheduleActor,
  type ScheduleBoard,
} from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import {
  cancelPendingRevisions,
  exactStoredBooking,
  hash,
  insertEntry,
  noticeFor,
  readEntry,
  recordPatternOmission,
  setStatus,
  STORED_COLUMNS,
  type ScheduleNotice,
  type StoredEntry,
} from "./entries.ts";
import { localTimeFields } from "../platform/time-zone.ts";
import { timedSpan } from "./spans.ts";
import { boardHasCapability } from "./board-types.ts";
import { deliverScheduleNotice, scheduleBoardLifecycle } from "./distribution-hooks.ts";

export const SHIFT_REQUEST_SUBJECT_KIND = "schedule_entry_request";

export type ShiftRequestKind = "release" | "change" | "swap";
export type ShiftRequestStatus =
  "awaiting_counterpart" | "pending" | "approved" | "declined" | "withdrawn";

export type ShiftRequest = {
  readonly id: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly entryId: string;
  readonly entryRevision: number;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly kind: ShiftRequestKind;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly proposedStartsAt: string | null;
  readonly proposedEndsAt: string | null;
  readonly proposedBreakMinutes: number | null;
  readonly counterpartEntryId: string | null;
  readonly counterpartEntryRevision: number | null;
  readonly counterpartPartyId: string | null;
  readonly counterpartName: string | null;
  readonly counterpartStartsAt: string | null;
  readonly counterpartEndsAt: string | null;
  readonly status: ShiftRequestStatus;
  readonly flowRunId: string | null;
  readonly flowGated: boolean;
  readonly releasedWithoutApproval: boolean;
  readonly reason: string;
  readonly decisionReason: string | null;
  readonly decidedByName: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revision: number;
};

const INSTANT = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const REQUEST_COLUMNS = sql`r.id, r.board_id as "boardId", b.name as "boardName", r.entry_id as "entryId", r.entry_revision as "entryRevision",
  r.worker_party_id as "workerPartyId", w.display_name as "workerName", r.kind,
  ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt", e.time_zone as "timeZone",
  ${INSTANT(sql`r.proposed_starts_at`)} as "proposedStartsAt", ${INSTANT(sql`r.proposed_ends_at`)} as "proposedEndsAt", r.proposed_break_minutes as "proposedBreakMinutes",
  r.counterpart_entry_id as "counterpartEntryId", r.counterpart_entry_revision as "counterpartEntryRevision", r.counterpart_party_id as "counterpartPartyId", cp.display_name as "counterpartName",
  ${INSTANT(sql`ce.starts_at`)} as "counterpartStartsAt", ${INSTANT(sql`ce.ends_at`)} as "counterpartEndsAt",
  r.status, r.flow_run_id as "flowRunId", r.released_without_approval as "releasedWithoutApproval",
  exists (select 1 from flow_gates g where g.org_id = r.org_id and g.subject_kind = ${SHIFT_REQUEST_SUBJECT_KIND} and g.subject_id = r.id and g.status in ('pending', 'escalated')) as "flowGated",
  r.reason, r.decision_reason as "decisionReason", du.name as "decidedByName", ${INSTANT(sql`r.created_at`)} as "createdAt", r.created_by as "createdBy", r.revision`;

const REQUEST_JOINS = sql`from schedule_entry_requests r
  join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id
  join schedule_entries e on e.org_id = r.org_id and e.id = r.entry_id
  join parties w on w.org_id = r.org_id and w.id = r.worker_party_id
  left join schedule_entries ce on ce.org_id = r.org_id and ce.id = r.counterpart_entry_id
  left join parties cp on cp.org_id = r.org_id and cp.id = r.counterpart_party_id
  left join users du on du.org_id = r.org_id and du.id = r.decided_by`;

type RoutingResult = {
  gated: boolean;
  runId: string | null;
  failed: boolean;
  error: string | null;
};
type Router = (actor: ScheduleActor, requestId: string) => Promise<RoutingResult>;
const runtime = globalThis as typeof globalThis & { __shiftRequestRouter?: Router };

/** The composition root routes submitted requests through optional Flows. */
export function registerShiftRequestRouting(router: Router): void {
  runtime.__shiftRequestRouter = router;
}

async function route(actor: ScheduleActor, requestId: string): Promise<RoutingResult> {
  if (!runtime.__shiftRequestRouter) {
    throw new Error(
      "Shift request routing is not installed in this process. Install the native engine composition before accepting requests.",
    );
  }
  return runtime.__shiftRequestRouter(actor, requestId);
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value))
    throw new ScheduleError(`${field} is not recognized.`, { code: "schedule_invalid" });
  return value;
}

function reasonText(value: unknown, field = "Reason"): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2000) {
    throw new ScheduleError(`${field} is required.`, {
      code: "schedule_invalid",
      remedy: "Explain the request or decision in up to 2000 characters.",
    });
  }
  return value.trim();
}

async function readRequest(orgId: string, id: string): Promise<ShiftRequest> {
  const row = (
    await db.execute<ShiftRequest>(
      sql`select ${REQUEST_COLUMNS} ${REQUEST_JOINS} where r.org_id = ${orgId} and r.id = ${id}`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

/** Self-service needs Scheduling, the request permission and a login linked to the person. */
async function selfServiceParty(actor: ScheduleActor): Promise<string> {
  if (
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrm")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning"))
  )
    throw new ScopeNotFoundError();
  await lockActorCommandAuthority(db, actor.orgId, actor.actorId, null, "hrm.self.request");
  const party = (
    await db.execute<{ partyId: string | null }>(
      sql`select party_id as "partyId" from users where org_id = ${actor.orgId} and id = ${actor.actorId} and is_active for share`,
      "objects",
    )
  )[0];
  if (!party?.partyId) {
    throw new ScheduleError("Your login is not linked to a person.", {
      code: "schedule_no_person",
      remedy: "Ask an administrator to link your user to your employee record.",
    });
  }
  return party.partyId;
}

async function lockEntry(orgId: string, id: string): Promise<StoredEntry> {
  const row = (
    await db.execute<StoredEntry>(
      sql`select ${STORED_COLUMNS} from schedule_entries where org_id = ${orgId} and id = ${id} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

function requestable(row: StoredEntry, party: string, revision: unknown, label: string): void {
  if (row.workerPartyId !== party || row.status !== "published") throw new ScopeNotFoundError();
  if (!Number.isSafeInteger(revision) || row.revision !== revision) {
    throw new ScheduleError(`${label} changed since your schedule was loaded.`, {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload your schedule and make the request again.",
    });
  }
  if (row.started || row.closed)
    throw new ScheduleError(`${label} has already started.`, {
      code: "schedule_request_started",
      remedy: "Ask your scheduler directly about shifts in progress.",
    });
}

async function openRequestFor(orgId: string, entryId: string): Promise<boolean> {
  return (
    (
      await db.execute(
        sql`select 1 from schedule_entry_requests where org_id = ${orgId} and status in ('awaiting_counterpart', 'pending')
    and ${entryId} in (entry_id, counterpart_entry_id) limit 1`,
        "objects",
      )
    ).length > 0
  );
}

export interface ShiftRequestInput {
  readonly id: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly kind: ShiftRequestKind;
  /** Requested local clock times on the booking's date, for a change. */
  readonly change?: {
    readonly starts: string;
    readonly ends: string;
    readonly breakMinutes: number;
  } | null;
  readonly counterpartEntryId?: string | null;
  readonly counterpartRevision?: number | null;
  readonly reason: string;
}

/** Request a release, change or swap of the caller's own published booking. */
export async function createOwnShiftRequest(
  actor: ScheduleActor & ShiftRequestInput,
): Promise<ShiftRequestDecision> {
  const id = requireId(actor.id, "Request key"),
    entryId = requireId(actor.entryId, "Booking"),
    reason = reasonText(actor.reason);
  if (!["release", "change", "swap"].includes(actor.kind))
    throw new ScheduleError("Choose to release, change or swap the shift.", {
      code: "schedule_invalid",
    });
  if (actor.kind !== "change" && actor.change)
    throw new ScheduleError("Only a change request names new times.", { code: "schedule_invalid" });
  if (actor.kind !== "swap" && actor.counterpartEntryId)
    throw new ScheduleError("Only a swap names a colleague's shift.", { code: "schedule_invalid" });
  const requestHash = hash({
    entryId,
    expectedRevision: actor.expectedRevision,
    kind: actor.kind,
    change: actor.change ?? null,
    counterpartEntryId: actor.counterpartEntryId ?? null,
    counterpartRevision: actor.counterpartRevision ?? null,
    reason,
  });
  return withOrgTransaction(actor.orgId, async () => {
    const party = await selfServiceParty(actor);
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-request:${actor.orgId}:${id}`}, 0))`,
    );
    const existing = (
      await db.execute<{ requestHash: string; createdBy: string }>(
        sql`select request_hash as "requestHash", created_by as "createdBy"
      from schedule_entry_requests where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (existing.requestHash !== requestHash || existing.createdBy !== actor.actorId) {
        throw new ScheduleError("This request key was already used for a different request.", {
          status: 409,
          code: "schedule_key_reused",
          remedy: "Reload your schedule; the existing request is preserved.",
        });
      }
      const replayed = await readRequest(actor.orgId, id);
      return {
        request: replayed,
        notices: [],
        boardName: replayed.boardName,
        distributionRefusals: [],
      };
    }
    const entry = await lockEntry(actor.orgId, entryId);
    requestable(entry, party, actor.expectedRevision, "The shift");
    if (entry.removesPredecessor || !entry.workerPartyId) throw new ScopeNotFoundError();
    const boardType = (
      await db.execute<{ boardType: string }>(
        sql`select board_type as "boardType" from schedule_boards where org_id = ${actor.orgId} and id = ${entry.boardId}`,
        "objects",
      )
    )[0];
    if (!boardType || !boardHasCapability(boardType, "shift_requests")) {
      throw new ScheduleError("This shift cannot be requested from your schedule.", {
        code: "schedule_capability_unavailable",
        remedy: "Ask your scheduler to change this booking.",
      });
    }
    if (await openRequestFor(actor.orgId, entry.id)) {
      throw new ScheduleError("This shift already has an open request.", {
        status: 409,
        code: "schedule_request_open",
        remedy: "Withdraw the open request or wait for its decision.",
      });
    }
    let proposed: { startsAt: string; endsAt: string; breakMinutes: number } | null = null;
    let counterpart: StoredEntry | null = null;
    if (actor.kind === "change") {
      if (!actor.change)
        throw new ScheduleError("A change request needs the new start, end and break.", {
          code: "schedule_invalid",
        });
      const span = timedSpan({
        onDate: entry.startsOn,
        starts: actor.change.starts,
        ends: actor.change.ends,
        breakMinutes: actor.change.breakMinutes,
        timeZone: entry.timeZone,
      });
      if (
        span.startsAt === entry.startsAt &&
        span.endsAt === entry.endsAt &&
        span.breakMinutes === entry.breakMinutes
      ) {
        throw new ScheduleError("The requested times are the shift's current times.", {
          code: "schedule_invalid",
          remedy: "Enter the times you would like to work instead.",
        });
      }
      proposed = { startsAt: span.startsAt, endsAt: span.endsAt, breakMinutes: span.breakMinutes };
    }
    if (actor.kind === "swap") {
      counterpart = await lockEntry(
        actor.orgId,
        requireId(actor.counterpartEntryId, "Colleague's shift"),
      );
      if (
        counterpart.boardId !== entry.boardId ||
        counterpart.status !== "published" ||
        !counterpart.workerPartyId ||
        counterpart.workerPartyId === party ||
        counterpart.removesPredecessor
      )
        throw new ScopeNotFoundError();
      if (
        !Number.isSafeInteger(actor.counterpartRevision) ||
        counterpart.revision !== actor.counterpartRevision
      ) {
        throw new ScheduleError("Your colleague's shift changed since it was listed.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the swap options and choose again.",
        });
      }
      if (counterpart.started || counterpart.closed)
        throw new ScheduleError("Your colleague's shift has already started.", {
          code: "schedule_request_started",
          remedy: "Choose a shift that has not started.",
        });
      if (await openRequestFor(actor.orgId, counterpart.id)) {
        throw new ScheduleError("Your colleague's shift already has an open request.", {
          status: 409,
          code: "schedule_request_open",
          remedy: "Choose another shift or wait for that request's decision.",
        });
      }
    }
    const inserted = await db.execute(
      sql`insert into schedule_entry_requests (id, org_id, board_id, entry_id, entry_revision, worker_party_id, subsidiary_id, kind,
      proposed_starts_at, proposed_ends_at, proposed_break_minutes, counterpart_entry_id, counterpart_entry_revision, counterpart_party_id, status,
      reason, request_hash, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${entry.boardId}, ${entry.id}, ${entry.revision}, ${party},
      (select subsidiary_id from schedule_entries where org_id = ${actor.orgId} and id = ${entry.id}), ${actor.kind},
      ${proposed?.startsAt ?? null}, ${proposed?.endsAt ?? null}, ${proposed?.breakMinutes ?? null},
      ${counterpart?.id ?? null}, ${counterpart?.revision ?? null}, ${counterpart?.workerPartyId ?? null},
      ${actor.kind === "swap" ? "awaiting_counterpart" : "pending"}, ${reason}, ${requestHash}, ${actor.actorId}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new ScheduleError("The request was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload your schedule and try again.",
      });
    if (actor.kind !== "swap") return submitForDecision(actor, id);
    const request = await readRequest(actor.orgId, id);
    return { request, notices: [], boardName: request.boardName, distributionRefusals: [] };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export const NO_APPROVAL_APPLIED = "No approval Flow applied; applied when submitted.";

/**
 * Submit a request that awaits a decision to any enabled Shift request Flow.
 * A gating Flow owns the decision; without one the request is applied now
 * by its submitter and records that no approval applied.
 */
async function submitForDecision(actor: ScheduleActor, id: string): Promise<ShiftRequestDecision> {
  const routed = await route(actor, id);
  if (routed.failed) {
    throw new ScheduleError("The shift request approval Flow could not start.", {
      code: "schedule_request_flow_failed",
      remedy: routed.error
        ? `Ask an administrator to review the Shift request Flow: ${routed.error}`
        : "Ask an administrator to review the Shift request Flow.",
    });
  }
  if (routed.gated) {
    const updated = await db.execute(
      sql`update schedule_entry_requests set flow_run_id = ${routed.runId}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${id} and status = 'pending' returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("The request changed while it was routed for approval.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload your schedule.",
      });
    const request = await readRequest(actor.orgId, id);
    return { request, notices: [], boardName: request.boardName, distributionRefusals: [] };
  }
  const request = await lockRequest(actor.orgId, id);
  return decide(
    actor,
    await getBoard(actor, request.boardId),
    request,
    "approve",
    NO_APPROVAL_APPLIED,
    "released",
  );
}

/** The colleague named in a swap accepts or declines it. */
export async function respondToSwap(
  actor: ScheduleActor & {
    requestId: string;
    expectedRevision: number;
    accept: boolean;
    reason: string;
  },
): Promise<ShiftRequestDecision> {
  const reason = reasonText(actor.reason, "A reply");
  return withOrgTransaction(actor.orgId, async () => {
    const party = await selfServiceParty(actor);
    const request = await lockRequest(actor.orgId, actor.requestId);
    if (request.counterpartPartyId !== party || request.kind !== "swap")
      throw new ScopeNotFoundError();
    if (request.status !== "awaiting_counterpart" || request.revision !== actor.expectedRevision) {
      throw new ScheduleError("This swap was already answered or withdrawn.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload your schedule.",
      });
    }
    const updated = await db.execute(
      actor.accept
        ? sql`update schedule_entry_requests set status = 'pending', counterpart_responded_by = ${actor.actorId}, counterpart_responded_at = now(),
          revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId} where org_id = ${actor.orgId} and id = ${request.id} and revision = ${request.revision} returning id`
        : sql`update schedule_entry_requests set status = 'declined', decided_by = ${actor.actorId}, decided_at = now(), decision_reason = ${reason},
          revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId} where org_id = ${actor.orgId} and id = ${request.id} and revision = ${request.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("This swap changed while you answered.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload your schedule.",
      });
    if (actor.accept) return submitForDecision(actor, request.id);
    const declined = await readRequest(actor.orgId, request.id);
    return {
      request: declined,
      notices: [],
      boardName: declined.boardName,
      distributionRefusals: [],
    };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** The requester withdraws an open request. */
export async function withdrawOwnShiftRequest(
  actor: ScheduleActor & { requestId: string; expectedRevision: number },
): Promise<ShiftRequest> {
  return withOrgTransaction(actor.orgId, async () => {
    await selfServiceParty(actor);
    const request = await lockRequest(actor.orgId, actor.requestId);
    if (request.createdBy !== actor.actorId) throw new ScopeNotFoundError();
    if (
      !["awaiting_counterpart", "pending"].includes(request.status) ||
      request.revision !== actor.expectedRevision
    ) {
      throw new ScheduleError("This request already has a decision.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload your schedule.",
      });
    }
    if (request.flowGated) {
      throw new ScheduleError("This request is with its approval Flow.", {
        status: 409,
        code: "schedule_request_flow_owned",
        remedy: "Ask the approver to decline it in the Flow.",
      });
    }
    const updated = await db.execute(
      sql`update schedule_entry_requests set status = 'withdrawn', revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${request.id} and revision = ${request.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("This request changed while you withdrew it.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload your schedule.",
      });
    return readRequest(actor.orgId, request.id);
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

async function lockRequest(orgId: string, id: string): Promise<ShiftRequest> {
  const locked = (
    await db.execute(
      sql`select id from schedule_entry_requests where org_id = ${orgId} and id = ${requireId(id, "Request")} for update`,
      "objects",
    )
  )[0];
  if (!locked) throw new ScopeNotFoundError();
  return readRequest(orgId, id);
}

export interface ShiftRequestDecision {
  readonly request: ShiftRequest;
  readonly notices: readonly ScheduleNotice[];
  readonly boardName: string;
  readonly distributionRefusals: readonly { message: string; remedy: string }[];
}

/** A Flow's approval gates resolved: apply the decision as the gate's decider. */
export async function releaseShiftRequestApproval(input: {
  orgId: string;
  actorId: string;
  requestId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
}): Promise<void> {
  const actor = { orgId: input.orgId, actorId: input.actorId };
  await withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, SHIFT_REQUEST_SUBJECT_KIND, input.requestId);
    const proof = await readNativeApprovalDecision({
      orgId: input.orgId,
      actorId: input.actorId,
      subjectKind: SHIFT_REQUEST_SUBJECT_KIND,
      subjectId: input.requestId,
      outcome: input.outcome,
      approvalRunId: input.approvalRunId,
    });
    if (!proof)
      throw new ScheduleError(
        "Complete the configured shift request Flow gates before releasing this request.",
      );
    const request = await lockRequest(actor.orgId, input.requestId);
    if (request.status !== "pending") {
      throw new ScheduleError("The shift request no longer awaits a decision.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Review the request's current state in Scheduling.",
      });
    }
    const board = await getBoard(actor, request.boardId);
    await boardAuthority(actor, board, "publish");
    const reason =
      input.comment?.trim() ||
      (input.outcome === "approved"
        ? "Approved through the shift request Flow"
        : "Declined through the shift request Flow");
    const result = await decide(
      actor,
      board,
      request,
      input.outcome === "approved" ? "approve" : "decline",
      reason,
      "flow",
    );
    if (input.outcome === "approved") {
      await deliverScheduleNotice({
        orgId: actor.orgId,
        actorId: actor.actorId,
        boardName: result.boardName,
        notices: result.notices,
      });
    }
  });
}

async function decide(
  actor: ScheduleActor,
  board: ScheduleBoard,
  request: ShiftRequest,
  decision: "approve" | "decline",
  reason: string,
  mode: "flow" | "released",
): Promise<ShiftRequestDecision> {
  if (request.status !== "pending")
    throw new ScheduleError("This request is not waiting for a decision.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the requests.",
    });
  if (decision !== "approve" && decision !== "decline")
    throw new ScheduleError("Choose to approve or decline the request.", {
      code: "schedule_invalid",
    });
  const notices: ScheduleNotice[] = [];
  const changedSubjects = new Set<string>();
  const changedDates = new Set<string>();
  if (decision === "approve") {
    const entry = await lockEntry(actor.orgId, request.entryId);
    changedSubjects.add(entry.subjectId);
    changedDates.add(entry.startsOn);
    changedDates.add(entry.endsOn);
    const counterpart = request.counterpartEntryId
      ? await lockEntry(actor.orgId, request.counterpartEntryId)
      : null;
    if (counterpart) {
      changedSubjects.add(counterpart.subjectId);
      changedDates.add(counterpart.startsOn);
      changedDates.add(counterpart.endsOn);
    }
    for (const [row, revision] of [
      [entry, request.entryRevision],
      ...(counterpart ? ([[counterpart, request.counterpartEntryRevision]] as const) : []),
    ] as const) {
      if (row.status !== "published" || row.revision !== revision) {
        throw new ScheduleError("The shift changed after the request was made.", {
          status: 409,
          code: "schedule_request_stale",
          remedy: "Decline this request; the employee can make a new one.",
        });
      }
      if (row.started)
        throw new ScheduleError("The shift has already started.", {
          code: "schedule_request_started",
          remedy: "Decline this request and change the booking on the board.",
        });
    }
  }
  const updated = await db.execute(
    sql`update schedule_entry_requests set status = ${decision === "approve" ? "approved" : "declined"},
    decided_by = ${mode === "flow" ? actor.actorId : null}, released_without_approval = ${mode === "released"}, decided_at = now(), decision_reason = ${reason},
    revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
    where org_id = ${actor.orgId} and id = ${request.id} and status = 'pending' and revision = ${request.revision} returning id`,
    "objects",
  );
  if (updated.length !== 1)
    throw new ScheduleError("This request changed while it was decided.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the requests.",
    });
  if (decision === "approve") {
    const entry = await lockEntry(actor.orgId, request.entryId);
    const before = await readEntry(actor.orgId, entry.id);
    await cancelPendingRevisions(actor, entry.id, reason);
    if (request.kind === "release") {
      await setStatus(actor, entry, "cancelled", reason);
      await recordPatternOmission(actor, entry, reason);
      if (board.notifyAssignees) notices.push(noticeFor(before, "removed"));
    } else if (request.kind === "change") {
      const booking = await exactStoredBooking(actor.orgId, entry);
      const span = {
        ...booking.span,
        spanMode: "timed" as const,
        startsAt: request.proposedStartsAt!,
        endsAt: request.proposedEndsAt!,
        breakMinutes: request.proposedBreakMinutes!,
        startsOn: localDate(request.proposedStartsAt!, entry.timeZone),
        endsOn: localDate(request.proposedEndsAt!, entry.timeZone),
      };
      changedDates.add(span.startsOn);
      changedDates.add(span.endsOn);
      await setStatus(actor, entry, "cancelled", reason);
      const successorId = crypto.randomUUID();
      await insertEntry({
        actor,
        board,
        id: successorId,
        booking: { ...booking, span },
        status: "published",
        supersedesId: entry.id,
        reason,
        requestHash: hash({ requestId: request.id, entryId: entry.id, span }),
        employmentId: entry.employmentId,
        requiredQualificationTypeIds: entry.requiredQualificationTypeIds,
        origin: {
          requestId: request.id,
          pattern: entry.patternAssignmentId
            ? {
                assignmentId: entry.patternAssignmentId,
                occursOn: entry.patternOccursOn!,
                slot: entry.patternSlot!,
                override: true,
              }
            : null,
        },
      });
      if (board.notifyAssignees)
        notices.push(noticeFor(await readEntry(actor.orgId, successorId), "changed"));
    } else {
      const counterpart = await lockEntry(actor.orgId, request.counterpartEntryId!);
      const counterpartBefore = await readEntry(actor.orgId, counterpart.id);
      await cancelPendingRevisions(actor, counterpart.id, reason);
      const mine = await exactStoredBooking(actor.orgId, entry),
        theirs = await exactStoredBooking(actor.orgId, counterpart);
      await setStatus(actor, entry, "cancelled", reason);
      await setStatus(actor, counterpart, "cancelled", reason);
      const toColleague = crypto.randomUUID(),
        toRequester = crypto.randomUUID();
      await insertEntry({
        actor,
        board,
        id: toColleague,
        booking: { ...mine, subject: theirs.subject },
        status: "published",
        supersedesId: entry.id,
        reason,
        requestHash: hash({
          requestId: request.id,
          entryId: entry.id,
          to: counterpart.workerPartyId,
        }),
        employmentId: counterpart.employmentId,
        requiredQualificationTypeIds: entry.requiredQualificationTypeIds,
        origin: { requestId: request.id },
      });
      await insertEntry({
        actor,
        board,
        id: toRequester,
        booking: { ...theirs, subject: mine.subject },
        status: "published",
        supersedesId: counterpart.id,
        reason,
        requestHash: hash({
          requestId: request.id,
          entryId: counterpart.id,
          to: entry.workerPartyId,
        }),
        employmentId: entry.employmentId,
        requiredQualificationTypeIds: counterpart.requiredQualificationTypeIds,
        origin: { requestId: request.id },
      });
      await recordPatternOmission(actor, entry, reason);
      await recordPatternOmission(actor, counterpart, reason);
      if (board.notifyAssignees) {
        notices.push(
          noticeFor(before, "removed"),
          noticeFor(counterpartBefore, "removed"),
          noticeFor(await readEntry(actor.orgId, toColleague), "booked"),
          noticeFor(await readEntry(actor.orgId, toRequester), "booked"),
        );
      }
    }
  }
  const distributionRefusals: { message: string; remedy: string }[] = [];
  if (decision === "approve" && changedDates.size > 0) {
    const dates = [...changedDates].sort();
    const refusal = await scheduleBoardLifecycle({
      actor,
      boardId: board.id,
      from: dates[0]!,
      through: dates.at(-1)!,
      subjectIds: [...changedSubjects].sort(),
      event: "on_update",
      occurrence: `${request.id}:${request.revision + 1}:${dates[0]}:${dates.at(-1)}`,
    });
    if (refusal) distributionRefusals.push(refusal);
  }
  return {
    request: await readRequest(actor.orgId, request.id),
    notices,
    boardName: board.name,
    distributionRefusals,
  };
}

function localDate(instant: string, timeZone: string): string {
  const fields = localTimeFields(instant, timeZone);
  if (!fields)
    throw new ScheduleError("The requested time is not valid in the shift's time zone.", {
      code: "schedule_invalid_time_zone",
      remedy: "Decline this request; the employee can make a new one.",
    });
  return fields.date;
}

/** Requests on a board, newest first; open requests by default. */
export function listBoardShiftRequests(
  actor: ScheduleActor & { boardId: string; status?: "open" | "all" },
): Promise<ShiftRequest[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, requireId(actor.boardId, "Board"));
    await requireBoardCapability(actor, board, "shift_requests");
    const allowed = await boardAuthority(actor, board, "read");
    return await db.execute<ShiftRequest>(
      sql`select ${REQUEST_COLUMNS} ${REQUEST_JOINS}
      where r.org_id = ${actor.orgId} and r.board_id = ${board.id} ${subsidiaryVisibleFilter(sql`r.subsidiary_id`, allowed)}
        ${actor.status === "all" ? sql`` : sql`and r.status in ('awaiting_counterpart', 'pending')`}
      order by r.created_at desc, r.id limit 500`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** The caller's own requests and the swaps colleagues asked them to take. */
export function listOwnShiftRequests(actor: ScheduleActor): Promise<ShiftRequest[]> {
  return withOrgTransaction(actor.orgId, async () => {
    if (
      !(await lockAndCheckOrgFeature(db, actor.orgId, "hrm")) ||
      !(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning"))
    )
      throw new ScopeNotFoundError();
    const party = (
      await db.execute<{ partyId: string | null }>(
        sql`select party_id as "partyId" from users where org_id = ${actor.orgId} and id = ${actor.actorId} and is_active`,
        "objects",
      )
    )[0]?.partyId;
    if (!party) return [];
    return await db.execute<ShiftRequest>(
      sql`select ${REQUEST_COLUMNS} ${REQUEST_JOINS}
      where r.org_id = ${actor.orgId} and (r.worker_party_id = ${party} or r.counterpart_party_id = ${party})
        and (r.status in ('awaiting_counterpart', 'pending') or r.updated_at > now() - interval '60 days')
      order by r.created_at desc, r.id limit 200`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export type SwapCandidate = {
  readonly entryId: string;
  readonly revision: number;
  readonly workerName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly targetLabel: string | null;
};

/** Colleagues' published future shifts on the same board within two weeks of the caller's shift. */
export function listSwapCandidates(
  actor: ScheduleActor & { entryId: string },
): Promise<SwapCandidate[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const party = await selfServiceParty(actor);
    const entry = (
      await db.execute<StoredEntry>(
        sql`select ${STORED_COLUMNS} from schedule_entries where org_id = ${actor.orgId} and id = ${requireId(actor.entryId, "Shift")}`,
        "objects",
      )
    )[0];
    if (!entry || entry.workerPartyId !== party || entry.status !== "published")
      throw new ScopeNotFoundError();
    return await db.execute<SwapCandidate>(
      sql`select e.id as "entryId", e.revision, p.display_name as "workerName",
        ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt", e.time_zone as "timeZone",
        coalesce(pr.name, cp.display_name, lo.name, sc.label) as "targetLabel"
      from schedule_entries e join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      left join projects pr on pr.org_id = e.org_id and pr.id = e.project_id
      left join parties cp on cp.org_id = e.org_id and cp.id = e.customer_party_id
      left join locations lo on lo.org_id = e.org_id and lo.id = e.location_id
      left join schedule_codes sc on sc.org_id = e.org_id and sc.id = e.schedule_code_id
      where e.org_id = ${actor.orgId} and e.board_id = ${entry.boardId} and e.status = 'published' and e.worker_party_id <> ${party}
        and e.closed_at is null and e.starts_at > now() and e.starts_on between ${entry.startsOn}::date - 14 and ${entry.startsOn}::date + 14
        and not exists (select 1 from schedule_entry_requests r where r.org_id = e.org_id and r.status in ('awaiting_counterpart', 'pending') and e.id in (r.entry_id, r.counterpart_entry_id))
      order by e.starts_at, p.display_name, e.id limit 200`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}
