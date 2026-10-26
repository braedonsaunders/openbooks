import { CloseError, CLOSE_MODULES, type CloseModule } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";

import {
  upsertLock,
  periodScopeAdvisoryLock,
  tightenNarrowerLocks,
} from "../periods/period-locks.ts";
import { CloseReopenRequestRow, lockReopenRequestScope } from "./reopen-approvals.ts";

async function recloseApprovedReopenRow(args: {
  tx: SqlExecutor;
  row: CloseReopenRequestRow;
  actorId?: string;
  reason: string;
  automatic: boolean;
}): Promise<void> {
  const modules = args.row.modules;
  if (modules.length === 0 || modules.some((module) => !CLOSE_MODULES.includes(module))) {
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
  const overlapping = await args.tx.execute<{ id: string; modules: CloseModule[] }>(
    sql`
    select id, modules
      from close_reopen_requests
     where org_id = ${args.row.org_id}
       and period_id = ${args.row.period_id}
       and book_id = ${args.row.book_id}
       and subsidiary_id is not distinct from ${args.row.subsidiary_id}
       and id <> ${args.row.id}
       and status = 'approved'
       and expires_at > now()
     for update`,
    "objects",
  );
  const coveredModules = new Set(
    overlapping.flatMap((request) => request.modules.filter((module) => modules.includes(module))),
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
    const openSubledgers = await args.tx.execute<{ module: CloseModule }>(
      sql`
      select module
        from period_locks
       where org_id = ${args.row.org_id}
         and period_id = ${args.row.period_id}
         and book_id = ${args.row.book_id}
         and subsidiary_id is not distinct from ${args.row.subsidiary_id}
         and module <> 'gl'
         and state <> 'closed'
       for update`,
      "objects",
    );
    if (openSubledgers.length > 0) {
      throw new CloseError(
        `cannot re-close GL while ${openSubledgers
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
  const finalStatus = args.automatic && coveredModules.size > 0 ? "expired" : "reclosed";
  const updated = await args.tx.execute(
    sql`
    update close_reopen_requests
       set status = ${finalStatus},
           reclosed_at = ${finalStatus === "reclosed" ? sql`now()` : sql`null`},
           updated_at = now(),
           updated_by = ${args.actorId ?? null}
     where id = ${args.row.id} and org_id = ${args.row.org_id} and status = 'approved'
    returning id`,
    "objects",
  );
  if (updated.length !== 1) {
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
              overlappingRequestIds: overlapping.map((row) => row.id),
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
    const request = await tx.execute<CloseReopenRequestRow>(
      sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
       for update`,
      "objects",
    );
    const row = request[0];
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
    }>(
      sql`
    select request.id, request.org_id, request.period_id, request.book_id,
           request.subsidiary_id, request.modules, request.reason
      from close_reopen_requests request
      join orgs organization on organization.id = request.org_id
     where request.status = 'approved' and request.expires_at <= now()
       and organization.env_kind = 'production'`,
      "objects",
    ),
  );
  // A concurrent tick may lock a candidate first: its re-close commits and
  // this tick's lock finds no approved row. Only committed re-closes count —
  // returning the candidate count would double-count the same window across
  // the two ticks.
  let reclosed = 0;
  for (const row of expired) {
    try {
      const didReclose = await withOrgContext(row.org_id, () =>
        db.transaction(async (tx) => {
          await periodScopeAdvisoryLock(tx, row.org_id, row.period_id, row.book_id);
          const locked = await tx.execute<CloseReopenRequestRow>(
            sql`
            select *
              from close_reopen_requests
             where id = ${row.id}
               and org_id = ${row.org_id}
               and status = 'approved'
               and expires_at <= now()
             for update`,
            "objects",
          );
          const lockedRow = locked[0];
          if (!lockedRow) return false;
          await recloseApprovedReopenRow({
            tx,
            row: lockedRow,
            actorId,
            reason: lockedRow.reason,
            automatic: true,
          });
          return true;
        }),
      );
      if (didReclose) reclosed += 1;
    } catch (error) {
      if (!(error instanceof CloseError)) throw error;
      await withOrgContext(row.org_id, () =>
        db.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${row.org_id}, 'period.reopen_expiry_blocked', ${actorId ?? null},
          ${JSON.stringify({
            requestId: row.id,
            periodId: row.period_id,
            bookId: row.book_id,
            subsidiaryId: row.subsidiary_id,
            modules: row.modules,
            reason: error.message,
          })}::jsonb)`),
      );
    }
  }
  return reclosed;
}
