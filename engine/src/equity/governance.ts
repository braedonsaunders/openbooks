import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { completedGateDecisionPolicy } from "../flows/approval-decision-policy.ts";
/**
 * Governed equity actions and their optional approval in Flows.
 *
 * Voids, reversals, repurchases, SAFE and note repayments and cancellations,
 * class amendments, splits, plan reserve changes, MFN elections and their
 * reversals, financing round amendments and voids, stock compensation and
 * note interest runs, and equity account policy versions are governed: each
 * is recorded as an action request (its kind, frozen command input and the
 * figures a Flow condition reads) and submitted to any enabled Equity action
 * Flow (`on_submit`).
 *
 *  - When no Flow raises an approval gate, the action applies at once in the
 *    same transaction and the request records that no approval applied. An
 *    organization that authors no Flow has no equity approvals at all.
 *  - When a Flow gates it, the action is validated in full against the
 *    current history (applied and rolled back inside a savepoint, so a
 *    refusal reaches the requester now rather than the approver later) and
 *    waits. The approved request applies on the requester's authority
 *    through the registered release handler, inside the gate decision's
 *    transaction; a rejection records its reason. The submitted gate policy
 *    determines whether the requester may decide.
 *  - A Flow that cannot route refuses the action by name; nothing is kept.
 *
 * Recording a governed action is the equity.manage duty, like any other
 * equity command. equity.approve is only the grant a Flow approver needs to
 * decide equity requests.
 */
import { sql } from "drizzle-orm";
import { cancelDispatchRuns, dispatchFailureReason } from "../flows/dispatch-result.ts";
import {
  EQUITY_ACTION_SUBJECT_KIND,
  equityActionDeepLink,
} from "../flows/equity-actions-adapter.ts";

import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { equityError, fig } from "./errors.ts";
import {
  assertEquityFeature,
  assertEquityReadable,
  loadLegalEntity,
  lockEquityEntity,
  requireEquityAuthority,
  requireEquityReader,
  writeEquityAudit,
} from "./internal.ts";

export const EQUITY_ACTIONS = [
  "void",
  "reverse",
  "repurchase",
  "repay",
  "cancel_convertible",
  "class_amendment",
  "split",
  "reserve_change",
  "mfn_election",
  "mfn_reversal",
  "compensation_run",
  "interest_run",
  "account_policy",
  "round_amendment",
  "round_void",
] as const;
export type EquityAction = (typeof EQUITY_ACTIONS)[number];

export type GovernedStatus = "applied" | "pending_approval";

export interface GovernedOutcome<T> {
  status: GovernedStatus;
  requestId: string;
  /** The applied command's result; null while the action awaits approval. */
  result: T | null;
  /** True when a retry with the same request key returned the request already recorded. */
  replayed: boolean;
}

export interface GovernedRequest {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  action: EquityAction;
  /** The security, class or plan the action concerns (null for runs and policy versions). */
  subjectId: string | null;
  subjectLabel: string;
  effectiveOn: string;
  reason: string | null;
  /** Figures a Flow condition reads: security kind, holder, class, quantity, amount, currency. */
  summary: Record<string, string | number | null>;
  /** The command input the release applies, as recorded. */
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
}

/** Thrown inside the validation savepoint so the trial application rolls back. */
class TrialApplication extends Error {
  readonly name = "TrialApplication";
}

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );

/**
 * Record a governed action and apply it now, or park it for its Flow's
 * decision. `apply` runs the command on behalf of the given actor; it is
 * the same function the release handler runs on approval.
 */
