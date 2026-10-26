import { decideReopenFixture, requestReviewedReopenFixture } from "../testing/close.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { consumeReopenRequestsForClosedModules, recloseApprovedReopen } from "./reopening.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The exact reconciliation body shipped as the forward migration for stale
 * reopen windows. It ends approved, unexpired windows whose every covered
 * module is already closed at its governing lock — the spent windows a
 * pre-consume re-close left behind — setting the same row fields the
 * re-close path sets and recording one audit row per window with a system
 * reason. Windows still guarding open modules are untouched, and a rerun
 * matches nothing.
 */
const RECONCILE_STALE_REOPEN_WINDOWS = `
WITH ended AS (
  UPDATE public.close_reopen_requests AS r
     SET status = 'reclosed',
         reclosed_at = now(),
         updated_at = now(),
         updated_by = NULL
   WHERE r.status = 'approved'
     AND r.expires_at > now()
     AND jsonb_array_length(r.modules) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(r.modules) AS m(module)
        WHERE COALESCE((
          SELECT l.state
            FROM public.period_locks AS l
           WHERE l.org_id = r.org_id
             AND l.period_id = r.period_id
             AND l.book_id = r.book_id
             AND l.module = m.module
             AND (l.subsidiary_id IS NOT DISTINCT FROM r.subsidiary_id OR l.subsidiary_id IS NULL)
           ORDER BY (l.subsidiary_id IS NOT NULL) DESC
           LIMIT 1
        ), '') NOT IN ('closed', 'soft_closed')
     )
  RETURNING r.id, r.org_id, r.period_id, r.book_id, r.subsidiary_id, r.modules, r.reason
)
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT e.org_id,
       'close_reopen_requests',
       e.id,
       'end',
       jsonb_build_object(
         'before', jsonb_build_object('status', 'approved'),
         'after', jsonb_build_object('status', 'reclosed'),
         'scope', jsonb_build_object(
           'periodId', e.period_id,
           'bookId', e.book_id,
           'subsidiaryId', e.subsidiary_id,
           'modules', e.modules),
         'reason', 'Reconciliation ended this reopen window: every covered module is already closed, so the window no longer guards live work.',
         'requestReason', e.reason
       ),
       NULL
  FROM ended AS e
`;

async function requestStatus(orgId: string, requestId: string): Promise<string> {
  return (
    await db.execute<{ status: string }>(
      sql`
    select status from close_reopen_requests where id = ${requestId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0]!.status;
}

async function endAuditCount(orgId: string, requestId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'close_reopen_requests'
       and row_id = ${requestId} and action = 'end'
  `,
      "objects",
    )
  )[0]!.n;
}

