import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { cancelDispatchRuns } from "../flows/dispatch-result.ts";
import { routeSubjectSubmission, type SubmissionPolicy } from "../flows/submission-policy.ts";
import { completedGateDecisionPolicy } from "../flows/approval-decision-policy.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  CloseError,
  CLOSE_MODULES,
  periodLockRequiresApprovedReopen,
  type CloseModule,
} from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";

import { reversePeriodEndJournalsForReopen } from "./period-end-journals.ts";
import { upsertLock, periodScopeAdvisoryLock } from "../periods/period-locks.ts";
import {
  CloseReopenRequestRow,
  ReopenApprovalConflict,
  controlledReopenHours,
  describeActiveReopenOverlap,
  endFullyClosedReopenRequests,
  lockReopenRequestScope,
  reopenApprovalConflicts,
} from "./reopen-approvals.ts";

type ReopenDecisionRecord = {
  status: "approved" | "rejected";
  periodId: string;
  bookId: string;
  subsidiaryId: string | null;
  modules: CloseModule[];
  reason: string;
  requestedBy: string;
  conflicts: ReopenApprovalConflict[];
  decisionReason: string | null;
  expiresAt: string | null;
};

export async function submitPeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  hours?: number;
}): Promise<{ gated: boolean }> {
  return withOrgTransaction(args.orgId, async () => {
    await lockApprovalSubject(args.orgId, "close_reopen_request", args.requestId);
    await lockReopenRequestScope(db, args.orgId, args.requestId);
    const row = (
      await db.execute<
        CloseReopenRequestRow & {
          status: string;
          submission_policy: SubmissionPolicy | null;
        }
      >(
        sql`
      select * from close_reopen_requests where org_id=${args.orgId} and id=${args.requestId} for update
    `,
        "objects",
      )
    )[0];
    if (!row) throw new CloseError("Reopen request not found.");
    await lockActorCommandAuthority(
      db,
      args.orgId,
      args.actorId,
      row.subsidiary_id,
      "close.reopen",
    );
    if (row.requested_by !== args.actorId)
      throw new CloseError(
        "Only the requester can submit the reopen; reviewers decide its assigned Flow gates.",
      );
    if (row.status !== "requested")
      throw new CloseError("Only a pending reopen request can be submitted.");
    let policy = row.submission_policy;
    let hours: number;
    let maxHours: number;
    if (!policy) {
      const window = await controlledReopenHours(db, args.orgId);
      hours = args.hours ?? window.defaultHours;
      maxHours = window.maxHours;
      if (!Number.isInteger(hours) || hours < 1 || hours > window.maxHours)
        throw new CloseError(
          `Choose a reopen window between 1 and ${window.maxHours} whole hours.`,
        );
      ({ policy } = await routeSubjectSubmission({
        orgId: args.orgId,
        subjectKind: "close_reopen_request",
        subjectId: args.requestId,
        actorId: args.actorId,
        command: { hours, maxHours },
      }));
      const saved = await db.execute(
        sql`update close_reopen_requests set submission_policy=${JSON.stringify(policy)}::jsonb,
        updated_at=now(),updated_by=${args.actorId} where org_id=${args.orgId} and id=${args.requestId}
        and status='requested' and submission_policy is null returning id`,
        "objects",
      );
      if (saved.length !== 1)
        throw new CloseError("The reopen changed during submission; reload it.");
    } else {
      const receipt = (
        await db.execute<{ hours: number; max_hours: number }>(
          sql`select (context->'command'->>'hours')::integer as hours,(context->'command'->>'maxHours')::integer as max_hours from flow_submissions where org_id=${args.orgId} and subject_kind='close_reopen_request' and subject_id=${args.requestId} order by created_at desc,id desc limit 1`,
          "objects",
        )
      )[0];
      if (
        !receipt ||
        !Number.isInteger(receipt.hours) ||
        receipt.hours < 1 ||
        !Number.isInteger(receipt.max_hours) ||
        receipt.max_hours < receipt.hours
      )
        throw new CloseError(
          "This reopen has no frozen access window. Withdraw it and submit a new request.",
        );
      hours = receipt.hours;
      maxHours = receipt.max_hours;
      if (args.hours !== undefined && args.hours !== hours)
        throw new CloseError(
          "The submitted access window is frozen. Withdraw and resubmit to change its duration.",
        );
    }
    if (policy.kind === "gated") return { gated: true };
    await applyPeriodReopenDecision({
      ...args,
      hours,
      maxHours,
      approve: true,
      routing: "ungated",
    });
    return { gated: false };
  });
}