export async function governEquityAction<T>(
  request: GovernedRequest,
  apply: (actorId: string) => Promise<T>,
): Promise<GovernedOutcome<T>> {
  return withOrgTransaction(request.orgId, async () => {
    await assertEquityFeature(db, request.orgId);
    await loadLegalEntity(db, request.orgId, request.subsidiaryId);
    await requireEquityAuthority(
      db,
      request.orgId,
      request.actorId,
      request.subsidiaryId,
      "equity.manage",
    );
    await lockEquityEntity(db, request.orgId, request.subsidiaryId);
    if (request.idempotencyKey) {
      const existing = (
        await db.execute<{
          id: string;
          action: string;
          subject_id: string | null;
          payload: unknown;
          requested_by: string;
          status: string;
          result: T | null;
        }>(
          sql`
        select id, action, subject_id, payload, requested_by, status, result from equity_action_requests
         where org_id = ${request.orgId} and idempotency_key = ${request.idempotencyKey}`,
          "objects",
        )
      )[0];
      if (existing) {
        if (
          existing.action !== request.action ||
          existing.subject_id !== request.subjectId ||
          existing.requested_by !== request.actorId ||
          canonicalJson(existing.payload) !== canonicalJson(JSON.parse(json(request.payload)))
        ) {
          throw equityError("idempotencyConflict", {
            subject: fig.choice("action"),
          });
        }
        if (existing.status === "rejected") {
          throw equityError("actionRejected");
        }
        if (existing.status === "withdrawn") {
          throw equityError("actionWithdrawn");
        }
        return {
          status: existing.status as GovernedStatus,
          requestId: existing.id,
          result: existing.result,
          replayed: true,
        };
      }
    }
    {
      // One pending request per subject and action; a run or policy version
      // (no subject) is one per legal entity and date.
      const pending = (
        await db.execute<{ id: string }>(
          sql`
        select id from equity_action_requests
         where org_id = ${request.orgId} and action = ${request.action} and status = 'pending_approval'
           and ${
             request.subjectId
               ? sql`subject_id = ${request.subjectId}`
               : sql`subject_id is null and subsidiary_id = ${request.subsidiaryId} and effective_on = ${request.effectiveOn}::date`
           }
         limit 1`,
          "objects",
        )
      )[0];
      if (pending) {
        throw equityError("actionPending", {
          action: fig.choice(request.action),
          subject: fig.text(request.subjectLabel),
        });
      }
    }
    const id = (
      await db.execute<{ id: string }>(sql`select public.uuid_generate_v7() as id`, "objects")
    )[0]!.id;
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into equity_action_requests (id, org_id, subsidiary_id, action, subject_id, subject_label, effective_on, reason,
        payload, summary, status, requested_by, idempotency_key)
      values (${id}, ${request.orgId}, ${request.subsidiaryId}, ${request.action}, ${request.subjectId}, ${request.subjectLabel.slice(0, 200)},
        ${request.effectiveOn}::date, ${request.reason}, ${json(request.payload)}::jsonb, ${json(request.summary)}::jsonb,
        'pending_approval', ${request.actorId}, ${request.idempotencyKey})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1) throw equityError("notSaved", { record: fig.choice("request") });
    const dispatch = (
      await routeSubjectSubmission({
        orgId: request.orgId,
        actorId: request.actorId,
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        subjectId: id,
        source: "ui",
      })
    ).dispatch;
    if (dispatch.failed) {
      await cancelDispatchRuns(
        request.orgId,
        dispatch.runs.map((run) => run.runId),
        { actorId: request.actorId },
      );
      throw equityError("actionRoutingFailed", {
        reason: fig.text(dispatchFailureReason(dispatch) ?? ""),
      });
    }
    if (dispatch.gatesCreated > 0) {
      try {
        await withTransactionSavepoint(db, async () => {
          await apply(request.actorId);
          throw new TrialApplication("trial application");
        });
      } catch (error) {
        if (!(error instanceof TrialApplication)) throw error;
      }
      await writeEquityAudit(db, {
        orgId: request.orgId,
        table: "equity_action_requests",
        rowId: id,
        action: "equity.action.submitted",
        actorId: request.actorId,
        changes: {
          action: request.action,
          subjectId: request.subjectId,
          effectiveOn: request.effectiveOn,
          reason: request.reason,
          approval: "flow",
          flowRuns: dispatch.runs.filter((run) => run.gatesCreated > 0).map((run) => run.runId),
        },
      });
      return {
        status: "pending_approval",
        requestId: id,
        result: null,
        replayed: false,
      };
    }
    const result = await apply(request.actorId);
    await completeRequest(request.orgId, id, {
      result,
      decidedBy: null,
      releasedWithoutApproval: true,
    });
    await writeEquityAudit(db, {
      orgId: request.orgId,
      table: "equity_action_requests",
      rowId: id,
      action: "equity.action.applied",
      actorId: request.actorId,
      changes: {
        action: request.action,
        subjectId: request.subjectId,
        effectiveOn: request.effectiveOn,
        reason: request.reason,
        approval: "not_required",
      },
    });
    return { status: "applied", requestId: id, result, replayed: false };
  });
}

