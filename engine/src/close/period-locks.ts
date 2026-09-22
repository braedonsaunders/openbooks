import {
  CloseError,
  periodLockBlocksPosting,
  periodLockRequiresApprovedReopen,
  type CloseModule,
} from "./period-policy.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
export async function assertCloseScope(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds?: string[] | null;
  },
): Promise<void> {
  const requestedSubsidiaries = args.subsidiaryIds ?? [];
  const subsidiaryCount = requestedSubsidiaries.length
    ? sql`(select count(*)::int from subsidiaries where org_id = ${args.orgId} and is_active
        and id in (${sql.join(
          requestedSubsidiaries.map((id) => sql`${id}`),
          sql`, `,
        )}))`
    : sql`0`;
  const scope = (await executor.execute<{
      period_ok: boolean;
      book_ok: boolean;
      subsidiaries_found: number;
    }>(sql`
    select
      exists(select 1 from accounting_periods where id = ${args.periodId} and org_id = ${args.orgId}) as period_ok,
      exists(select 1 from accounting_books where id = ${args.bookId} and org_id = ${args.orgId} and is_active) as book_ok,
      ${subsidiaryCount} as subsidiaries_found
  `));
  const row = scope.rows[0];
  if (!row?.period_ok) throw new CloseError("period not found");
  if (!row.book_ok) throw new CloseError("active accounting book not found");
  const requested = new Set(requestedSubsidiaries);
  if (
    requested.size !== requestedSubsidiaries.length ||
    Number(row.subsidiaries_found) !== requested.size
  ) {
    throw new CloseError("one or more close-scope subsidiaries are invalid");
  }
}

export async function upsertLock(args: {
  tx: SqlExecutor;
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  module: CloseModule;
  state: "open" | "soft_closed" | "closed";
  actorId?: string;
  reason: string;
  reopenExpiresAt?: Date;
}): Promise<void> {
  // Snapshot the current lock first: an upsert overwrites the only record of
  // who locked this scope and why, so every transition is mirrored into the
  // audit trail (in the same transaction) with before/after period state.
  const prior = (await args.tx.execute<{
    id: string;
    state: string;
    locked_at: Date | null;
    locked_by: string | null;
    reason: string | null;
    reopen_expires_at: Date | null;
    version: number;
  }>(sql`
    select id, state, locked_at, locked_by, reason, reopen_expires_at, version
      from period_locks
     where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}
       and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
       and module = ${args.module}
     for update`));
  const after = (await args.tx.execute<{
    id: string;
    state: string;
    locked_at: Date | null;
    locked_by: string | null;
    reason: string | null;
    reopen_expires_at: Date | null;
  }>(sql`
    insert into period_locks
      (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by,
       reason, reopen_expires_at, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${args.module}, ${args.state},
            ${args.state === "closed" ? sql`now()` : sql`null`}, ${args.actorId ?? null}, ${args.reason},
            ${args.reopenExpiresAt?.toISOString() ?? null}, ${args.actorId ?? null}, ${args.actorId ?? null})
    on conflict (org_id, period_id, book_id, subsidiary_id, module) do update set
      state = excluded.state, locked_at = excluded.locked_at, locked_by = excluded.locked_by,
      reason = excluded.reason, reopen_expires_at = excluded.reopen_expires_at,
      version = period_locks.version + 1, updated_at = now(), updated_by = excluded.updated_by
    where period_locks.org_id = ${args.orgId}
    returning id, state, locked_at, locked_by, reason, reopen_expires_at`));
  const row = requireLockWriteRow(after.rows[0]);
  const periodState = {
    periodId: args.periodId,
    bookId: args.bookId,
    subsidiaryId: args.subsidiaryId ?? null,
    module: args.module,
    state: row.state,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    reason: row.reason,
    reopenExpiresAt: row.reopen_expires_at,
  };
  const existing = prior.rows[0];
  if (!existing) {
    await args.tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'period_locks', ${row.id}, 'insert',
              ${JSON.stringify({ after: periodState })}::jsonb, ${args.actorId ?? null})
    `);
    return;
  }
  const unchanged =
    existing.state === row.state &&
    Number(existing.locked_at ?? 0) === Number(row.locked_at ?? 0) &&
    existing.locked_by === row.locked_by &&
    existing.reason === row.reason &&
    Number(existing.reopen_expires_at ?? 0) === Number(row.reopen_expires_at ?? 0);
  if (unchanged) return;
  await args.tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'period_locks', ${row.id}, 'update',
            ${JSON.stringify({
              before: { ...periodState, state: existing.state, lockedAt: existing.locked_at, lockedBy: existing.locked_by, reason: existing.reason, reopenExpiresAt: existing.reopen_expires_at },
              after: periodState,
            })}::jsonb, ${args.actorId ?? null})
  `);
}

/** Serialize every lock-state transition for one period and book, including
 * the close-run and controlled-reopen writers, so a scoped relaxation can
 * never interleave between an effective close check and its commit.
 *
 * This is also the EXCLUSIVE side of the close/posting fence: the kernel's
 * je_guard takes the SHARED side of this exact key before every GL-period
 * check (period_posting_fence, migration 0022) and holds it to commit, so an
 * in-flight journal posting either commits before a close's final refresh or
 * is rejected by the trigger after the locks flip to 'closed'. */
