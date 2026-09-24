import { CloseError, CLOSE_MODULES } from "./period-policy.ts";
import { advancedCloseEnabled } from "./features.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db } from "../platform/db.ts";
import { refreshCloseRun, runCloseAutomations } from "./run-automation.ts";
import { upsertLock, periodScopeAdvisoryLock } from "./period-locks.ts";
export async function closeApprovedRun(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const target = (await tx.execute<{ period_id: string; book_id: string }>(sql`
      select period_id, book_id from close_runs where id = ${runId} and org_id = ${orgId}`));
    if (!target.rows[0]) throw new CloseError("close run not found");
    // Take the exclusive side of the close/posting fence BEFORE the final
    // refresh. The kernel's je_guard holds the shared side across every
    // posting's [period check -> commit] window, so from this point until
    // commit no journal write can start, and any posting already in flight
    // must commit before the refresh below re-reads the ledger: its activity
    // is either fully evaluated by this close or rejected once these locks
    // commit. Refreshing outside this fence (the old order) is exactly the
    // race that let a posting commit after approval evidence was frozen.
    await periodScopeAdvisoryLock(tx, orgId, target.rows[0].period_id, target.rows[0].book_id);
    await refreshCloseRun(orgId, runId, actorId);
    const run = (await tx.execute<{
        period_id: string;
        book_id: string;
        status: string;
        scope: { subsidiaryIds?: string[] };
      }>(sql`
      select period_id, book_id, status, scope from close_runs
       where id = ${runId} and org_id = ${orgId} for update`));
    const row = run.rows[0];
    if (!row) throw new CloseError("close run not found");
    if (row.status !== "approved")
      throw new CloseError(
        "the close run requires approval or an owner attestation before locking",
      );
    const blockers = (await tx.execute<{ count: string }>(sql`
      select count(*) as count from close_exceptions
       where run_id = ${runId} and org_id = ${orgId} and status = 'open' and severity in ('error','critical')`));
    if (Number(blockers.rows[0]!.count) > 0)
      throw new CloseError(
        "critical exceptions reappeared after approval; review the run again",
      );

    const scopes = row.scope?.subsidiaryIds?.length
      ? row.scope.subsidiaryIds
      : [undefined];
    for (const subsidiaryId of scopes) {
      for (const module of CLOSE_MODULES.filter((item) => item !== "gl")) {
        await upsertLock({
          tx,
          orgId,
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryId,
          module,
          state: "closed",
          actorId,
          reason: `Close run ${runId}`,
        });
        if (subsidiaryId === undefined) {
          // Storage prefers an exact subsidiary row over the org-wide
          // fallback. Tighten every existing child row in the same close
          // transaction or an older open child lock would shadow this new
          // org-wide lock and keep accepting postings.
          const children = (await tx.execute<{ subsidiary_id: string }>(sql`
            select subsidiary_id
              from period_locks
             where org_id = ${orgId}
               and period_id = ${row.period_id}
               and book_id = ${row.book_id}
               and module = ${module}
               and subsidiary_id is not null
               and state <> 'closed'
             for update`));
          for (const child of children.rows) {
            await upsertLock({
              tx,
              orgId,
              periodId: row.period_id,
              bookId: row.book_id,
              subsidiaryId: child.subsidiary_id,
              module,
              state: "closed",
              actorId,
              reason: `Close run ${runId}`,
            });
          }
        }
      }
      await upsertLock({
        tx,
        orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId,
        module: "gl",
        state: "closed",
        actorId,
        reason: `Close run ${runId}`,
      });
      if (subsidiaryId === undefined) {
        const children = (await tx.execute<{ subsidiary_id: string }>(sql`
          select subsidiary_id
            from period_locks
           where org_id = ${orgId}
             and period_id = ${row.period_id}
             and book_id = ${row.book_id}
             and module = 'gl'
             and subsidiary_id is not null
             and state <> 'closed'
           for update`));
        for (const child of children.rows) {
          await upsertLock({
            tx,
            orgId,
            periodId: row.period_id,
            bookId: row.book_id,
            subsidiaryId: child.subsidiary_id,
            module: "gl",
            state: "closed",
            actorId,
            reason: `Close run ${runId}`,
          });
        }
      }
    }
    await tx.execute(sql`
      update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and key in ('lock-subledgers','lock-gl')`);
    await tx.execute(sql`
      update close_runs set status = 'closed', current_stage = 'publish', closed_at = now(),
             closed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.closed', ${actorId}, ${JSON.stringify({ modules: CLOSE_MODULES })}::jsonb)`);
  });
  await runCloseAutomations({
    orgId,
    runId,
    trigger: "run_closed",
    eventKey: `run:${runId}:closed`,
    actorId,
  });
}