async function completeRequest(
  orgId: string,
  id: string,
  input: {
    result: unknown;
    decidedBy: string | null;
    releasedWithoutApproval: boolean;
  },
): Promise<void> {
  const updated = await db.execute<{ id: string }>(
    sql`
    update equity_action_requests
       set status = 'applied', result = ${json(input.result ?? {})}::jsonb, applied_at = now(),
           released_without_approval = ${input.releasedWithoutApproval},
           decided_by = ${input.decidedBy}, decided_at = ${input.decidedBy ? sql`now()` : null}
     where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
    returning id`,
    "objects",
  );
  if (updated.length !== 1) throw equityError("actionChangedWhileApplied");
}

export interface PendingRequest {
  id: string;
  action: EquityAction;
  subjectId: string | null;
  subjectLabel: string;
  effectiveOn: string;
  reason: string | null;
  requestedBy: string;
  requestedByName: string | null;
  createdAt: string;
}

/** Actions of a legal entity awaiting a Flow decision, latest first (equity.read). */
export async function pendingEquityActions(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
}): Promise<PendingRequest[]> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const rows = await db.execute<{
        id: string;
        action: EquityAction;
        subject_id: string | null;
        subject_label: string;
        effective_on: string;
        reason: string | null;
        requested_by: string;
        requested_by_name: string | null;
        created_at: string;
      }>(
        sql`
      select r.id, r.action, r.subject_id, r.subject_label, r.effective_on::text as effective_on, r.reason, r.requested_by,
             u.name as requested_by_name, r.created_at::text as created_at
        from equity_action_requests r
        left join users u on u.org_id = r.org_id and u.id = r.requested_by
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId} and r.status = 'pending_approval'
       order by r.created_at desc`,
        "objects",
      );
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        subjectId: row.subject_id,
        subjectLabel: row.subject_label,
        effectiveOn: row.effective_on,
        reason: row.reason,
        requestedBy: row.requested_by,
        requestedByName: row.requested_by_name,
        createdAt: row.created_at,
      }));
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}

/**
 * Where an action request lands in the equity workspace (equity.read and
 * reach to its legal entity); null when the request does not exist.
 */
export async function locateEquityAction(input: {
  orgId: string;
  actorId: string;
  requestId: string;
}): Promise<string | null> {
  if (!isUuid(input.requestId)) return null;
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      const row = (
        await db.execute<{
          action: string;
          subject_id: string | null;
          subsidiary_id: string;
          effective_on: string;
        }>(
          sql`
      select action, subject_id, subsidiary_id, effective_on::text as effective_on
        from equity_action_requests where org_id = ${input.orgId} and id = ${input.requestId}`,
          "objects",
        )
      )[0];
      if (!row) return null;
      await requireEquityReader(db, input.orgId, input.actorId, row.subsidiary_id);
      return equityActionDeepLink(row);
    },
    { readOnly: true },
  );
}

/** Bounds of the reason a requester gives for withdrawing a pending action. */
const WITHDRAW_REASON = { min: 5, max: 2000 } as const;

