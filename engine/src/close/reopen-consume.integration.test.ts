import { decideReopenFixture, requestReviewedReopenFixture } from "../testing/close.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  consumeReopenRequestsForClosedModules,
  extendReopenRequest,
  recloseApprovedReopen,
  withdrawPeriodReopen,
} from "./reopening.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

test(
  "re-closing modules outside the re-close workflow ends the request and frees overlap",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
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
        reason: "Approved correction work",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });

      // The bookkeeper finishes and re-closes from Setup instead of the
      // re-close workflow: the lock flips, but the request still reads
      // approved until it is consumed.
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Correction work completed",
      });
      const { consumed } = await consumeReopenRequestsForClosedModules({
        ...target,
        actorId: actors.adminId,
        reason: "Correction work completed",
      });
      assert.deepEqual(consumed, [first]);
      assert.equal(await requestStatus(org.orgId, first), "reclosed");
      const events = await db.execute<{ n: number }>(
        sql`
        select count(*)::int as n from close_events
         where org_id = ${org.orgId} and event_type = 'period.reopen_consumed_by_reclose'
           and payload->>'requestId' = ${first}
      `,
        "objects",
      );
      assert.equal(events[0]?.n, 1);

      // A new reopen for the same scope is accepted once the old window ends.
      const second = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Follow-up correction work",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: second,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      assert.equal(await requestStatus(org.orgId, second), "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the overlap refusal names the blocking request in human terms, never a bare id",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const first = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl", "ap"],
        actorId: actors.adminId,
        reason: "First correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });

      // A request that leaves out a module of the active window is refused
      // when raised, naming the window and the supported remedy.
      const error = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Second correction window",
      }).catch((failure: unknown) => failure);
      assert.ok(error instanceof CloseError);
      assert.match(
        error.message,
        /approved reopen window for .*GL, AP is active; to widen or extend it/,
      );
      assert.doesNotMatch(error.message, UUID, "no bare request id in the refusal");

      // A request covering every module of the window widens or extends it:
      // an eligible approver decides it and its approval supersedes the window.
      const widened = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl", "ap"],
        actorId: actors.adminId,
        reason: "Extend the correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: widened,
        actorId: actors.approver2Id,
        decision: "approved",
        hours: 2,
      });
      assert.equal(await requestStatus(org.orgId, widened), "approved");
      assert.equal(await requestStatus(org.orgId, first), "superseded");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a partial re-close leaves the request guarding its open modules", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
    await setPeriodLockState({
      ...target,
      module: "gl",
      state: "closed",
      actorId: actors.adminId,
      reason: "Close for review",
    });
    await setPeriodLockState({
      ...target,
      module: "ap",
      state: "closed",
      actorId: actors.adminId,
      reason: "Close for review",
    });
    const first = await requestReviewedReopenFixture({
      ...target,
      modules: ["gl", "ap"],
      actorId: actors.adminId,
      reason: "Two-module correction",
    });
    await decideReopenFixture({
      orgId: org.orgId,
      requestId: first,
      actorId: actors.approver1Id,
      decision: "approved",
      hours: 2,
    });

    await setPeriodLockState({
      ...target,
      module: "ap",
      state: "closed",
      actorId: actors.adminId,
      reason: "AP work completed",
    });
    const { consumed } = await consumeReopenRequestsForClosedModules({
      ...target,
      actorId: actors.adminId,
      reason: "AP work completed",
    });
    assert.deepEqual(consumed, []);
    assert.equal(await requestStatus(org.orgId, first), "approved");

    await assert.rejects(
      requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "GL follow-up",
      }),
      /approved reopen window for .*GL, AP is active; to widen or extend it/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "an extension is requested separately and changes every covered lock only after independent approval",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(
        sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`,
      );
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      await setPeriodLockState({
        ...target,
        subsidiaryId: org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Entity close for review",
      });
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      const requestId = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      const before = (
        await db.execute<{ expires_at: Date; approved_by: string; modules: string[] }>(
          sql`
        select expires_at, approved_by, modules from close_reopen_requests where id = ${requestId}`,
          "objects",
        )
      )[0]!;
      const extension = await extendReopenRequest({
        orgId: org.orgId,
        requestId,
        actorId: actors.adminId,
        reason: "Correction needs five additional hours plus the AP module",
        additionalHours: 5,
        addModules: ["ap"],
      });
      assert.notEqual(extension.requestId, requestId);
      assert.equal(await requestStatus(org.orgId, extension.requestId), "requested");
      assert.equal(await requestStatus(org.orgId, requestId), "approved");
      assert.equal(
        new Date(extension.expiresAt).getTime(),
        new Date(before.expires_at).getTime() + 5 * 60 * 60 * 1000,
      );
      const pendingLocks = await db.execute<{
        module: string;
        state: string;
        expires_at: Date | null;
      }>(
        sql`
        select module, state, reopen_expires_at as expires_at from period_locks where org_id = ${org.orgId}`,
        "objects",
      );
      assert.equal(pendingLocks.find((lock) => lock.module === "ap")?.state, "closed");
      assert.ok(
        pendingLocks
          .filter((lock) => lock.module === "gl")
          .every(
            (lock) =>
              new Date(lock.expires_at!).getTime() === new Date(before.expires_at).getTime(),
          ),
      );
      await assert.rejects(
        decideReopenFixture({
          orgId: org.orgId,
          requestId: extension.requestId,
          actorId: actors.adminId,
          decision: "approved",
        }),
        /not an approver|self-approval|own submission/,
      );
      await assert.rejects(
        extendReopenRequest({
          orgId: org.orgId,
          requestId,
          actorId: actors.approver2Id,
          reason: "Another extension for the same scope",
          additionalHours: 1,
        }),
        /already awaiting a decision/,
      );
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: extension.requestId,
        actorId: actors.approver2Id,
        decision: "approved",
      });
      assert.equal(await requestStatus(org.orgId, extension.requestId), "approved");
      assert.equal(await requestStatus(org.orgId, requestId), "superseded");
      const original = (
        await db.execute<{
          expires_at: Date;
          approved_by: string;
          modules: string[];
          reclosed_at: Date | null;
        }>(
          sql`
        select expires_at, approved_by, modules, reclosed_at from close_reopen_requests where id = ${requestId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(original.modules, before.modules);
      assert.equal(original.approved_by, before.approved_by);
      assert.equal(new Date(original.expires_at).getTime(), new Date(before.expires_at).getTime());
      assert.equal(
        original.reclosed_at,
        null,
        "superseding a window does not claim its locks were closed",
      );
      const changedLocks = await db.execute<{ module: string; state: string; expires_at: Date }>(
        sql`
        select module, state, reopen_expires_at as expires_at from period_locks where org_id = ${org.orgId}`,
        "objects",
      );
      assert.equal(changedLocks.length, 3);
      assert.ok(
        changedLocks.every(
          (lock) =>
            lock.state === "open" &&
            new Date(lock.expires_at).toISOString() === extension.expiresAt,
        ),
      );
      const audit = await db.execute<{ action: string }>(
        sql`
        select action from audit_log where org_id = ${org.orgId} and table_name = 'close_reopen_requests'
         and row_id = ${extension.requestId} order by at`,
        "objects",
      );
      assert.deepEqual(
        audit.map((row) => row.action),
        ["request", "approve"],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "widening alone preserves expiry and rejection leaves the original window intact",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      await setPeriodLockState({
        ...target,
        module: "ap",
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
      const before = (
        await db.execute<{ expires_at: Date }>(
          sql`select expires_at from close_reopen_requests where id = ${first}`,
          "objects",
        )
      )[0]!;
      await assert.rejects(
        extendReopenRequest({
          orgId: org.orgId,
          requestId: first,
          actorId: actors.adminId,
          reason: "No actual scope or time change",
          additionalHours: 0,
          addModules: ["gl"],
        }),
        /must add time, modules, or both/,
      );
      for (const additionalHours of [undefined, 0]) {
        const pending = await extendReopenRequest({
          orgId: org.orgId,
          requestId: first,
          actorId: actors.adminId,
          reason: "Add AP without extending the window",
          addModules: ["ap"],
          additionalHours,
        });
        assert.equal(pending.expiresAt, new Date(before.expires_at).toISOString());
        await decideReopenFixture({
          orgId: org.orgId,
          requestId: pending.requestId,
          actorId: actors.approver1Id,
          decision: "rejected",
          reason: "The scope needs further review before it can be widened",
        });
        assert.equal(await requestStatus(org.orgId, first), "approved");
        assert.equal(await requestStatus(org.orgId, pending.requestId), "rejected");
      }
      const pending = await extendReopenRequest({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.adminId,
        reason: "AP correction is now ready for review",
        addModules: ["ap"],
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: pending.requestId,
        actorId: actors.approver1Id,
        decision: "approved",
      });
      const locks = await db.execute<{ expires_at: Date }>(
        sql`select reopen_expires_at as expires_at from period_locks where org_id = ${org.orgId}`,
        "objects",
      );
      assert.ok(
        locks.every(
          (lock) => new Date(lock.expires_at).getTime() === new Date(before.expires_at).getTime(),
        ),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an amendment cannot reactivate a window that was ended before approval",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(
        sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`,
      );
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
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
      const pending = await extendReopenRequest({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.adminId,
        reason: "More time requested for corrections",
        additionalHours: 1,
      });
      await recloseApprovedReopen({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver1Id,
        reason: "Corrections completed and period reclosed",
      });
      await assert.rejects(
        decideReopenFixture({
          orgId: org.orgId,
          requestId: pending.requestId,
          actorId: actors.approver2Id,
          decision: "approved",
        }),
        /original reopen window has ended or changed/,
      );
      assert.equal(await requestStatus(org.orgId, first), "reclosed");
      assert.equal(await requestStatus(org.orgId, pending.requestId), "requested");
      await withdrawPeriodReopen({
        orgId: org.orgId,
        requestId: pending.requestId,
        actorId: actors.adminId,
        reason: "The original correction work has completed",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "ending a window early requires the reopen permission, never identity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
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
        reason: "First window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });

      await db.execute(
        sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.adminId},'close.reopen','deny') on conflict(user_id,permission) do update set effect='deny'`,
      );
      // Neither the uninvolved operator nor the permission-less requester
      // can end the window: the gate is the reopen permission, with a
      // remedy naming who can grant it.
      await assert.rejects(
        recloseApprovedReopen({
          orgId: org.orgId,
          requestId: first,
          actorId: actors.outsiderId,
          reason: "Uninvolved operator ends the window early",
        }),
        /requires the close reopen permission/,
      );
      await assert.rejects(
        recloseApprovedReopen({
          orgId: org.orgId,
          requestId: first,
          actorId: actors.adminId,
          reason: "Requester without the permission ends the window",
        }),
        /requires the close reopen permission/,
      );
      assert.equal(await requestStatus(org.orgId, first), "approved");

      // A permission-holding third party — neither requester nor approver —
      // ends the window with reason and audit.
      await db.execute(
        sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`,
      );
      await recloseApprovedReopen({
        orgId: org.orgId,
        requestId: first,
        actorId: actors.approver2Id,
        reason: "Independent approver ends the window after re-closing",
      });
      assert.equal(await requestStatus(org.orgId, first), "reclosed");
      const audits = await db.execute<{ n: number }>(
        sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'close_reopen_requests'
           and row_id = ${first} and action = 'end'
      `,
        "objects",
      );
      assert.equal(audits[0]?.n, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent overlapping requests accept exactly one pending request",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        modules: ["gl"] as const,
      };
      const outcomes = await Promise.allSettled([
        requestReviewedReopenFixture({
          ...target,
          modules: [...target.modules],
          actorId: actors.adminId,
          reason: "First correction request",
        }),
        requestReviewedReopenFixture({
          ...target,
          modules: [...target.modules],
          actorId: actors.approver1Id,
          reason: "Second correction request",
        }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const refusal = outcomes.find(
        (outcome) => outcome.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(refusal.reason instanceof CloseError);
      assert.match(refusal.reason.message, /already awaiting a decision/);
      const saved = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from close_reopen_requests where org_id = ${org.orgId} and status = 'requested'`,
          "objects",
        )
      )[0]!;
      assert.equal(saved.n, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