export async function publishCloseRun(
  orgId: string,
  runId: string,
  actorId: string,
  comment?: string,
): Promise<void> {
  if (!(await advancedCloseEnabled(orgId))) {
    throw new CloseError("enable Advanced close controls to publish a close package");
  }
  await db.transaction(async (tx) => {
    const run = (await tx.execute<{
      status: string;
      data_fingerprint: string | null;
      binder_snapshot: unknown | null;
      binder_hash: string | null;
      published_at: string | null;
      published_by: string | null;
      publish_count: string;
    }>(sql`
      select status, data_fingerprint, binder_snapshot, binder_hash, published_at::text, published_by::text,
             (select count(*) from close_events e
               where e.org_id = ${orgId} and e.run_id = ${runId} and e.event_type = 'run.published') as publish_count
        from close_runs where id = ${runId} and org_id = ${orgId} for update`));
    if (!run.rows[0]) throw new CloseError("close run not found");
    if (run.rows[0].status !== "closed")
      throw new CloseError(
        "the period must be closed before its package can be published",
      );
    // A re-publication after a controlled reopen is a restatement, never a
    // silent overwrite: the previously published binder is retained as run
    // evidence BEFORE the snapshot is replaced, and the new publication must
    // carry a restatement note. Without this the original package became
    // unrecoverable the moment the corrected one froze.
    const prior = run.rows[0];
    const version = Number(prior.publish_count) + 1;
    const restatementNote = comment?.trim() ? comment.trim() : null;
    if (prior.binder_hash !== null && restatementNote === null) {
      throw new CloseError(
        "a restatement note is required to re-publish a corrected package",
      );
    }
    if (prior.binder_hash !== null) {
      await tx.execute(sql`
        insert into close_events (org_id, run_id, event_type, actor_id, payload)
        values (${orgId}, ${runId}, 'package.superseded', ${actorId},
                ${JSON.stringify({
                  version: version - 1,
                  superseded_hash: prior.binder_hash,
                  superseded_frozen_at: (prior.binder_snapshot as { frozenAt?: string } | null)?.frozenAt ?? null,
                  published_at: prior.published_at,
                  published_by: prior.published_by,
                  restatement_note: restatementNote,
                  binder_snapshot: prior.binder_snapshot,
                })}::jsonb)`);
    }
    await tx.execute(sql`
      update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${actorId},
             data_fingerprint = ${run.rows[0].data_fingerprint}, updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and key = 'publish-package'`);
    await tx.execute(sql`
      update close_runs set status = 'published', current_stage = 'publish', published_at = now(),
             published_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into close_signoffs (org_id, run_id, signoff_type, decision, comment, data_fingerprint, signed_by)
      values (${orgId}, ${runId}, 'publish', 'approved', ${comment ?? null}, ${run.rows[0].data_fingerprint}, ${actorId})`);
    await tx.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.published', ${actorId}, ${JSON.stringify({ comment: comment ?? null })}::jsonb)`);
    // Sequential binder reads, never Promise.all: this publish runs inside
    // one transaction (one pg client), where concurrent queries interleave
    // on the single connection — deprecated by pg and fatal in pg 9.
    const publishedRun = await tx.execute(sql`select r.*, p.name as period_name, p.starts_on, p.ends_on, b.code as book_code, b.name as book_name,
        bp.name as blueprint_name, bp.version as blueprint_version, pkg.name as package_name, pkg.reports as package_reports
        from close_runs r join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
        join close_blueprints bp on bp.id = r.blueprint_id and bp.org_id = r.org_id left join close_reporting_packages pkg on pkg.id = r.reporting_package_id and pkg.org_id = r.org_id
        where r.id = ${runId} and r.org_id = ${orgId}`);
    const tasks = await tx.execute(
      sql`select * from close_run_tasks where run_id = ${runId} and org_id = ${orgId} order by sort_order, id`,
    );
    const evidence = await tx.execute(
      sql`select * from close_task_evidence where run_id = ${runId} and org_id = ${orgId} order by created_at, id`,
    );
    const exceptions = await tx.execute(
      sql`select * from close_exceptions where run_id = ${runId} and org_id = ${orgId} order by created_at, id`,
    );
    const signoffs = await tx.execute(
      sql`select * from close_signoffs where run_id = ${runId} and org_id = ${orgId} order by signed_at, id`,
    );
    const events = await tx.execute(
      sql`select * from close_events where run_id = ${runId} and org_id = ${orgId} order by at, id`,
    );
    const locks = await tx.execute(sql`select * from period_locks where org_id = ${orgId} and period_id = (select period_id from close_runs where id = ${runId} and org_id = ${orgId})
        and book_id = (select book_id from close_runs where id = ${runId} and org_id = ${orgId}) order by subsidiary_id nulls first, module`);
    const snapshot = {
      format: "openbooks.close-binder.v1",
      // Package versioning: the first publication is version 1; every
      // re-publication after a controlled reopen increments it, links the
      // version it replaces, and carries the mandatory restatement note, so
      // the downloaded binder visibly states that it restates an earlier
      // package (whose full content survives in the package.superseded event).
      version,
      supersedes: prior.binder_hash,
      restatementNote: version > 1 ? restatementNote : null,
      frozenAt: new Date().toISOString(),
      run: publishedRun.rows[0],
      tasks: tasks.rows,
      evidence: evidence.rows,
      exceptions: exceptions.rows,
      signoffs: signoffs.rows,
      events: events.rows,
      locks: locks.rows,
    };
    const binderHash = createHash("sha256")
      .update(canonicalJson(snapshot), "utf8")
      .digest("hex");
    await tx.execute(sql`
      update close_runs set binder_snapshot = ${JSON.stringify(snapshot)}::jsonb, binder_hash = ${binderHash}
       where id = ${runId} and org_id = ${orgId}`);
  });

  // Deliver the reporting package once the publish has durably committed (a
  // Redis enqueue isn't transactional with the DB, and delivery must never fire
  // for a rolled-back publish). Best-effort: the worker itself skips manual
  // cadence / no recipients, and a queue outage must not fail publication.
  const packageRow = (await db.execute<{ reporting_package_id: string | null }>(sql`
    select reporting_package_id from close_runs where id = ${runId} and org_id = ${orgId}`));
  const packageId = packageRow.rows[0]?.reporting_package_id;
  if (packageId) {
    try {
      const { enqueueCloseDelivery } = await import("@openbooks/jobs");
      // No fixed jobId: every publication is its own delivery obligation. A
      // run-scoped id would collide with the first publication's (possibly
      // completed) job, and BullMQ answers a repeated id with the ORIGINAL
      // job instead of queueing — so a corrected re-publication after a
      // controlled reopen would silently never deliver. Double publication
      // needs no idempotence key: the status guard above admits exactly one
      // publish per close, and concurrent publishers serialize on the run row.
      // The publisher travels as the send principal the render route
      // re-authorizes (see CloseDeliveryJobData.senderId).
      await enqueueCloseDelivery({ orgId, runId, packageId, senderId: actorId });
    } catch (error) {
      console.error("[close] failed to enqueue package delivery:", error);
    }
  }
}