export async function finalizePeriodReopenApproval(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
}): Promise<void> {
  await withOrgTransaction(args.orgId, async () => {
    await lockApprovalSubject(args.orgId, "close_reopen_request", args.requestId);
    await lockReopenRequestScope(db, args.orgId, args.requestId);
    const proof = await completedGateDecisionPolicy(db, {
      orgId: args.orgId,
      subjectKind: "close_reopen_request",
      subjectId: args.requestId,
      approvalRunId: args.approvalRunId,
      actorId: args.actorId,
      outcome: args.outcome,
    });
    if (!proof)
      throw new CloseError("Complete the configured Flow gates before releasing this reopen.");
    const row = (
      await db.execute<{
        requested_by: string;
      }>(
        sql`select requested_by from close_reopen_requests
      where org_id=${args.orgId} and id=${args.requestId} for update`,
        "objects",
      )
    )[0];
    if (!row || (row.requested_by === args.actorId && !proof.allowsSelfApproval))
      throw new CloseError("The submitted Flow gate does not permit this self decision.");
    const context = proof.context as {
      command?: { hours?: unknown; maxHours?: unknown };
    } | null;
    const hours = context?.command?.hours;
    const maxHours = context?.command?.maxHours;
    if (
      typeof hours !== "number" ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      typeof maxHours !== "number" ||
      !Number.isInteger(maxHours) ||
      maxHours < hours
    )
      throw new CloseError(
        "This reopen submission has no valid frozen access window. Withdraw and submit it again.",
      );
    await applyPeriodReopenDecision({
      ...args,
      hours,
      maxHours,
      approve: args.outcome === "approved",
      decisionReason: args.comment ?? undefined,
      routing: "gated",
    });
  });
}

