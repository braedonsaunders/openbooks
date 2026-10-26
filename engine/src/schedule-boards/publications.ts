import {
  lockApprovalSubject,
  readNativeApprovalDecision,
  cancelNativeApprovals,
} from "../platform/approval-routing.ts";
/**
 * Native publication: publishing a booking board records a
 * publication of its unpublished changes and submits it to any enabled
 * Schedule publication Flow.
 *
 * Approval is optional and owned by Flows. When a Flow raises an approval
 * gate, the publication waits; the gate's decision applies it as the
 * deciding approver or declines it. When no Flow gates it, the submitter's
 * publication is applied at once and records that no approval applied.
 * While a publication waits, the changes it names cannot be edited, so the
 * approver decides exactly what was submitted.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  boardAuthority,
  getBoard,
  requireBoardCapability,
  type ScheduleActor,
  type ScheduleBoard,
} from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { hash, lockPublishableDrafts, publishDrafts, type ScheduleNotice } from "./entries.ts";
import { requireDate } from "./spans.ts";
import { deliverScheduleNotice } from "./distribution-hooks.ts";

export const SCHEDULE_PUBLICATION_SUBJECT_KIND = "schedule_publication";

export const NO_APPROVAL_APPLIED = "No approval Flow applied; released when submitted.";

type RoutingResult = {
  gated: boolean;
  runId: string | null;
  failed: boolean;
  error: string | null;
};
type Router = (actor: ScheduleActor, publicationId: string) => Promise<RoutingResult>;
const runtime = globalThis as typeof globalThis & {
  __schedulePublicationRouter?: Router;
};

/** The composition root routes submitted publications through optional Flows. */
export function registerSchedulePublicationRouting(router: Router): void {
  runtime.__schedulePublicationRouter = router;
}

function route(actor: ScheduleActor, publicationId: string): Promise<RoutingResult> {
  if (!runtime.__schedulePublicationRouter) {
    throw new Error(
      "Schedule publication routing is not installed in this process. Install the native engine composition before publishing.",
    );
  }
  return runtime.__schedulePublicationRouter(actor, publicationId);
}

export type SchedulePublication = {
  readonly id: string;
  readonly boardId: string;
  readonly fromDate: string;
  readonly throughDate: string;
  readonly entryIds: readonly string[];
  readonly entryRevisions: readonly number[];
  readonly status: "pending" | "approved" | "declined" | "withdrawn";
  readonly flowRunId: string | null;
  readonly releasedWithoutApproval: boolean;
  readonly decisionReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revision: number;
};

const PUBLICATION_COLUMNS = sql`id, board_id as "boardId", from_date::text as "fromDate", through_date::text as "throughDate",
  entry_ids::text[] as "entryIds", entry_revisions as "entryRevisions", status, flow_run_id as "flowRunId",
  released_without_approval as "releasedWithoutApproval", decision_reason as "decisionReason", created_by as "createdBy",
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt", revision`;

export type PublicationOutcome = {
  readonly published: number;
  readonly pending: boolean;
  readonly publicationId: string | null;
  readonly notices: ScheduleNotice[];
  readonly boardName: string;
  readonly distributionRefusals: { message: string; remedy: string }[];
};

/**
 * Publish exactly the submitted drafts through tenant Flows, independent of
 * whether the board submits changes automatically or as a staged batch.
 */