test(
  "reconciliation ends stale approved windows with one audit row each and leaves live windows alone",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
      };
      // The live control window sits in a subsidiary scope: closing GL
      // refuses while any same-scope subledger is open, so a same-scope
      // live window would make the stale re-close unarrangeable.
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const stale = await requestReviewedReopenFixture({
        ...target,
        modules: ["ap"],
        actorId: actors.adminId,
        reason: "Stale correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: stale,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await setPeriodLockState({
        ...target,
        subsidiaryId: org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const live = await requestReviewedReopenFixture({
        ...target,
        subsidiaryId: org.subsidiaryId,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Live correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: live,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });

      // A re-close from Setup that predates the consume hook: the lock
      // flips but the window still reads approved — the stale state the
      // reconciliation exists to clear.
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Correction work completed",
      });
      assert.equal(await requestStatus(org.orgId, stale), "approved");

      await db.execute(sql.raw(RECONCILE_STALE_REOPEN_WINDOWS));
      assert.equal(await requestStatus(org.orgId, stale), "reclosed");
      const ended = (
        await db.execute<{
          reclosed_at: string | null;
          updated_by: string | null;
        }>(
          sql`
        select reclosed_at::text as reclosed_at, updated_by::text as updated_by
          from close_reopen_requests where id = ${stale} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0]!;
      assert.ok(ended.reclosed_at, "the re-close fields are set");
      assert.equal(ended.updated_by, null, "a system reconciliation names no actor");
      assert.equal(await endAuditCount(org.orgId, stale), 1, "one audit row per ended window");
      const auditReason = (
        await db.execute<{ reason: string }>(
          sql`
        select changes->>'reason' as reason from audit_log
         where org_id = ${org.orgId} and table_name = 'close_reopen_requests'
           and row_id = ${stale} and action = 'end'
      `,
          "objects",
        )
      )[0]!.reason;
      assert.match(auditReason, /every covered module is already closed/);

      // The window still guarding open AP work is untouched.
      assert.equal(await requestStatus(org.orgId, live), "approved");
      assert.equal(await endAuditCount(org.orgId, live), 0);

      // Idempotent: a rerun ends nothing new and audits nothing new.
      await db.execute(sql.raw(RECONCILE_STALE_REOPEN_WINDOWS));
      assert.equal(await endAuditCount(org.orgId, stale), 1);
      assert.equal(await requestStatus(org.orgId, live), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the overlap guard admits a new reopen once reconciliation ends the stale window",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
      };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const stale = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Stale correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: stale,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Correction work completed",
      });

      await db.execute(sql.raw(RECONCILE_STALE_REOPEN_WINDOWS));
      assert.equal(await requestStatus(org.orgId, stale), "reclosed");

      // The replacement window over the same scope approves: no live
      // window blocks it anymore.
      const next = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Follow-up correction work",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: next,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      assert.equal(await requestStatus(org.orgId, next), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reconciliation and the engine consume path end the same stale windows",
  { skip: !DB },
  async () => {
    async function buildStalePlusLive() {
      const org = await createScratchOrg();
      const actors = await seedFlowActors(org.orgId);
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
      };
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const stale = await requestReviewedReopenFixture({
        ...target,
        modules: ["ap"],
        actorId: actors.adminId,
        reason: "Stale correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: stale,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await setPeriodLockState({
        ...target,
        subsidiaryId: org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const live = await requestReviewedReopenFixture({
        ...target,
        subsidiaryId: org.subsidiaryId,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Live correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: live,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Correction work completed",
      });
      return { org, actors, stale, live };
    }
    const first = await buildStalePlusLive();
    const second = await buildStalePlusLive();
    try {
      // The engine path first: it ends exactly the stale window and audits
      // through the close event stream.
      const { consumed } = await consumeReopenRequestsForClosedModules({
        orgId: second.org.orgId,
        periodId: second.org.periodId,
        bookId: second.org.bookId,
        actorId: second.actors.adminId,
        reason: "Correction work completed",
      });
      assert.deepEqual(consumed, [second.stale]);
      assert.equal(await requestStatus(second.org.orgId, second.stale), "reclosed");
      assert.equal(await requestStatus(second.org.orgId, second.live), "approved");

      // The reconciliation then agrees on the identical fixtures: the
      // other stale window ends with its audit row, both live windows
      // stay approved, and nothing new happens on the consumed side.
      await db.execute(sql.raw(RECONCILE_STALE_REOPEN_WINDOWS));
      assert.equal(await requestStatus(first.org.orgId, first.stale), "reclosed");
      assert.equal(await endAuditCount(first.org.orgId, first.stale), 1);
      assert.equal(await requestStatus(first.org.orgId, first.live), "approved");
      assert.equal(await requestStatus(second.org.orgId, second.live), "approved");
      assert.equal(await endAuditCount(second.org.orgId, second.live), 0);
    } finally {
      await dropScratchOrg(first.org.orgId);
      await dropScratchOrg(second.org.orgId);
    }
  },
);

test(
  "ending a window with a short reason fails closed and leaves it approved",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
      };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const first = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await db.execute(
        sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`,
      );
      const error = await recloseApprovedReopen({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver2Id,
        reason: "too short",
      }).catch((failure: unknown) => failure);
      assert.ok(error instanceof CloseError);
      assert.match(error.message, /10-500 character/);
      assert.equal(await requestStatus(org.orgId, first), "approved");
      assert.equal(await endAuditCount(org.orgId, first), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