export function periodScopeAdvisoryLock(executor: SqlExecutor, orgId: string, periodId: string, bookId: string): Promise<unknown> {
  return executor.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`period-lock:${orgId}:${periodId}:${bookId}`}, 0)
    )`);
}

/** A lock upsert that matches no row did not persist. Callers must not
 * treat the requested state as stored — no later read can observe it. */
export function requireLockWriteRow<T>(row: T | undefined): T {
  if (row) return row;
  throw new CloseError(
    "period lock write returned no row — the lock was not persisted; confirm the period, book, and organization still exist and retry",
  );
}

/** Administrative lock control used by Setup. A hard-closed scope can only
 * be reopened through the independently approved reopen-case workflow.
 * Soft-close fences posting and is released from Setup without that case. */
export async function setPeriodLockState(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  module: CloseModule;
  state: "open" | "soft_closed" | "closed";
  actorId: string;
  reason: string;
}): Promise<void> {
  if (!args.reason.trim())
    throw new CloseError("a lock-state reason is required");
  await db.transaction(async (tx) => {
    await periodScopeAdvisoryLock(tx, args.orgId, args.periodId, args.bookId);
    await assertCloseScope(tx, {
      ...args,
      subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
    });
    const current = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
      select state, reopen_expires_at from period_locks where org_id = ${args.orgId} and period_id = ${args.periodId}
        and book_id = ${args.bookId} and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
        and module = ${args.module} for update`));
    // Storage evaluates the exact row before the org-wide fallback row, so a
    // relaxation here shadows any stronger lock above it. Refuse whenever the
    // effective governing lock (this exact row, else the org-wide row for the
    // same module) currently forbids writes, or when the targeted row carries
    // an active approved reopen window whose expiry a rewrite would erase.
    const governing = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
      select state, reopen_expires_at from period_locks where org_id = ${args.orgId} and period_id = ${args.periodId}
        and book_id = ${args.bookId} and module = ${args.module}
        and (${args.subsidiaryId ? sql`subsidiary_id = ${args.subsidiaryId} or ` : sql``}subsidiary_id is null)
      order by (subsidiary_id is not null) desc limit 1`));
    if (
      args.state !== "closed" &&
      periodLockRequiresApprovedReopen(
        governing.rows[0] && {
          state: governing.rows[0].state,
          reopenExpiresAt: governing.rows[0].reopen_expires_at,
          reason: null,
        },
      )
    ) {
      throw new CloseError(
        "closed periods must be reopened through an approved reopen request",
      );
    }
    if (
      args.state !== "closed" &&
      current.rows[0]?.state === "open" &&
      current.rows[0].reopen_expires_at != null &&
      new Date(current.rows[0].reopen_expires_at) > new Date()
    ) {
      throw new CloseError(
        "an active reopen window must be ended through the controlled re-close workflow",
      );
    }
    if (args.module === "gl" && args.state === "closed") {
      const openSubledgers = (await tx.execute<{ module: string }>(sql`
        select module from period_locks
         where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}
           and subsidiary_id is not distinct from ${args.subsidiaryId ?? null}
           and module <> 'gl' and state <> 'closed'`));
      if (openSubledgers.rows.length > 0) {
        throw new CloseError(
          `close ${openSubledgers.rows.map((row) => row.module.toUpperCase()).join(", ")} before GL`,
        );
      }
    }
    if (args.module !== "gl" && args.state !== "closed") {
      const gl = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
        select state, reopen_expires_at from period_locks where org_id = ${args.orgId} and period_id = ${args.periodId}
          and book_id = ${args.bookId} and module = 'gl'
          and (${args.subsidiaryId ? sql`subsidiary_id = ${args.subsidiaryId} or ` : sql``}subsidiary_id is null)
        order by (subsidiary_id is not null) desc limit 1`));
      const glLock = gl.rows[0] && {
        state: gl.rows[0].state,
        reopenExpiresAt: gl.rows[0].reopen_expires_at,
        reason: null,
      };
      // Opening a subledger while GL already fences posting is a no-op for
      // journals (assertPeriodModulesOpen always includes GL) and a lie in
      // Setup. Soft-closing under a hard-closed GL still needs reopen.
      if (
        (args.state === "open" && periodLockBlocksPosting(glLock, false)) ||
        (args.state === "soft_closed" && periodLockRequiresApprovedReopen(glLock))
      )
        throw new CloseError(
          "GL must be reopened before a subledger can be opened",
        );
    }
    await upsertLock({ ...args, tx, reason: args.reason.trim() });
    if (!args.subsidiaryId && args.state === "closed") {
      // A scope-wide close must dominate every narrower lock: storage prefers
      // the exact row, so each remaining child lock is tightened in the same
      // transaction (mirrored into the audit trail) instead of being shadowed.
      const children = (await tx.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from period_locks
         where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}
           and module = ${args.module} and subsidiary_id is not null and state <> 'closed'
         for update`));
      for (const child of children.rows) {
        await upsertLock({
          tx,
          orgId: args.orgId,
          periodId: args.periodId,
          bookId: args.bookId,
          subsidiaryId: child.subsidiary_id,
          module: args.module,
          state: "closed",
          actorId: args.actorId,
          reason: args.reason.trim(),
        });
      }
    }
    await tx.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.lock_changed', ${args.actorId},
              ${JSON.stringify({ periodId: args.periodId, bookId: args.bookId, subsidiaryId: args.subsidiaryId ?? null, module: args.module, state: args.state, reason: args.reason.trim() })}::jsonb)`);
  });
}