export async function publishScheduleBoard(
  actor: ScheduleActor & {
    boardId: string;
    from: string;
    through: string;
    reason?: string | null;
    /** Server-selected drafts for automatic publication of a live-board change. */
    entryIds?: readonly string[];
  },
): Promise<PublicationOutcome> {
  const board = await withOrgTransaction(actor.orgId, () => getBoard(actor, actor.boardId));
  const from = requireDate(actor.from, "Publish from"),
    through = requireDate(actor.through, "Publish through");
  if (through < from)
    throw new ScheduleError("The range ends before it starts.", {
      code: "schedule_invalid_range",
    });
  const reason = actor.reason?.trim() || `Published ${board.name}`;
  return withOrgTransaction(actor.orgId, async () => {
    const current = await getBoard(actor, board.id);
    await requireBoardCapability(actor, current, "bookings");
    await boardAuthority(actor, current, "manage");
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-publish:${actor.orgId}:${current.id}`}, 0))`,
    );
    const waiting = (
      await db.execute<{
        id: string;
        entry_ids: string[];
        created_by: string;
        from_date: string;
        through_date: string;
        has_receipt: boolean;
      }>(
        sql`select p.id,p.entry_ids,p.created_by,p.from_date::text,p.through_date::text,
          exists(select 1 from flow_submissions s where s.org_id=p.org_id and s.subject_kind='schedule_publication' and s.subject_id=p.id) as has_receipt
          from schedule_publications p where p.org_id=${actor.orgId} and p.board_id=${current.id} and p.status='pending'`,
        "objects",
      )
    )[0];
    if (waiting) {
      const sameSubmission =
        waiting.created_by === actor.actorId &&
        waiting.has_receipt &&
        (actor.entryIds
          ? actor.entryIds.length > 0 &&
            actor.entryIds.every((id) => waiting.entry_ids.includes(id))
          : waiting.from_date === from && waiting.through_date === through);
      if (sameSubmission)
        return {
          published: 0,
          pending: true,
          publicationId: waiting.id,
          notices: [],
          boardName: current.name,
          distributionRefusals: [],
        };
      throw new ScheduleError("A publication of this board is awaiting its approval.", {
        status: 409,
        code: "schedule_publication_pending",
        remedy:
          "Wait for the decision in Approvals; the board can be published again once it is decided.",
      });
    }
    const drafts = await lockPublishableDrafts(
      actor,
      current,
      actor.entryIds ? { ids: actor.entryIds } : { from, through },
    );
    if (
      actor.entryIds &&
      (new Set(actor.entryIds).size !== actor.entryIds.length ||
        drafts.length !== actor.entryIds.length)
    )
      throw new ScheduleError(
        "The selected publication changes are unavailable. Reload the board before resubmitting.",
        { status: 409, code: "schedule_publication_stale" },
      );
    if (drafts.length === 0)
      throw new ScheduleError("There are no unpublished changes in these dates.", {
        code: "schedule_nothing_to_publish",
      });
    const id = crypto.randomUUID();
    const inserted = await db.execute(
      sql`insert into schedule_publications (id, org_id, board_id, subsidiary_id, from_date, through_date, entry_ids, entry_revisions,
      reason, request_hash, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${current.id}, ${current.subsidiaryId}, ${from}, ${through}, ${`{${drafts.map((draft) => draft.id).join(",")}}`}::uuid[],
      ${`{${drafts.map((draft) => draft.revision).join(",")}}`}::integer[], ${reason},
      ${hash({ boardId: current.id, from, through, drafts: drafts.map((draft) => [draft.id, draft.revision]) })}, ${actor.actorId}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new ScheduleError("The publication was not recorded.", {
        code: "schedule_not_saved",
        remedy: "Reload the board and publish again.",
      });
    const routed = await route(actor, id);
    if (routed.failed) {
      throw new ScheduleError("The schedule publication approval Flow could not start.", {
        code: "schedule_publication_flow_failed",
        remedy: routed.error
          ? `Ask an administrator to review the Schedule publication Flow: ${routed.error}`
          : "Ask an administrator to review the Schedule publication Flow.",
      });
    }
    if (routed.gated) {
      const updated = await db.execute(
        sql`update schedule_publications set flow_run_id = ${routed.runId}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = ${id} and status = 'pending' returning id`,
        "objects",
      );
      if (updated.length !== 1)
        throw new ScheduleError("The publication changed while it was routed for approval.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the board.",
        });
      return {
        published: 0,
        pending: true,
        publicationId: id,
        notices: [],
        boardName: current.name,
        distributionRefusals: [],
      };
    }
    const result = await applyPublication(actor, current, id, "released", NO_APPROVAL_APPLIED);
    return {
      ...result,
      pending: false,
      publicationId: id,
      boardName: current.name,
    };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

async function lockPublication(orgId: string, id: string): Promise<SchedulePublication> {
  if (!isUuid(id)) throw new ScopeNotFoundError();
  const row = (
    await db.execute<SchedulePublication>(
      sql`select ${PUBLICATION_COLUMNS} from schedule_publications where org_id = ${orgId} and id = ${id} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

/** Apply an approved publication: the decision first, then exactly the submitted drafts. */
async function applyPublication(
  actor: ScheduleActor,
  board: ScheduleBoard,
  id: string,
  mode: "flow" | "released",
  decisionReason: string,
) {
  const publication = await lockPublication(actor.orgId, id);
  if (publication.status !== "pending")
    throw new ScheduleError("This publication was already decided.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board.",
    });
  const updated = await db.execute(
    mode === "released"
      ? sql`update schedule_publications set status = 'approved', released_without_approval = true, decided_at = now(), decision_reason = ${decisionReason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId} where org_id = ${actor.orgId} and id = ${id} and revision = ${publication.revision} returning id`
      : sql`update schedule_publications set status = 'approved', decided_by = ${actor.actorId}, decided_at = now(), decision_reason = ${decisionReason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId} where org_id = ${actor.orgId} and id = ${id} and revision = ${publication.revision} returning id`,
    "objects",
  );
  if (updated.length !== 1)
    throw new ScheduleError("The publication changed while it was decided.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board.",
    });
  const drafts = await lockPublishableDrafts(actor, board, {
    ids: publication.entryIds,
  });
  const submitted = new Map(
    publication.entryIds.map((entryId, index) => [entryId, publication.entryRevisions[index]]),
  );
  if (
    drafts.length !== publication.entryIds.length ||
    drafts.some((draft) => submitted.get(draft.id) !== draft.revision)
  ) {
    throw new ScheduleError(
      "The board's changes are no longer the ones submitted for publication.",
      {
        status: 409,
        code: "schedule_publication_stale",
        remedy: "Decline this publication and publish the board again.",
      },
    );
  }
  return publishDrafts(actor, board, drafts, `Published ${board.name}`, {
    from: publication.fromDate,
    through: publication.throughDate,
  });
}

/** A Flow's approval gates resolved: publish or decline as the gate's decider. */
export async function releasePublicationApproval(input: {
  orgId: string;
  actorId: string;
  publicationId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
}): Promise<void> {
  const actor = { orgId: input.orgId, actorId: input.actorId };
  await withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, SCHEDULE_PUBLICATION_SUBJECT_KIND, input.publicationId);
    const proof = await readNativeApprovalDecision({
      orgId: input.orgId,
      actorId: input.actorId,
      subjectKind: SCHEDULE_PUBLICATION_SUBJECT_KIND,
      subjectId: input.publicationId,
      outcome: input.outcome,
      approvalRunId: input.approvalRunId,
    });
    if (!proof)
      throw new ScheduleError(
        "Complete the configured publication Flow gates before releasing this schedule.",
      );
    const publication = await lockPublication(actor.orgId, input.publicationId);
    if (publication.status !== "pending") {
      throw new ScheduleError("The publication no longer awaits a decision.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Review the board in Scheduling.",
      });
    }
    const board = await getBoard(actor, publication.boardId);
    await boardAuthority(actor, board, "publish");
    if (input.outcome === "approved") {
      const result = await applyPublication(
        actor,
        board,
        publication.id,
        "flow",
        input.comment?.trim() || "Approved through the schedule publication Flow",
      );
      await deliverScheduleNotice({
        orgId: actor.orgId,
        actorId: actor.actorId,
        boardName: board.name,
        notices: result.notices,
      });
      return;
    }
    const declined = await db.execute(
      sql`update schedule_publications set status = 'declined', decided_by = ${actor.actorId}, decided_at = now(),
    decision_reason = ${input.comment?.trim() || "Declined through the schedule publication Flow"}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
    where org_id = ${actor.orgId} and id = ${publication.id} and revision = ${publication.revision} returning id`,
      "objects",
    );
    if (declined.length !== 1)
      throw new ScheduleError("The publication changed while it was decided.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Review the board in Scheduling.",
      });
  });
}