export interface WithdrawnEquityAction {
  requestId: string;
  status: "withdrawn";
  /** Flow runs (and their open gates) the withdrawal cancelled. */
  cancelledRunIds: string[];
}

/**
 * Withdraw a governed action awaiting its Flow decision. Only its requester
 * withdraws it, with a reason; nothing applies, the open approval runs and
 * gates are cancelled through the native cancellation, and the request
 * closes as withdrawn with the reason recorded and audited. Locks follow
 * the decision path's order (gates, then the request), so a concurrent
 * decision either completes first, and the withdrawal refuses as already
 * decided, or finds the gates cancelled.
 */
export async function withdrawEquityAction(input: {
  orgId: string;
  actorId: string;
  requestId: string;
  reason: string;
}): Promise<WithdrawnEquityAction> {
  const reason = input.reason.trim();
  if (reason.length < WITHDRAW_REASON.min || reason.length > WITHDRAW_REASON.max) {
    throw equityError("withdrawalReasonRequired", {
      min: fig.count(WITHDRAW_REASON.min),
      max: fig.count(WITHDRAW_REASON.max),
    });
  }
  if (!isUuid(input.requestId)) {
    throw equityError("actionUnknown");
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertEquityFeature(db, input.orgId);
    const gates = await db.execute<{ id: string; run_id: string }>(
      sql`
      select id, run_id::text as run_id from flow_gates
       where org_id = ${input.orgId} and subject_kind = ${EQUITY_ACTION_SUBJECT_KIND} and subject_id = ${input.requestId}
         and status in ('pending', 'escalated')
       order by id
       for update`,
      "objects",
    );
    const request = (
      await db.execute<{
        id: string;
        action: EquityAction;
        status: string;
        requested_by: string;
        subject_id: string | null;
        subsidiary_id: string;
        effective_on: string;
      }>(
        sql`
      select id, action, status, requested_by, subject_id, subsidiary_id, effective_on::text as effective_on
        from equity_action_requests where org_id = ${input.orgId} and id = ${input.requestId} for update`,
        "objects",
      )
    )[0];
    if (!request) throw equityError("actionUnknown");
    await requireEquityReader(db, input.orgId, input.actorId, request.subsidiary_id);
    if (request.requested_by !== input.actorId) {
      throw equityError("withdrawForbidden");
    }
    if (request.status !== "pending_approval") {
      throw equityError("actionDecidedNoWithdrawal", {
        status: fig.choice(request.status),
      });
    }
    const runs = (
      await db.execute<{ id: string }>(
        sql`
      select id::text as id from flow_runs
       where org_id = ${input.orgId} and subject_kind = ${EQUITY_ACTION_SUBJECT_KIND} and subject_id = ${input.requestId}
         and status in ('running', 'waiting')`,
        "objects",
      )
    ).map((row) => row.id);
    const cancelledRunIds = [...new Set([...runs, ...gates.map((gate) => gate.run_id)])].sort();
    await cancelDispatchRuns(input.orgId, cancelledRunIds, {
      actorId: input.actorId,
    });
    const updated = await db.execute<{ id: string }>(
      sql`
      update equity_action_requests
         set status = 'withdrawn', decided_by = ${input.actorId}, decided_at = now(), decision_comment = ${reason}
       where org_id = ${input.orgId} and id = ${request.id} and status = 'pending_approval'
      returning id`,
      "objects",
    );
    if (updated.length !== 1) throw equityError("actionChangedWhileWithdrawn");
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_action_requests",
      rowId: request.id,
      action: "equity.action.withdrawn",
      actorId: input.actorId,
      changes: {
        action: request.action,
        subjectId: request.subject_id,
        effectiveOn: request.effective_on,
        before: { status: "pending_approval" },
        after: { status: "withdrawn" },
        reason,
        cancelledRunIds,
      },
    });
    return {
      requestId: request.id,
      status: "withdrawn" as const,
      cancelledRunIds,
    };
  });
}

