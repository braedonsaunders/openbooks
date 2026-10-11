import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  consumeReopenRequestsForClosedModules,
  decidePeriodReopen,
  extendReopenRequest,
  recloseApprovedReopen,
  requestPeriodReopen,
} from "./reopening.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function requestStatus(orgId: string, requestId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from close_reopen_requests where id = ${requestId} and org_id = ${orgId}
  `)).rows[0]!.status;
}

test(
  "re-closing modules outside the re-close workflow ends the request and frees overlap",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      const first = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "Approved correction work" });
      await decidePeriodReopen({ orgId: org.orgId, requestId: first, actorId: actors.approver1Id, approve: true, hours: 2 });

      // The bookkeeper finishes and re-closes from Setup instead of the
      // re-close workflow: the lock flips, but the request still reads
      // approved until it is consumed.
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Correction work completed" });
      const { consumed } = await consumeReopenRequestsForClosedModules({
        ...target,
        actorId: actors.adminId,
        reason: "Correction work completed",
      });
      assert.deepEqual(consumed, [first]);
      assert.equal(await requestStatus(org.orgId, first), "reclosed");
      const events = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from close_events
         where org_id = ${org.orgId} and event_type = 'period.reopen_consumed_by_reclose'
           and payload->>'requestId' = ${first}
      `));
      assert.equal(events.rows[0]?.n, 1);

      // A new reopen for the same scope is accepted once the old window ends.
      const second = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "Follow-up correction work" });
      await decidePeriodReopen({ orgId: org.orgId, requestId: second, actorId: actors.approver1Id, approve: true, hours: 2 });
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
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      const first = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "First correction window" });
      await decidePeriodReopen({ orgId: org.orgId, requestId: first, actorId: actors.approver1Id, approve: true, hours: 2 });
      const second = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "Second correction window" });

      const error = await decidePeriodReopen({
        orgId: org.orgId, requestId: second, actorId: actors.approver2Id, approve: true, hours: 2,
      }).catch((failure: unknown) => failure);
      assert.ok(error instanceof CloseError);
      assert.match(error.message, /overlaps an active reopen/);
      assert.match(error.message, /GL reopen approved .* by Approver One, active until/);
      assert.match(error.message, /extend that request or widen its modules/);
      assert.doesNotMatch(error.message, UUID, "no bare request id in the refusal");
      assert.equal(await requestStatus(org.orgId, second), "requested");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a partial re-close leaves the request guarding its open modules",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      await setPeriodLockState({ ...target, module: "ap", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      const first = await requestPeriodReopen({ ...target, modules: ["gl", "ap"], actorId: actors.adminId, reason: "Two-module correction" });
      await decidePeriodReopen({ orgId: org.orgId, requestId: first, actorId: actors.approver1Id, approve: true, hours: 2 });

      await setPeriodLockState({ ...target, module: "ap", state: "closed", actorId: actors.adminId, reason: "AP work completed" });
      const { consumed } = await consumeReopenRequestsForClosedModules({
        ...target,
        actorId: actors.adminId,
        reason: "AP work completed",
      });
      assert.deepEqual(consumed, []);
      assert.equal(await requestStatus(org.orgId, first), "approved");

      const second = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "GL follow-up" });
      await assert.rejects(
        decidePeriodReopen({ orgId: org.orgId, requestId: second, actorId: actors.approver2Id, approve: true, hours: 2 }),
        /overlaps an active reopen/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an independent approver extends time and widens modules; the requester cannot extend",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      await setPeriodLockState({ ...target, module: "ap", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      const requestId = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "Correction window" });
      await decidePeriodReopen({ orgId: org.orgId, requestId, actorId: actors.approver1Id, approve: true, hours: 2 });
      const before = (await db.execute<{ expires_at: string }>(sql`
        select expires_at::text as expires_at from close_reopen_requests where id = ${requestId}
      `)).rows[0]!.expires_at;

      await assert.rejects(
        extendReopenRequest({
          orgId: org.orgId, requestId, actorId: actors.adminId,
          reason: "Requester tries to buy more time for their own window",
          additionalHours: 5,
        }),
        /independent approver/,
      );

      const extended = await extendReopenRequest({
        orgId: org.orgId, requestId, actorId: actors.approver2Id,
        reason: "Correction needs the weekend plus the AP module",
        additionalHours: 5,
        addModules: ["ap"],
      });
      assert.ok(extended.expiresAt > before, "expiry moves forward");
      assert.deepEqual([...extended.modules].sort(), ["ap", "gl"]);
      const stored = (await db.execute<{ expires_at: string; modules: string[] }>(sql`
        select expires_at::text as expires_at, modules from close_reopen_requests where id = ${requestId}
      `)).rows[0]!;
      assert.deepEqual([...stored.modules].sort(), ["ap", "gl"]);
      const events = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from close_events
         where org_id = ${org.orgId} and event_type = 'period.reopen_extended'
           and payload->>'requestId' = ${requestId}
      `));
      assert.equal(events.rows[0]?.n, 1);
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
      await setPeriodLockState({ ...target, module: "gl", state: "closed", actorId: actors.adminId, reason: "Close for review" });
      const first = await requestPeriodReopen({ ...target, modules: ["gl"], actorId: actors.adminId, reason: "First window" });
      await decidePeriodReopen({ orgId: org.orgId, requestId: first, actorId: actors.approver1Id, approve: true, hours: 2 });

      // Neither the uninvolved operator nor the permission-less requester
      // can end the window: the gate is the reopen permission, with a
      // remedy naming who can grant it.
      await assert.rejects(
        recloseApprovedReopen({
          orgId: org.orgId, requestId: first, actorId: actors.outsiderId, reason: "Uninvolved operator ends the window early",
        }),
        /requires the close reopen permission/,
      );
      await assert.rejects(
        recloseApprovedReopen({
          orgId: org.orgId, requestId: first, actorId: actors.adminId, reason: "Requester without the permission ends the window",
        }),
        /requires the close reopen permission/,
      );
      assert.equal(await requestStatus(org.orgId, first), "approved");

      // A permission-holding third party — neither requester nor approver —
      // ends the window with reason and audit.
      await db.execute(sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`);
      await recloseApprovedReopen({
        orgId: org.orgId, requestId: first, actorId: actors.approver2Id, reason: "Independent approver ends the window after re-closing",
      });
      assert.equal(await requestStatus(org.orgId, first), "reclosed");
      const audits = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'close_reopen_requests'
           and row_id = ${first} and action = 'end'
      `));
      assert.equal(audits.rows[0]?.n, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