/** The submitter recalls an unapplied publication and cancels its pending Flow work. */
export async function withdrawPublication(
  actor: ScheduleActor & { publicationId: string; expectedRevision: number },
): Promise<void> {
  await withOrgTransaction(actor.orgId, async () => {
    await lockApprovalSubject(actor.orgId, SCHEDULE_PUBLICATION_SUBJECT_KIND, actor.publicationId);
    const publication = await lockPublication(actor.orgId, actor.publicationId);
    const board = await getBoard(actor, publication.boardId);
    await boardAuthority(actor, board, "publish");
    if (publication.createdBy !== actor.actorId) throw new ScopeNotFoundError();
    if (publication.status !== "pending" || publication.revision !== actor.expectedRevision) {
      throw new ScheduleError("This publication was already decided.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
    }
    await cancelNativeApprovals({
      orgId: actor.orgId,
      actorId: actor.actorId,
      subjectKind: SCHEDULE_PUBLICATION_SUBJECT_KIND,
      subjectId: publication.id,
    });
    const updated = await db.execute(
      sql`update schedule_publications set status = 'withdrawn', revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${publication.id} and revision = ${publication.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("This publication changed while it was withdrawn.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** The board's publication awaiting a decision, if any. */
export async function pendingPublication(
  orgId: string,
  boardId: string,
): Promise<SchedulePublication | null> {
  return (
    (
      await db.execute<SchedulePublication>(
        sql`select ${PUBLICATION_COLUMNS} from schedule_publications
    where org_id = ${orgId} and board_id = ${boardId} and status = 'pending'`,
        "objects",
      )
    )[0] ?? null
  );
}
