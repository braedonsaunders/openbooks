import { submitPeriodReopen } from "./reopen-lifecycle.ts";
import {
  canonicalPeriodLabelSql,
  CloseError,
  CLOSE_MODULES,
  periodLockRequiresApprovedReopen,
  type CloseModule,
} from "../periods/period-policy.ts";
import { assertPeriodEndReopenAllowed } from "./period-end-journals.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { assertCloseScope, periodScopeAdvisoryLock } from "../periods/period-locks.ts";
import {
  type CloseReopenRequestRow,
  type ReopenAmendment,
  controlledReopenHours,
  lockReopenRequestScope,
} from "./reopen-approvals.ts";
export {
  consumeReopenRequestsForClosedModules,
  describeReopenConflicts,
  reopenApprovalConflicts,
  reopenRequestConflicts,
  type ReopenApprovalConflict,
} from "./reopen-approvals.ts";
export { submitPeriodReopen, withdrawPeriodReopen } from "./reopen-lifecycle.ts";
export { recloseApprovedReopen, recloseExpiredReopens } from "./reclose.ts";

type ReopenRequestArgs = {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  actorId: string;
  hours?: number;
};

export async function requestPeriodReopen(args: ReopenRequestArgs): Promise<string> {
  return withOrgTransaction(args.orgId, async () => {
    await periodScopeAdvisoryLock(db, args.orgId, args.periodId, args.bookId);
    const id = await insertPeriodReopenRequest(db, args);
    await submitPeriodReopen({
      orgId: args.orgId,
      requestId: id,
      actorId: args.actorId,
      hours: args.hours,
    });
    return id;
  });
}

