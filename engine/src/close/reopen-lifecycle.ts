import { CloseError, CLOSE_MODULES, periodLockRequiresApprovedReopen, type CloseModule } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { reversePeriodEndJournalsForReopen } from "./period-end-journals.ts";
import { upsertLock, periodScopeAdvisoryLock, tightenNarrowerLocks } from "../periods/period-locks.ts";
import { CloseReopenRequestRow, ReopenApprovalConflict, controlledReopenHours, describeActiveReopenOverlap, describeReopenConflicts, endFullyClosedReopenRequests, lockReopenRequestScope, reopenApprovalConflicts, reopenIndependenceRequired, unconflictedReopenApprovers } from "./reopen-approvals.ts";

type ReopenDecisionRecord = {
  status: "approved" | "rejected";
  periodId: string;
  bookId: string;
  subsidiaryId: string | null;
  modules: CloseModule[];
  reason: string;
  requestedBy: string;
  selfApproved: boolean;
  conflictAcknowledged: boolean;
  attestation: string | null;
  conflicts: ReopenApprovalConflict[];
  decisionReason: string | null;
  expiresAt: string | null;
};

export async function decidePeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  approve: boolean;
  hours?: number;
  /**
   * Self-approval attestation, required when the decider is the requester
   * and no independent approver is available. A 10-500 character reason
   * recording why no other approver could decide it; retained in the
   * decision audit. Also the conflict acknowledgement a conflicted
   * approver records when no unconflicted eligible approver exists.
   */
  attestation?: string;
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
  let conflictRefusal: ReopenApprovalConflict[] | null = null;
  const recordDecision = async (tx: SqlExecutor) => {
    if (decided) {
      const scope = {
        periodId: decided.periodId,
        bookId: decided.bookId,
        subsidiaryId: decided.subsidiaryId,
        modules: decided.modules,
      };
      // A sole-approver self-approval is its own audit entry: the action
      // names it, the note records that no other eligible approver existed,
      // and the conflict detail the requester accepted is retained.
      const action = decided.status === "rejected"
        ? "reject"
        : decided.selfApproved ? "self_approve" : "approve";
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, ${action},
                ${JSON.stringify({
                  before: { status: "requested" },
                  after: {
                    status: decided.status,
                  expiresAt: decided.expiresAt,
                    reason: decided.reason,
                    ...(decided.decisionReason != null ? { decisionReason: decided.decisionReason } : {}),
                    ...(decided.selfApproved
                      ? {
                        selfApproved: true,
                        note: "self-approved: no other eligible approver",
                        attestation: decided.attestation,
                        conflicts: decided.conflicts,
                      }
                      : {}),
                    ...(decided.conflictAcknowledged
                      ? {
                        conflictAcknowledged: true,
                        note: "approved with a recorded conflict: no unconflicted eligible approver",
                        attestation: decided.attestation,
                        conflicts: decided.conflicts,
                      }
                      : {}),
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
                  expiresAt: decided.expiresAt,
                  reason: decided.reason,
                  ...(decided.decisionReason != null ? { decisionReason: decided.decisionReason } : {}),
                  scope,
                  requestedBy: decided.requestedBy,
                  ...(decided.selfApproved
                    ? {
                      selfApproved: true,
                      note: "self-approved: no other eligible approver",
                      attestation: decided.attestation,
                      conflicts: decided.conflicts,
                    }
                    : {}),
                  ...(decided.conflictAcknowledged
                    ? {
                      conflictAcknowledged: true,
                      note: "approved with a recorded conflict: no unconflicted eligible approver",
                      attestation: decided.attestation,
                      conflicts: decided.conflicts,
                    }
                    : {}),
                })}::jsonb)`);
    }
  };
  const decide = async () => db.transaction(async (tx) => {
    await lockReopenRequestScope(tx, args.orgId, args.requestId);
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("pending reopen request not found");
    if (args.approve) {
      conflicts = await reopenApprovalConflicts(tx, args.orgId, row, args.actorId);
    }
    const selfApproval = row.requested_by === args.actorId;
    // A requester who no longer wants the reopen withdraws it (withdrawPeriodReopen),
    // which keeps the history honest: a rejection is always an approver's decision.
    if (!args.approve && selfApproval) {
      throw new CloseError(
        "the requester cannot reject their own reopen request; withdraw it with a reason instead",
      );
    }
    // Eligibility resolves here, inside the decision transaction: another
    // approver may have joined (or the last one left) since the request.
    const independence = args.approve || selfApproval
      ? await reopenIndependenceRequired(tx, args.orgId, {
        requestedBy: row.requested_by, subsidiaryId: row.subsidiary_id,
      })
      : { required: false, reason: null as "another-approver" | "flow" | null, approvers: [] as string[], approverIds: [] as string[] };
    if (selfApproval && args.approve && independence.required) {
      throw new CloseError(
        independence.approvers.length > 0
          ? `a reopen request requires independent approval: ${independence.approvers.join(", ")} `
            + `can decide it from My approvals or Accounting → Reopen requests`
          : "a reopen request requires independent approval: an approval Flow requires a decider other than the requester; "
            + "an administrator can grant another user the Close reopen permission",
      );
    }
    let attestation: string | null = null;
    if (selfApproval && args.approve) {
      // The requester is the only eligible approver: self-approval is
      // allowed with an explicit attestation, recorded as its own audit
      // entry with the conflict detail retained.
      attestation = (args.attestation ?? "").trim();
      if (attestation.length < 10 || attestation.length > 500) {
        throw new CloseError(
          "self-approving a reopen requires a 10-500 character attestation recording why no other approver could decide it",
        );
      }
    }
    let conflictAcknowledged = false;
    if (args.approve && !selfApproval && conflicts.length > 0 && independence.required) {
      const unconflicted = await unconflictedReopenApprovers(
        tx, args.orgId, { period_id: row.period_id, book_id: row.book_id, subsidiary_id: row.subsidiary_id },
        independence, args.actorId,
      );
      const acknowledgement = (args.attestation ?? "").trim();
      if (unconflicted.length > 0) {
        // Mark the refusal for its audit on the way out: writing it here
        // would roll back with the refused decision.
        conflictRefusal = conflicts;
        throw new CloseError(
          `conflict of interest: you are recorded on the records this reopen would unlock (${describeReopenConflicts(conflicts)}); `
          + `${unconflicted.join(", ")} can decide it without a conflict`,
        );
      }
      if (acknowledgement.length < 10 || acknowledgement.length > 500) {
        conflictRefusal = conflicts;
        throw new CloseError(
          `conflict of interest: you are recorded on the records this reopen would unlock (${describeReopenConflicts(conflicts)}). `
          + "No other eligible approver is free of conflicts, so you may approve with a 10-500 character conflict acknowledgement recording why",
        );
      }
      attestation = acknowledgement;
      conflictAcknowledged = true;
    }
    if (!args.approve) {
      const updated = await tx.execute(sql`
        update close_reopen_requests set status = 'rejected', approved_by = ${args.actorId},
               approved_at = now(), updated_at = now(), updated_by = ${args.actorId}
         where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
        returning id`);
      if (updated.rows.length !== 1) throw new CloseError("pending reopen request changed during decision");
      decided = {
        status: "rejected",
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        modules: row.modules,
        reason: row.reason,
        requestedBy: row.requested_by,
        selfApproved: false,
        conflictAcknowledged: false,
        attestation: null,
        conflicts: [],
        decisionReason,
        expiresAt: null,
      };
      await recordDecision(tx);
      return;
    }
    await periodScopeAdvisoryLock(tx, args.orgId, row.period_id, row.book_id);
    const { defaultHours, maxHours } = await controlledReopenHours(tx, args.orgId);
    const requestedHours = Number.isFinite(args.hours)
      ? Math.trunc(args.hours!)
      : defaultHours;
    const hours = Math.min(Math.max(requestedHours, 1), maxHours);
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
    const activeRequests = (await tx.execute<{ id: string; modules: CloseModule[]; subsidiary_id: string | null; expires_at: Date | string }>(sql`
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
       for update`));
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
      candidateIds: activeRequests.rows.map((request) => request.id),
    });
    const consumedIds = new Set(consumed);
    const live = activeRequests.rows.filter((request) => !consumedIds.has(request.id));
    // A request covering every module of an approved window widens or
    // extends it: approving it supersedes that window, recorded as such.
    const superseded = live.filter((request) =>
      request.subsidiary_id === row.subsidiary_id
      && request.modules.every((module) => modules.includes(module)),
    );
    const amendment = row.impact_snapshot?.amendment;
    if (amendment) {
      const source = superseded.find((request) => request.id === amendment.requestId);
      if (!source || new Date(source.expires_at).toISOString() !== amendment.sourceExpiresAt) {
        throw new CloseError("the original reopen window has ended or changed; withdraw this request and raise a new request for the current closed scope");
      }
      expiresAt = new Date(amendment.expiresAt);
      const approvedAt = new Date(amendment.approvedAt);
      if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(approvedAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new CloseError("the requested reopen window has expired; withdraw this request and raise a new request");
      }
      if (amendment.additionalHours > 0 && expiresAt.getTime() > approvedAt.getTime() + maxHours * 60 * 60 * 1000) {
        throw new CloseError("the requested extension exceeds the controlled reopen policy maximum; withdraw this request and request fewer additional hours");
      }
    }
    const inheritedModules = new Set(superseded.flatMap((request) => request.modules));
    const supersededIds = new Set(superseded.map((request) => request.id));
    const overlap = live.find((request) =>
      !supersededIds.has(request.id) && request.modules.some((module) => modules.includes(module)),
    );
    if (overlap) {
      throw new CloseError(await describeActiveReopenOverlap(tx, args.orgId, overlap.id));
    }
    if (!amendment && superseded.length > 0) {
      expiresAt = new Date(Math.max(expiresAt.getTime(), ...superseded.map((request) => new Date(request.expires_at).getTime())));
    }
    if (modules.some((module) => module !== "gl") && !modules.includes("gl")) {
      const gl = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id}
           and (subsidiary_id = ${row.subsidiary_id}::uuid or subsidiary_id is null)
           and module = 'gl'
         order by (subsidiary_id is not null) desc limit 1`));
      const governing = gl.rows[0];
      if (periodLockRequiresApprovedReopen(governing && {
        state: governing.state, reopenExpiresAt: governing.reopen_expires_at, reason: null,
      })) {
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
      const governing = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id} and module = ${module}
           and (subsidiary_id is not distinct from ${row.subsidiary_id}::uuid or subsidiary_id is null)
         order by (subsidiary_id is not null) desc limit 1`));
      const lock = governing.rows[0];
      if (!periodLockRequiresApprovedReopen(lock && {
        state: lock.state,
        reopenExpiresAt: lock.reopen_expires_at,
        reason: null,
      })) {
        openModules.push(module);
      }
    }
    if (openModules.length > 0) {
      throw new CloseError(
        `cannot reopen ${openModules.join(", ")}: no closed lock in the requested scope — nothing to reopen; narrow the request to the closed modules`,
      );
    }
    for (const window of superseded) {
      const updated = await tx.execute(sql`
        update close_reopen_requests
           set status = 'superseded', updated_at = now(), updated_by = ${args.actorId}
         where id = ${window.id} and org_id = ${args.orgId} and status = 'approved'
        returning id`);
      if (updated.rows.length !== 1) throw new CloseError("approved reopen window changed during decision");
      const evidence = { requestId: window.id, supersededBy: args.requestId, modules: window.modules, reason: row.reason };
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
        const inheritedExpiries = superseded.filter((request) => request.modules.includes(module)).map((request) => new Date(request.expires_at).toISOString());
        const inheritedWindow = inheritedExpiries.length
          ? sql`reopen_expires_at in (${sql.join(inheritedExpiries.map((expiry) => sql`${expiry}::timestamptz`), sql`, `)})`
          : sql`false`;
        const children = (await tx.execute<{ subsidiary_id: string }>(sql`
          select subsidiary_id from period_locks
           where org_id = ${args.orgId} and period_id = ${row.period_id}
             and book_id = ${row.book_id} and module = ${module}
             and subsidiary_id is not null
             and (state = 'closed'
               or state = 'soft_closed'
               or (state = 'open' and reopen_expires_at is not null and
                 (reopen_expires_at <= now() or ${inheritedWindow})))
           for update`));
        for (const child of children.rows) {
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
      orgId: args.orgId, periodId: row.period_id, bookId: row.book_id, subsidiaryId: row.subsidiary_id,
      modules, actorId: args.actorId, reason: row.reason, requestId: args.requestId,
    });
    const approved = await tx.execute(sql`
      update close_reopen_requests set status = 'approved', approved_by = ${args.actorId},
             approved_at = now(), expires_at = ${expiresAt.toISOString()}, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
      returning id`);
    if (approved.rows.length !== 1) throw new CloseError("pending reopen request changed during decision");
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
      selfApproved: selfApproval,
      conflictAcknowledged,
      attestation,
      conflicts: selfApproval || conflictAcknowledged ? conflicts : [],
      decisionReason: null,
      expiresAt: expiresAt.toISOString(),
    };
    await recordDecision(tx);
  });
  try {
    await decide();
  } catch (error) {
    // The conflict refusal's audit commits here, outside the rolled-back
    // decision transaction — a refused decision must still leave evidence
    // of why it was refused.
    if (conflictRefusal && error instanceof CloseError) {
      await db.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${args.orgId}, 'period.reopen_conflict', ${args.actorId},
                ${JSON.stringify({ requestId: args.requestId, conflicts: conflictRefusal })}::jsonb)`);
    }
    throw error;
  }
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
  await db.transaction(async (tx) => {
    await lockReopenRequestScope(tx, args.orgId, args.requestId);
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("pending reopen request not found");
    if (row.requested_by !== args.actorId) {
      throw new CloseError("Only the requester can withdraw a reopen request; an approver rejects it with a reason");
    }
    const updated = await tx.execute<{ id: string }>(sql`
      update close_reopen_requests
         set status = 'withdrawn', updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
      returning id`);
    if (updated.rows.length !== 1) {
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

async function recloseApprovedReopenRow(args: {
  tx: SqlExecutor;
  row: CloseReopenRequestRow;
  actorId?: string;
  reason: string;
  automatic: boolean;
}): Promise<void> {
  const modules = args.row.modules;
  if (
    modules.length === 0 ||
    modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("reopen request contains an invalid module");
  }
  await args.tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`close-reopen:${args.row.org_id}:${args.row.period_id}:${args.row.book_id}:${args.row.subsidiary_id ?? "all"}`},
        0
      )
    )
  `);
  const overlapping = (await args.tx.execute<{ id: string; modules: CloseModule[] }>(sql`
    select id, modules
      from close_reopen_requests
     where org_id = ${args.row.org_id}
       and period_id = ${args.row.period_id}
       and book_id = ${args.row.book_id}
       and subsidiary_id is not distinct from ${args.row.subsidiary_id}
       and id <> ${args.row.id}
       and status = 'approved'
       and expires_at > now()
     for update`));
  const coveredModules = new Set(
    overlapping.rows.flatMap((request) =>
      request.modules.filter((module) => modules.includes(module)),
    ),
  );
  const modulesToClose = modules.filter((module) => !coveredModules.has(module));

  for (const module of modulesToClose.filter((item) => item !== "gl")) {
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module,
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  if (modulesToClose.includes("gl")) {
    const openSubledgers = (await args.tx.execute<{ module: CloseModule }>(sql`
      select module
        from period_locks
       where org_id = ${args.row.org_id}
         and period_id = ${args.row.period_id}
         and book_id = ${args.row.book_id}
         and subsidiary_id is not distinct from ${args.row.subsidiary_id}
         and module <> 'gl'
         and state <> 'closed'
       for update`));
    if (openSubledgers.rows.length > 0) {
      throw new CloseError(
        `cannot re-close GL while ${openSubledgers.rows
          .map((item) => item.module.toUpperCase())
          .join(", ")} remains open`,
      );
    }
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module: "gl",
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  if (args.row.subsidiary_id == null) {
    // Mirror of the approve-time relaxation above (and of the scope-wide
    // close tightening in setPeriodLockState): ending an org-wide window
    // must dominate every narrower lock, or an open child row shadows the
    // re-closed scope and keeps accepting postings after the window ends.
    // Only the re-closed modules' rows move; a live window owned by another
    // request covers different modules by construction of the overlap check.
    for (const module of modulesToClose) {
      await tightenNarrowerLocks({
        tx: args.tx,
        orgId: args.row.org_id,
        periodId: args.row.period_id,
        bookId: args.row.book_id,
        module,
        state: "closed",
        actorId: args.actorId,
        reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
      });
    }
  }
  const finalStatus =
    args.automatic && coveredModules.size > 0 ? "expired" : "reclosed";
  const updated = await args.tx.execute(sql`
    update close_reopen_requests
       set status = ${finalStatus},
           reclosed_at = ${finalStatus === "reclosed" ? sql`now()` : sql`null`},
           updated_at = now(),
           updated_by = ${args.actorId ?? null}
     where id = ${args.row.id} and org_id = ${args.row.org_id} and status = 'approved'
    returning id`);
  if (updated.rows.length !== 1) {
    throw new CloseError("approved reopen request changed during re-close");
  }
  await args.tx.execute(sql`
    insert into close_events (org_id, event_type, actor_id, payload)
    values (${args.row.org_id},
            ${
              args.automatic
                ? coveredModules.size > 0
                  ? "period.reopen_expired_with_overlap"
                  : "period.automatically_reclosed"
                : coveredModules.size > 0
                  ? "period.controlled_reclosed_with_overlap"
                  : "period.controlled_reclosed"
            },
            ${args.actorId ?? null},
            ${JSON.stringify({
              requestId: args.row.id,
              periodId: args.row.period_id,
              bookId: args.row.book_id,
              modules,
              modulesClosed: modulesToClose,
              modulesStillOpen: [...coveredModules],
              overlappingRequestIds: overlapping.rows.map((row) => row.id),
              reason: args.reason,
            })}::jsonb)`);
}

/** End an approved reopen window early with a stated reason.
 * Any holder of the reopen-approval permission (`close.reopen`) may end any
 * active window — including a stale window whose modules are already closed,
 * which otherwise blocks new reopens with no user path to clear it. Ending
 * re-closes the modules the window opened, exactly like the re-close path.
 * The original approval remains immutable; the actor, timestamp and reason
 * are appended to the close event stream and the audit trail. The automatic
 * expiry tick carries no actor and keeps its own path. */
export async function recloseApprovedReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character re-close reason is required");
  }
  await db.transaction(async (tx) => {
    await lockReopenRequestScope(tx, args.orgId, args.requestId);
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("approved reopen request not found");
    // Ending a window closes modules, so the gate is the reopen-approval
    // permission resolved in-transaction — never identity. A stale window's
    // requester or approver may be unavailable, and the route already
    // requires the same permission; unknown or inactive principals fail
    // closed inside the permission check.
    if (!(await actorHasPermission(tx, args.orgId, args.actorId, "close.reopen"))) {
      throw new CloseError(
        "ending a reopen window requires the close reopen permission; ask an administrator for access",
      );
    }
    await recloseApprovedReopenRow({
      tx,
      row,
      actorId: args.actorId,
      reason,
      automatic: false,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, 'end',
              ${JSON.stringify({
                before: { status: "approved" },
                after: { status: "reclosed", reason },
                scope: {
                  periodId: row.period_id,
                  bookId: row.book_id,
                  subsidiaryId: row.subsidiary_id,
                  modules: row.modules,
                },
              })}::jsonb, ${args.actorId})`);
  });
}