async function applyPeriodReopenDecision(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  approve: boolean;
  hours: number;
  maxHours: number;
  routing: "ungated" | "gated";
  /**
   * Required when rejecting (approve false): a 10-500 character reason an
   * approver records in the decision audit and the close history. Ignored
   * when approving.
   */
  decisionReason?: string;
}): Promise<void> {
  const decisionReason = (args.decisionReason ?? "").trim();
  if (!args.approve && (decisionReason.length < 10 || decisionReason.length > 500)) {
    throw new CloseError("Rejecting a reopen request requires a 10-500 character reason");
  }
  let conflicts: ReopenApprovalConflict[] = [];
  // Decision state and its audit evidence commit in the same transaction.
  let decided = null as ReopenDecisionRecord | null;
  const recordDecision = async (tx: SqlExecutor) => {
    if (decided) {
      const scope = {
        periodId: decided.periodId,
        bookId: decided.bookId,
        subsidiaryId: decided.subsidiaryId,
        modules: decided.modules,
      };
      const action =
        decided.status === "rejected"
          ? "reject"
          : args.routing === "ungated"
            ? "release"
            : "approve";
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, ${action},
                ${JSON.stringify({
                  before: { status: "requested" },
                  after: {
                    status: decided.status,
                    routing: args.routing,
                    expiresAt: decided.expiresAt,
                    reason: decided.reason,
                    ...(decided.decisionReason != null
                      ? { decisionReason: decided.decisionReason }
                      : {}),
                    conflicts: decided.conflicts,
                  },
                  scope,
                  requestedBy: decided.requestedBy,
                })}::jsonb, ${args.actorId})`);
      await tx.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${args.orgId}, 'period.reopen_decision', ${args.actorId},
                ${JSON.stringify({
                  requestId: args.requestId,
                  decision: decided.status,
                  routing: args.routing,
                  expiresAt: decided.expiresAt,
                  reason: decided.reason,
                  ...(decided.decisionReason != null
                    ? { decisionReason: decided.decisionReason }
                    : {}),
                  scope,
                  requestedBy: decided.requestedBy,
                  conflicts: decided.conflicts,
                })}::jsonb)`);
    }
  };
  const decide = async () =>
    withOrgTransaction(args.orgId, async () => {
      const tx = db;
      await lockReopenRequestScope(tx, args.orgId, args.requestId);
      const request = await tx.execute<CloseReopenRequestRow>(
        sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`,
        "objects",
      );
      const row = request[0];
      if (!row) throw new CloseError("pending reopen request not found");
      if (args.approve) {
        conflicts = await reopenApprovalConflicts(tx, args.orgId, row, args.actorId);
      }
      await lockActorCommandAuthority(
        tx,
        args.orgId,
        args.actorId,
        row.subsidiary_id,
        "close.reopen",
      );
      if (!args.approve) {
        const updated = await tx.execute(
          sql`
        update close_reopen_requests set status = 'rejected', approved_by = ${args.actorId},
               approved_at = now(), updated_at = now(), updated_by = ${args.actorId}
         where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
        returning id`,
          "objects",
        );
        if (updated.length !== 1)
          throw new CloseError("pending reopen request changed during decision");
        decided = {
          status: "rejected",
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryId: row.subsidiary_id,
          modules: row.modules,
          reason: row.reason,
          requestedBy: row.requested_by,
          conflicts: [],
          decisionReason,
          expiresAt: null,
        };
        await recordDecision(tx);
        return;
      }
      await periodScopeAdvisoryLock(tx, args.orgId, row.period_id, row.book_id);
      const { hours, maxHours } = args;
      if (!Number.isInteger(hours) || hours === undefined || hours < 1)
        throw new CloseError(
          "The submitted reopen has no valid frozen access window. Withdraw and submit it again.",
        );
      let expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      const modules = row.modules;
      if (modules.length === 0 || modules.some((module) => !CLOSE_MODULES.includes(module)))
        throw new CloseError("reopen request contains an invalid module");
      await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`close-reopen:${args.orgId}:${row.period_id}:${row.book_id}:${row.subsidiary_id ?? "all"}`},
          0
        )
      )
    `);
      const activeRequests = await tx.execute<{
        id: string;
        modules: CloseModule[];
        subsidiary_id: string | null;
        expires_at: Date | string;
      }>(
        sql`
      select id, modules, subsidiary_id, expires_at
        from close_reopen_requests
       where org_id = ${args.orgId}
         and period_id = ${row.period_id}
         and book_id = ${row.book_id}
         and (subsidiary_id is null or ${row.subsidiary_id}::uuid is null
           or subsidiary_id = ${row.subsidiary_id}::uuid)
         and id <> ${args.requestId}
         and status = 'approved'
         and expires_at > now()
       for update`,
        "objects",
      );
      // A request whose modules were all re-closed outside the re-close
      // workflow (a Setup lock, never consumed) no longer guards live work:
      // end it here, audited, so it cannot block this decision.
      const consumed = await endFullyClosedReopenRequests(tx, {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        actorId: args.actorId,
        reason: "superseded by a newer reopen decision",
        candidateIds: activeRequests.map((request) => request.id),
      });
      const consumedIds = new Set(consumed);
      const live = activeRequests.filter((request) => !consumedIds.has(request.id));
      // A request covering every module of an approved window widens or
      // extends it: approving it supersedes that window, recorded as such.
      const superseded = live.filter(
        (request) =>
          request.subsidiary_id === row.subsidiary_id &&
          request.modules.every((module) => modules.includes(module)),
      );
      const amendment = row.impact_snapshot?.amendment;
      if (amendment) {
        const source = superseded.find((request) => request.id === amendment.requestId);
        if (!source || new Date(source.expires_at).toISOString() !== amendment.sourceExpiresAt) {
          throw new CloseError(
            "the original reopen window has ended or changed; withdraw this request and raise a new request for the current closed scope",
          );
        }
        expiresAt = new Date(amendment.expiresAt);
        const approvedAt = new Date(amendment.approvedAt);
        if (
          !Number.isFinite(expiresAt.getTime()) ||
          !Number.isFinite(approvedAt.getTime()) ||
          expiresAt.getTime() <= Date.now()
        ) {
          throw new CloseError(
            "the requested reopen window has expired; withdraw this request and raise a new request",
          );
        }
        if (
          amendment.additionalHours > 0 &&
          expiresAt.getTime() > approvedAt.getTime() + maxHours * 60 * 60 * 1000
        ) {
          throw new CloseError(
            "the requested extension exceeds the controlled reopen policy maximum; withdraw this request and request fewer additional hours",
          );
        }
      }
      const inheritedModules = new Set(superseded.flatMap((request) => request.modules));
      const supersededIds = new Set(superseded.map((request) => request.id));
      const overlap = live.find(
        (request) =>
          !supersededIds.has(request.id) &&
          request.modules.some((module) => modules.includes(module)),
      );
      if (overlap) {
        throw new CloseError(await describeActiveReopenOverlap(tx, args.orgId, overlap.id));
      }
      if (!amendment && superseded.length > 0) {
        expiresAt = new Date(
          Math.max(
            expiresAt.getTime(),
            ...superseded.map((request) => new Date(request.expires_at).getTime()),
          ),
        );
      }
      if (modules.some((module) => module !== "gl") && !modules.includes("gl")) {
        const gl = await tx.execute<{ state: string; reopen_expires_at: Date | null }>(
          sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id}
           and (subsidiary_id = ${row.subsidiary_id}::uuid or subsidiary_id is null)
           and module = 'gl'
         order by (subsidiary_id is not null) desc limit 1`,
          "objects",
        );
        const governing = gl[0];
        if (
          periodLockRequiresApprovedReopen(
            governing && {
              state: governing.state,
              reopenExpiresAt: governing.reopen_expires_at,
              reason: null,
            },
          )
        ) {
          throw new CloseError("GL must be included before a closed subledger can be reopened");
        }
      }
      // New modules must require a controlled reopening. Modules already in
      // the superseded window retain their independently approved scope.
      // A window on a scope that is not hard-closed is a pure time bomb:
      // the lock row it writes (state 'open' plus an expiry) blocks posting
      // once stale, and the automatic re-close then flips the period to
      // 'closed'. Soft-close fences posting but unlocks from Setup; treating
      // it as reopenable would escalate a management lock into a statutory
      // close. Every requested module must currently require an approved
      // reopen — exact row, else the org-wide row — so a padded request is
      // refused and the operator narrows it to the hard-closed modules.
      const openModules: CloseModule[] = [];
      for (const module of modules) {
        if (inheritedModules.has(module)) continue;
        const governing = await tx.execute<{ state: string; reopen_expires_at: Date | null }>(
          sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id} and module = ${module}
           and (subsidiary_id is not distinct from ${row.subsidiary_id}::uuid or subsidiary_id is null)
         order by (subsidiary_id is not null) desc limit 1`,
          "objects",
        );
        const lock = governing[0];
        if (
          !periodLockRequiresApprovedReopen(
            lock && {
              state: lock.state,
              reopenExpiresAt: lock.reopen_expires_at,
              reason: null,
            },
          )
        ) {
          openModules.push(module);
        }
      }
      if (openModules.length > 0) {
        throw new CloseError(
          `cannot reopen ${openModules.join(", ")}: no closed lock in the requested scope — nothing to reopen; narrow the request to the closed modules`,
        );
      }
      for (const window of superseded) {
        const updated = await tx.execute(
          sql`
        update close_reopen_requests
           set status = 'superseded', updated_at = now(), updated_by = ${args.actorId}
         where id = ${window.id} and org_id = ${args.orgId} and status = 'approved'
        returning id`,
          "objects",
        );
        if (updated.length !== 1)
          throw new CloseError("approved reopen window changed during decision");
        const evidence = {
          requestId: window.id,
          supersededBy: args.requestId,
          modules: window.modules,
          reason: row.reason,
        };
        await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${args.orgId}, 'close_reopen_requests', ${window.id}, 'supersede',
          ${JSON.stringify({ before: { status: "approved" }, after: { status: "superseded" }, ...evidence })}::jsonb, ${args.actorId})`);
        await tx.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${args.orgId}, 'period.reopen_superseded', ${args.actorId}, ${JSON.stringify(evidence)}::jsonb)`);
      }
      for (const module of modules) {
        await upsertLock({
          tx,
          orgId: args.orgId,
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryId: row.subsidiary_id ?? undefined,
          module,
          state: "open",
          actorId: args.actorId,
          reason: row.reason,
          reopenExpiresAt: expiresAt,
        });
      }
      if (row.subsidiary_id == null) {
        // A scope-wide reopen must dominate every narrower lock, the mirror of
        // the scope-wide close tightening in setPeriodLockState: storage
        // prefers the exact subsidiary row, so a closed child would silently
        // survive the window (and the operator would believe the scope open
        // while its entities stay fenced). Relax each currently-blocking child
        // into this same window, mirrored into the audit trail. Non-blocking
        // children with no controlled window remain unchanged; child windows
        // inherited from a superseded org-wide request receive the new expiry.
        for (const module of modules) {
          const inheritedExpiries = superseded
            .filter((request) => request.modules.includes(module))
            .map((request) => new Date(request.expires_at).toISOString());
          const inheritedWindow = inheritedExpiries.length
            ? sql`reopen_expires_at in (${sql.join(
                inheritedExpiries.map((expiry) => sql`${expiry}::timestamptz`),
                sql`, `,
              )})`
            : sql`false`;
          const children = await tx.execute<{ subsidiary_id: string }>(
            sql`
          select subsidiary_id from period_locks
           where org_id = ${args.orgId} and period_id = ${row.period_id}
             and book_id = ${row.book_id} and module = ${module}
             and subsidiary_id is not null
             and (state = 'closed'
               or state = 'soft_closed'
               or (state = 'open' and reopen_expires_at is not null and
                 (reopen_expires_at <= now() or ${inheritedWindow})))
           for update`,
            "objects",
          );
          for (const child of children) {
            await upsertLock({
              tx,
              orgId: args.orgId,
              periodId: row.period_id,
              bookId: row.book_id,
              subsidiaryId: child.subsidiary_id,
              module,
              state: "open",
              actorId: args.actorId,
              reason: row.reason,
              reopenExpiresAt: expiresAt,
            });
          }
        }
      }
      await reversePeriodEndJournalsForReopen(tx, {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        modules,
        actorId: args.actorId,
        reason: row.reason,
        requestId: args.requestId,
      });
      const approved = await tx.execute(
        sql`
      update close_reopen_requests set status = 'approved', approved_by = ${args.actorId},
             approved_at = now(), expires_at = ${expiresAt.toISOString()}, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
      returning id`,
        "objects",
      );
      if (approved.length !== 1)
        throw new CloseError("pending reopen request changed during decision");
      await tx.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review', approved_at = null,
             approved_by = null, closed_at = null, closed_by = null, published_at = null,
             published_by = null, updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and period_id = ${row.period_id} and book_id = ${row.book_id}`);
      await tx.execute(sql`
      update close_run_tasks t set status = 'invalidated', completed_at = null, completed_by = null,
             reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${args.actorId}
       from close_runs r where r.id = t.run_id and r.org_id = ${args.orgId}
         and r.period_id = ${row.period_id} and r.book_id = ${row.book_id}
         and t.status in ('complete','waived')`);
      decided = {
        status: "approved",
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        modules: row.modules,
        reason: row.reason,
        requestedBy: row.requested_by,
        conflicts,
        decisionReason: null,
        expiresAt: expiresAt.toISOString(),
      };
      await recordDecision(tx);
    });
  await decide();
}

/**
 * Withdraw a pending reopen request. Only the requester may withdraw: a
 * request they no longer need is recorded as withdrawn by them, which keeps
 * it distinct from an approver's rejection in the history. The transition,
 * its audit row and its close-history event commit together, and nothing is
 * written for a refused withdrawal.
 */
export async function withdrawPeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character withdrawal reason is required");
  }
  await withOrgTransaction(args.orgId, async () => {
    const tx = db;
    await lockApprovalSubject(args.orgId, "close_reopen_request", args.requestId);
    await lockReopenRequestScope(tx, args.orgId, args.requestId);
    const request = await tx.execute<CloseReopenRequestRow>(
      sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`,
      "objects",
    );
    const row = request[0];
    if (!row) throw new CloseError("pending reopen request not found");
    if (row.requested_by !== args.actorId) {
      throw new CloseError(
        "Only the requester can withdraw a reopen request; an approver rejects it with a reason",
      );
    }
    await lockActorCommandAuthority(
      tx,
      args.orgId,
      args.actorId,
      row.subsidiary_id,
      "close.reopen",
    );
    const runs = await tx.execute<{
      id: string;
    }>(
      sql`select id from flow_runs where org_id=${args.orgId}
      and subject_kind='close_reopen_request' and subject_id=${args.requestId}`,
      "objects",
    );
    await cancelDispatchRuns(
      args.orgId,
      runs.map((run) => run.id),
      { actorId: args.actorId },
    );
    const updated = await tx.execute<{ id: string }>(
      sql`
      update close_reopen_requests
         set status = 'withdrawn', updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
      returning id`,
      "objects",
    );
    if (updated.length !== 1) {
      throw new CloseError("pending reopen request not found");
    }
    const scope = {
      periodId: row.period_id,
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      modules: row.modules,
    };
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, 'withdraw',
              ${JSON.stringify({
                before: { status: "requested" },
                after: { status: "withdrawn", reason },
                scope,
                requestedBy: row.requested_by,
              })}::jsonb, ${args.actorId})`);
    await tx.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.reopen_withdrawn', ${args.actorId},
              ${JSON.stringify({
                requestId: args.requestId,
                reason,
                scope,
                requestedBy: row.requested_by,
              })}::jsonb)`);
  });
}