async function insertPeriodReopenRequest(
  tx: SqlExecutor,
  args: ReopenRequestArgs,
  amendment?: ReopenAmendment,
): Promise<string> {
  if (!args.reason.trim()) throw new CloseError("a reopening reason is required");
  if (args.modules.length === 0 || args.modules.some((module) => !CLOSE_MODULES.includes(module))) {
    throw new CloseError("at least one valid module is required");
  }
  await assertCloseScope(tx, {
    ...args,
    subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
  });
  // Scope dependencies fail at request time, not at the approver's desk: a
  // subledger-only request over a closed GL can never be approved (the
  // approval-time check below stays as the backstop against a GL that closes
  // between request and decision), so accepting it would strand the approver
  // with Reject as the only path forward. The refusal names the remedy —
  // include General ledger in the reopen scope — instead of the lock state.
  if (args.modules.some((module) => module !== "gl") && !args.modules.includes("gl")) {
    const gl = await tx.execute<{
      state: string;
      reopen_expires_at: Date | null;
    }>(
      sql`
      select state, reopen_expires_at from period_locks
       where org_id = ${args.orgId} and period_id = ${args.periodId}
         and book_id = ${args.bookId}
         and (subsidiary_id = ${args.subsidiaryId ?? null}::uuid or subsidiary_id is null)
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
      throw new CloseError(
        `cannot reopen ${args.modules.map((module) => module.toUpperCase()).join(", ")} while General ledger is closed for this period and book; include General ledger in the reopen scope`,
      );
    }
  }
  // Overlap fails at request time too: two requests sharing a module on the
  // same scope can never both be approved, so the second would strand its
  // approver. A pending request is withdrawn and raised again with every
  // module; an approved window is widened instead.
  const overlapping = (
    await tx.execute<{
      id: string;
      status: string;
      modules: CloseModule[];
      subsidiary_id: string | null;
      period_label: string | null;
    }>(
      sql`
    select r.id, r.status, r.modules, r.subsidiary_id, ${canonicalPeriodLabelSql()} as period_label
      from close_reopen_requests r
      left join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
     where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}
       and (r.subsidiary_id is null or ${args.subsidiaryId ?? null}::uuid is null
         or r.subsidiary_id = ${args.subsidiaryId ?? null}::uuid)
       and (r.status = 'requested' or (r.status = 'approved' and r.expires_at > now()))`,
      "objects",
    )
  )
    // A request covering every module of an approved window is that
    // window's widening or extension: an eligible approver decides it, and
    // its approval replaces the window.
    .find(
      (request) =>
        request.modules.some((module) => args.modules.includes(module)) &&
        !(
          request.status === "approved" &&
          request.subsidiary_id === (args.subsidiaryId ?? null) &&
          request.modules.every((module) => args.modules.includes(module))
        ),
    );
  if (overlapping) {
    const scope = `${overlapping.period_label ?? "this period"} ${overlapping.modules.map((module) => module.toUpperCase()).join(", ")}`;
    throw new CloseError(
      overlapping.status === "requested"
        ? `a reopen request for ${scope} is already awaiting a decision; withdraw it and raise one request covering every module you need, or wait for its decision and widen the approved window`
        : `an approved reopen window for ${scope} is active; to widen or extend it, raise one request that includes all of its modules plus the ones you need — its approval replaces the window`,
    );
  }
  await assertPeriodEndReopenAllowed(tx, args);
  const impact = await tx.execute<Record<string, unknown>>(
    sql`
    select
      (select count(*) from journal_entries where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}) as entries,
      (select count(*) from close_signoffs s join close_runs r on r.id = s.run_id and r.org_id = s.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as signoffs,
      (select count(*) from close_task_evidence e join close_runs r on r.id = e.run_id and r.org_id = e.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as evidence`,
    "objects",
  );
  const inserted = await tx.execute<{ id: string }>(
    sql`
    insert into close_reopen_requests
      (org_id, period_id, book_id, subsidiary_id, modules, reason, impact_snapshot,
       requested_by, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${JSON.stringify(args.modules)}::jsonb, ${args.reason.trim()},
            ${JSON.stringify({ ...impact[0], ...(amendment ? { amendment } : {}), reports: ["balance-sheet", "pnl", "cash-flow", "trial-balance"] })}::jsonb,
            ${args.actorId}, ${args.actorId}, ${args.actorId})
    returning id`,
    "objects",
  );
  const id = inserted[0]?.id;
  if (!id) throw new CloseError("reopen request was not saved; refresh and retry");
  const scope = {
    periodId: args.periodId,
    bookId: args.bookId,
    subsidiaryId: args.subsidiaryId ?? null,
    modules: args.modules,
  };
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'close_reopen_requests', ${id}, 'request',
      ${JSON.stringify({ before: null, after: { status: "requested", reason: args.reason.trim(), ...(amendment ? { amendment } : {}) }, scope })}::jsonb,
      ${args.actorId})`);
  await tx.execute(sql`
    insert into close_events (org_id, event_type, actor_id, payload)
    values (${args.orgId}, 'period.reopen_requested', ${args.actorId},
      ${JSON.stringify({ requestId: id, reason: args.reason.trim(), scope, ...(amendment ? { amendment } : {}) })}::jsonb)`);
  return id;
}

/** Request a governed change to an active window; its approval remains unchanged until the new request is decided. */
export async function extendReopenRequest(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
  additionalHours?: number;
  addModules?: CloseModule[];
}): Promise<{ requestId: string; expiresAt: string; modules: CloseModule[] }> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character extension reason is required");
  }
  const addModules = [...new Set(args.addModules ?? [])];
  if (addModules.some((module) => !CLOSE_MODULES.includes(module))) {
    throw new CloseError("extension contains an invalid module");
  }
  const additionalHours = args.additionalHours ?? 0;
  if (!Number.isInteger(additionalHours) || additionalHours < 0 || additionalHours > 168) {
    throw new CloseError("additional hours must be between 0 and 168");
  }
  return withOrgTransaction(args.orgId, async () => {
    const tx = db;
    await lockReopenRequestScope(tx, args.orgId, args.requestId);
    const row = (
      await tx.execute<CloseReopenRequestRow>(
        sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId}
         and status = 'approved' and expires_at > now()
       for update`,
        "objects",
      )
    )[0];
    if (!row) throw new CloseError("only an active approved reopen window can be extended");
    const added = addModules.filter((module) => !row.modules.includes(module));
    if (additionalHours === 0 && added.length === 0) {
      throw new CloseError("an extension must add time, modules, or both");
    }
    for (const module of added) {
      const lock = (
        await tx.execute<{ state: string; reopen_expires_at: Date | null }>(
          sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id} and book_id = ${row.book_id}
           and module = ${module}
           and (subsidiary_id is not distinct from ${row.subsidiary_id}::uuid or subsidiary_id is null)
         order by (subsidiary_id is not null) desc limit 1`,
          "objects",
        )
      )[0];
      if (
        !periodLockRequiresApprovedReopen(
          lock && {
            state: lock.state,
            reopenExpiresAt: lock.reopen_expires_at,
            reason: null,
          },
        )
      ) {
        throw new CloseError(
          `cannot widen to ${module}: no closed lock in the requested scope — nothing to reopen`,
        );
      }
    }
    const approvedAt =
      row.impact_snapshot?.amendment?.approvedAt ??
      (row.approved_at == null ? null : new Date(row.approved_at).toISOString());
    if (approvedAt == null)
      throw new CloseError(
        "the original reopen approval time is missing; end this window and raise a new request",
      );
    const modules = [...new Set([...row.modules, ...added])];
    const expiresAt = new Date(
      new Date(row.expires_at!).getTime() + additionalHours * 60 * 60 * 1000,
    ).toISOString();
    if (additionalHours > 0) {
      const { maxHours } = await controlledReopenHours(tx, args.orgId);
      if (
        new Date(expiresAt).getTime() >
        new Date(approvedAt).getTime() + maxHours * 60 * 60 * 1000
      ) {
        throw new CloseError(
          "the requested extension exceeds the controlled reopen policy maximum; request fewer additional hours",
        );
      }
    }
    const amendment: ReopenAmendment = {
      requestId: row.id,
      sourceExpiresAt: new Date(row.expires_at!).toISOString(),
      expiresAt,
      additionalHours,
      approvedAt,
    };
    const requestId = await insertPeriodReopenRequest(
      tx,
      {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id ?? undefined,
        modules,
        reason,
        actorId: args.actorId,
      },
      amendment,
    );
    await submitPeriodReopen({
      orgId: args.orgId,
      requestId,
      actorId: args.actorId,
    });
    return { requestId, expiresAt, modules };
  });
}