export type EquityActionApplier = (
  payload: Record<string, unknown>,
  actorId: string,
  orgId: string,
) => Promise<unknown>;

/**
 * Release a request's Flow decision. Runs inside decideGate's transaction:
 * a refusal (the action no longer applies, the requester lost the duty, a
 * self decision) rolls the gate decision back with it.
 */
export async function releaseEquityAction(
  args: {
    subjectId: string;
    outcome: "approved" | "rejected";
    comment?: string | null;
    approvalRunId?: string;
    ctx: { orgId: string; userId?: string | null };
  },
  appliers: Readonly<Record<EquityAction, EquityActionApplier>>,
): Promise<void> {
  const orgId = args.ctx.orgId;
  const deciderId = args.ctx.userId ?? null;
  if (!deciderId) throw equityError("approvalSignInRequired");
  await withOrgTransaction(orgId, async () => {
    const request = (
      await db.execute<{
        id: string;
        action: EquityAction;
        status: string;
        requested_by: string;
        payload: Record<string, unknown>;
        subject_id: string | null;
        subsidiary_id: string;
        effective_on: string;
      }>(
        sql`
      select id, action, status, requested_by, payload, subject_id, subsidiary_id, effective_on::text as effective_on
        from equity_action_requests where org_id = ${orgId} and id = ${args.subjectId} for update`,
        "objects",
      )
    )[0];
    if (!request) throw equityError("actionUnknown");
    if (request.status !== "pending_approval") {
      throw equityError("actionDecided", {
        status: fig.choice(request.status),
      });
    }
    const decision = await completedGateDecisionPolicy(db, {
      orgId,
      subjectKind: EQUITY_ACTION_SUBJECT_KIND,
      subjectId: request.id,
      approvalRunId: args.approvalRunId,
      actorId: deciderId,
      outcome: args.outcome,
    });
    if (!decision)
      throw equityError("actionRoutingFailed", {
        reason: fig.text("Complete the configured Flow gates before releasing this action."),
      });
    if (deciderId === request.requested_by && !decision.allowsSelfApproval)
      throw equityError("selfApproval");
    // Deciding an equity action is the equity.approve duty over the request's
    // legal entity, whoever the Flow's gate names.
    await requireEquityAuthority(db, orgId, deciderId, request.subsidiary_id, "equity.approve");
    if (args.outcome === "rejected") {
      const comment = args.comment?.trim() ?? "";
      if (!comment) throw equityError("rejectionReasonRequired");
      const updated = await db.execute<{ id: string }>(
        sql`
        update equity_action_requests set status = 'rejected', decided_by = ${deciderId}, decided_at = now(), decision_comment = ${comment.slice(0, 2000)}
         where org_id = ${orgId} and id = ${request.id} and status = 'pending_approval' returning id`,
        "objects",
      );
      if (updated.length !== 1) throw equityError("actionChangedWhileDecided");
      await writeEquityAudit(db, {
        orgId,
        table: "equity_action_requests",
        rowId: request.id,
        action: "equity.action.rejected",
        actorId: deciderId,
        changes: {
          action: request.action,
          subjectId: request.subject_id,
          before: { status: "pending_approval" },
          after: { status: "rejected" },
          reason: comment,
        },
      });
      return;
    }
    // The action applies as its requester recorded it, on the requester's live authority.
    const result = await appliers[request.action](request.payload, request.requested_by, orgId);
    await completeRequest(orgId, request.id, {
      result,
      decidedBy: deciderId,
      releasedWithoutApproval: false,
    });
    await writeEquityAudit(db, {
      orgId,
      table: "equity_action_requests",
      rowId: request.id,
      action: "equity.action.approved",
      actorId: deciderId,
      changes: {
        action: request.action,
        subjectId: request.subject_id,
        requestedBy: request.requested_by,
        before: { status: "pending_approval" },
        after: { status: "applied" },
        comment: args.comment ?? null,
      },
    });
  });
}