export async function recloseExpiredReopens(actorId?: string): Promise<number> {
  // Finding expired reopen windows spans organizations and crosses an explicit
  // trusted boundary; each re-close then commits inside its own tenant. The
  // scheduler tick that calls this holds no request store, so without the
  // boundary RLS denies by default and no window is ever closed again.
  // bypass: scheduler-tick — expired reopen windows are found across every organization.
  const expired = await withBypassContext(() =>
    db.execute<{
      id: string;
      org_id: string;
      period_id: string;
      book_id: string;
      subsidiary_id: string | null;
      modules: CloseModule[];
      reason: string;
    }>(sql`
    select request.id, request.org_id, request.period_id, request.book_id,
           request.subsidiary_id, request.modules, request.reason
      from close_reopen_requests request
      join orgs organization on organization.id = request.org_id
     where request.status = 'approved' and request.expires_at <= now()
       and organization.env_kind = 'production'`));
  // A concurrent tick may lock a candidate first: its re-close commits and
  // this tick's lock finds no approved row. Only committed re-closes count —
  // returning the candidate count would double-count the same window across
  // the two ticks.
  let reclosed = 0;
  for (const row of expired.rows) {
    try {
      const didReclose = await withOrgContext(row.org_id, () =>
        db.transaction(async (tx) => {
          await periodScopeAdvisoryLock(tx, row.org_id, row.period_id, row.book_id);
          const locked = (await tx.execute<CloseReopenRequestRow>(sql`
            select *
              from close_reopen_requests
             where id = ${row.id}
               and org_id = ${row.org_id}
               and status = 'approved'
               and expires_at <= now()
             for update`));
          const lockedRow = locked.rows[0];
          if (!lockedRow) return false;
          await recloseApprovedReopenRow({
            tx,
            row: lockedRow,
            actorId,
            reason: lockedRow.reason,
            automatic: true,
          });
          return true;
        }));
      if (didReclose) reclosed += 1;
    } catch (error) {
      if (!(error instanceof CloseError)) throw error;
      await withOrgContext(row.org_id, () => db.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${row.org_id}, 'period.reopen_expiry_blocked', ${actorId ?? null},
          ${JSON.stringify({
            requestId: row.id,
            periodId: row.period_id,
            bookId: row.book_id,
            subsidiaryId: row.subsidiary_id,
            modules: row.modules,
            reason: error.message,
          })}::jsonb)`));
    }
  }
  return reclosed;
}
