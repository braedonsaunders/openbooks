import { CloseError, CLOSE_MODULES, periodLockRequiresApprovedReopen, type CloseModule } from "./period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { assertCloseScope, upsertLock, periodScopeAdvisoryLock } from "./period-locks.ts";
/** One row of close_reopen_requests as read by the approve/re-close paths. */
interface CloseReopenRequestRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  period_id: string;
  book_id: string;
  subsidiary_id: string | null;
  requested_by: string;
  modules: CloseModule[];
  reason: string;
}

export async function requestPeriodReopen(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  actorId: string;
}): Promise<string> {
  if (!args.reason.trim())
    throw new CloseError("a reopening reason is required");
  if (
    args.modules.length === 0 ||
    args.modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("at least one valid module is required");
  }
  await assertCloseScope(db, {
    ...args,
    subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
  });
  const impact = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from journal_entries where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}) as entries,
      (select count(*) from close_signoffs s join close_runs r on r.id = s.run_id and r.org_id = s.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as signoffs,
      (select count(*) from close_task_evidence e join close_runs r on r.id = e.run_id and r.org_id = e.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as evidence`));
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_reopen_requests
      (org_id, period_id, book_id, subsidiary_id, modules, reason, impact_snapshot,
       requested_by, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${JSON.stringify(args.modules)}::jsonb, ${args.reason.trim()},
            ${JSON.stringify({ ...impact.rows[0], reports: ["balance-sheet", "pnl", "cash-flow", "trial-balance"] })}::jsonb,
            ${args.actorId}, ${args.actorId}, ${args.actorId})
    returning id`));
  return inserted.rows[0]!.id;
}

export async function decidePeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  approve: boolean;
  hours?: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("pending reopen request not found");
    if (row.requested_by === args.actorId)
      throw new CloseError("a reopen request requires independent approval");
    if (!args.approve) {
      await tx.execute(sql`
        update close_reopen_requests set status = 'rejected', approved_by = ${args.actorId},
               approved_at = now(), updated_at = now(), updated_by = ${args.actorId}
         where id = ${args.requestId} and org_id = ${args.orgId}`);
      return;
    }
    await periodScopeAdvisoryLock(tx, args.orgId, row.period_id, row.book_id);
    const policy = (await tx.execute<{ rules: { defaultHours?: number; maxHours?: number } }>(sql`select rules from close_policies
      where org_id = ${args.orgId} and code = 'controlled-reopen' and is_active limit 1`));
    const defaultHours = Number(policy.rows[0]?.rules?.defaultHours ?? 24);
    const maxHours = Math.max(
      1,
      Number(policy.rows[0]?.rules?.maxHours ?? 168),
    );
    const requestedHours = Number.isFinite(args.hours)
      ? Math.trunc(args.hours!)
      : defaultHours;
    const hours = Math.min(Math.max(requestedHours, 1), maxHours);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const modules = row.modules;
    if (modules.some((module) => !CLOSE_MODULES.includes(module)))
      throw new CloseError("reopen request contains an invalid module");
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`close-reopen:${args.orgId}:${row.period_id}:${row.book_id}:${row.subsidiary_id ?? "all"}`},
          0
        )
      )
    `);
    const activeRequests = (await tx.execute<{ id: string; modules: CloseModule[] }>(sql`
      select id, modules
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
    const overlap = activeRequests.rows.find((request) =>
      request.modules.some((module) => modules.includes(module)),
    );
    if (overlap) {
      throw new CloseError(
        `reopen request overlaps active request ${overlap.id}`,
      );
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
      // children (an active window owned by another request, an unexpired
      // manual opening) are left alone.
      for (const module of modules) {
        const children = (await tx.execute<{ subsidiary_id: string }>(sql`
          select subsidiary_id from period_locks
           where org_id = ${args.orgId} and period_id = ${row.period_id}
             and book_id = ${row.book_id} and module = ${module}
             and subsidiary_id is not null
             and (state = 'closed'
               or state = 'soft_closed'
               or (state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now()))
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
    await tx.execute(sql`
      update close_reopen_requests set status = 'approved', approved_by = ${args.actorId},
             approved_at = now(), expires_at = ${expiresAt.toISOString()}, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId}`);
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
      const children = (await args.tx.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from period_locks
         where org_id = ${args.row.org_id}
           and period_id = ${args.row.period_id}
           and book_id = ${args.row.book_id}
           and module = ${module} and subsidiary_id is not null and state <> 'closed'
         for update`));
      for (const child of children.rows) {
        await upsertLock({
          tx: args.tx,
          orgId: args.row.org_id,
          periodId: args.row.period_id,
          bookId: args.row.book_id,
          subsidiaryId: child.subsidiary_id,
          module,
          state: "closed",
          actorId: args.actorId,
          reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
        });
      }
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

/** End an approved reopen window immediately after controlled work completes.
 * The original approval remains immutable; the actor, timestamp and reason for
 * ending the window are appended to the close event stream. */
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
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("approved reopen request not found");
    await recloseApprovedReopenRow({
      tx,
      row,
      actorId: args.actorId,
      reason,
      automatic: false,
    });
  });
}

export async function recloseExpiredReopens(actorId?: string): Promise<number> {
  // Finding expired reopen windows spans organizations and crosses an explicit
  // trusted boundary; each re-close then commits inside its own tenant. The
  // scheduler tick that calls this holds no request store, so without the
  // boundary RLS denies by default and no window is ever closed again.
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
    const didReclose = await withOrgContext(row.org_id, () =>
      db.transaction(async (tx) => {
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
  }
  return reclosed;
}
