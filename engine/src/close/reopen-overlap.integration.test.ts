import { decideReopenFixture, requestReviewedReopenFixture } from "../testing/close.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { recloseApprovedReopen, recloseExpiredReopens, withdrawPeriodReopen } from "./reopening.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";

for (const order of ["global first", "entity first", "race", "separate entities"] as const) {
  test(
    `reopen approvals refuse intersecting global/entity scopes: ${order}`,
    { skip: !process.env.OPENBOOKS_DB_URL },
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
        const other = randomUUID();
        if (order === "separate entities")
          await db.execute(
            sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Second entity','CAD','CA')`,
          );
        const scopes =
          order === "separate entities"
            ? [org.subsidiaryId, other]
            : order === "entity first"
              ? [org.subsidiaryId, undefined]
              : [undefined, org.subsidiaryId];
        const request = (subsidiaryId: string | undefined) =>
          requestReviewedReopenFixture({
            ...target,
            subsidiaryId,
            modules: ["gl"],
            actorId: actors.adminId,
            reason: "Approved correction work",
          });
        const approve = (id: string) =>
          decideReopenFixture({
            orgId: org.orgId,
            requestId: id,
            actorId: actors.approver1Id,
            decision: "approved",
            hours: 2,
          });
        if (order === "race" || order === "separate entities") {
          // Intersecting scopes raised together: exactly one request is
          // accepted; disjoint entities both are.
          const results = await Promise.allSettled(scopes.map(request));
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            order === "race" ? 1 : 2,
          );
          if (order === "race")
            assert.ok(
              results.some(
                (r) =>
                  r.status === "rejected" &&
                  r.reason instanceof CloseError &&
                  /awaiting a decision/.test(r.reason.message),
              ),
            );
          for (const result of results)
            if (result.status === "fulfilled") await approve(result.value);
        } else {
          // The intersecting second request is refused when raised, not at
          // the approver's step.
          const first = await request(scopes[0]);
          await assert.rejects(
            request(scopes[1]),
            (error: unknown) =>
              error instanceof CloseError && /awaiting a decision/.test(error.message),
          );
          await approve(first);
          await assert.rejects(
            request(scopes[1]),
            (error: unknown) =>
              error instanceof CloseError &&
              /approved reopen window .* is active; to widen or extend it/.test(error.message),
          );
        }
        const statuses = (
          await db.execute<{ status: string }>(
            sql`select status from close_reopen_requests where org_id=${org.orgId} order by created_at,id`,
            "objects",
          )
        )
          .map((r) => r.status)
          .sort();
        assert.deepEqual(
          statuses,
          order === "separate entities" ? ["approved", "approved"] : ["approved"],
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

test(
  "reopen approval refuses a scope with no closed locks",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      // The period is fully open: a window here would arm a lock row that
      // blocks posting once its expiry passes, then re-closes an open period.
      const mistakenId = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Mistaken window on an open period",
      });
      await assert.rejects(
        decideReopenFixture({
          orgId: org.orgId,
          requestId: mistakenId,
          actorId: actors.approver1Id,
          decision: "approved",
          hours: 2,
        }),
        /nothing to reopen/,
      );
      const locks = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from period_locks where org_id=${org.orgId}`,
        "objects",
      );
      assert.equal(locks[0]!.n, 0, "a refused reopen must arm no lock row");
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_reopen_requests where id=${mistakenId}`,
            "objects",
          )
        )[0]!.status,
        "requested",
      );

      // A request that mixes a closed module with an open one is refused the
      // same way: the open module's window would be pure time bomb. Narrowing
      // the request to the closed module still approves.
      await setPeriodLockState({
        ...target,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "AP closed",
      });
      // A request that can never be approved is withdrawn before the corrected
      // one is raised: overlapping requests are refused when raised.
      await withdrawPeriodReopen({
        orgId: org.orgId,
        requestId: mistakenId,
        actorId: actors.adminId,
        reason: "Raised on an open period by mistake",
      });
      const mixedId = await requestReviewedReopenFixture({
        ...target,
        modules: ["ap", "gl"],
        actorId: actors.adminId,
        reason: "AP correction plus unneeded GL",
      });
      await assert.rejects(
        decideReopenFixture({
          orgId: org.orgId,
          requestId: mixedId,
          actorId: actors.approver1Id,
          decision: "approved",
          hours: 2,
        }),
        /nothing to reopen/,
      );
      await withdrawPeriodReopen({
        orgId: org.orgId,
        requestId: mixedId,
        actorId: actors.adminId,
        reason: "Narrowing to the closed module only",
      });
      const narrowId = await requestReviewedReopenFixture({
        ...target,
        modules: ["ap"],
        actorId: actors.adminId,
        reason: "AP correction only",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: narrowId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_reopen_requests where id=${narrowId}`,
            "objects",
          )
        )[0]!.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an org-wide reopen window covers subsidiary-scoped locks and re-closes them",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      // Post-tightening state: the subsidiary row and the org-wide row are
      // both closed. Storage prefers the exact row, so a window written only
      // to the org-wide row would silently leave this entity closed.
      await setPeriodLockState({
        ...target,
        subsidiaryId: org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Entity close",
      });
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Global close",
      });
      const requestId = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Global correction window",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      await assertPeriodModulesOpen(db, {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryIds: [org.subsidiaryId],
        modules: ["gl"],
      });
      // Ending the window must re-close the subsidiary row it relaxed: an
      // open child shadows the re-closed scope and keeps posting. Ending is
      // permission-gated, so the approver holds the reopen permission here.
      await db.execute(
        sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`,
      );
      await recloseApprovedReopen({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        reason: "Correction work completed",
      });
      await assert.rejects(
        assertPeriodModulesOpen(db, {
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryIds: [org.subsidiaryId],
          modules: ["gl"],
        }),
        /GL is closed/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "subledger reopening requires GL in scope at request time, with the approval check as backstop",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({
        ...target,
        subsidiaryId: org.subsidiaryId,
        module: "ap",
        state: "closed",
        actorId: actors.adminId,
        reason: "AP closed",
      });
      // GL is still open, so the AP-only request is accepted at creation.
      const requestId = await requestReviewedReopenFixture({
        ...target,
        subsidiaryId: org.subsidiaryId,
        modules: ["ap"],
        actorId: actors.adminId,
        reason: "AP correction without GL",
      });
      // The inherited global GL close lands between request and decision: the
      // approval-time check stays as the backstop and the request stays pending.
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      await assert.rejects(
        decideReopenFixture({
          orgId: org.orgId,
          requestId,
          actorId: actors.approver1Id,
          decision: "approved",
          hours: 2,
        }),
        /GL must be included/,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_reopen_requests where org_id=${org.orgId} and id=${requestId}`,
            "objects",
          )
        )[0]!.status,
        "requested",
      );
      // Creation-time validation: with GL closed, an AP-only request is refused
      // with the remedy instead of stranding the approver with Reject as the
      // only path forward.
      await assert.rejects(
        requestReviewedReopenFixture({
          ...target,
          subsidiaryId: org.subsidiaryId,
          modules: ["ap"],
          actorId: actors.adminId,
          reason: "AP correction without GL",
        }),
        /include General ledger in the reopen scope/,
      );
      // The remedy works: the stranded request is withdrawn and the widened
      // request is accepted and approves.
      await withdrawPeriodReopen({
        orgId: org.orgId,
        requestId,
        actorId: actors.adminId,
        reason: "Replaced by a request that includes GL",
      });
      const widenedId = await requestReviewedReopenFixture({
        ...target,
        subsidiaryId: org.subsidiaryId,
        modules: ["ap", "gl"],
        actorId: actors.adminId,
        reason: "AP correction with GL",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId: widenedId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_reopen_requests where org_id=${org.orgId} and id=${widenedId}`,
            "objects",
          )
        )[0]!.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "tenant Flow decisions retain period involvement as audit evidence without a separate override",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId),
        doc = randomUUID();
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      await setPeriodLockState({
        ...target,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "Close for review",
      });
      await db.execute(sql`insert into documents(id,org_id,subsidiary_id,kind,status,document_number,document_date,posting_date,posting_period_id,currency,subtotal,tax_total,total,created_by,submitted_by)
   values(${doc},${org.orgId},${org.subsidiaryId},'customer_invoice','approved',${doc},${org.date},${org.date},${org.periodId},'CAD','10','0','10',${actors.approver1Id},${actors.approver1Id})`);
      const requestId = await requestReviewedReopenFixture({
        ...target,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Correct the original period",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        decision: "approved",
      });
      const audit = await db.execute<{
        changes: {
          after: { conflicts: { kind: string; count: number }[]; conflictAcknowledged?: unknown };
        };
      }>(
        sql`select changes from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${requestId} and action='approve'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.ok(
        audit[0]!.changes.after.conflicts.some(
          (row) => row.kind === "authored_documents" && row.count > 0,
        ),
      );
      assert.equal(Object.hasOwn(audit[0]!.changes.after, "conflictAcknowledged"), false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent expiry ticks count each re-closed window once",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // Regression: recloseExpiredReopens returned the candidate count, so two
    // ticks racing the same windows summed to double the real re-closes. Only
    // committed re-closes count: the losing tick's lock finds no approved row.
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const target = { orgId: org.orgId, periodId: org.periodId, bookId: org.bookId };
      const other = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Second entity','CAD','CA')`,
      );
      const ids: string[] = [];
      for (const subsidiaryId of [org.subsidiaryId, other]) {
        for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
          await setPeriodLockState({
            ...target,
            subsidiaryId,
            module,
            state: "closed",
            actorId: actors.adminId,
            reason: "Close for review",
          });
        }
        const id = await requestReviewedReopenFixture({
          ...target,
          subsidiaryId,
          modules: ["gl"],
          actorId: actors.adminId,
          reason: "Correction window",
        });
        await decideReopenFixture({
          orgId: org.orgId,
          requestId: id,
          actorId: actors.approver1Id,
          decision: "approved",
          hours: 2,
        });
        ids.push(id);
      }
      await db.execute(
        sql`update close_reopen_requests set expires_at = now() - interval '1 hour' where id = any(${`{${ids.join(",")}}`}::uuid[])`,
      );
      const [first, second] = await Promise.all([recloseExpiredReopens(), recloseExpiredReopens()]);
      assert.equal(
        first + second,
        2,
        "two concurrent ticks re-close exactly the two expired windows between them",
      );
      assert.ok(first <= 2 && second <= 2, "no tick reports windows it did not re-close");
      const statuses = (
        await db.execute<{ status: string }>(
          sql`select status from close_reopen_requests where id = any(${`{${ids.join(",")}}`}::uuid[])`,
          "objects",
        )
      )
        .map((r) => r.status)
        .sort();
      assert.deepEqual(statuses, ["reclosed", "reclosed"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an expired reopen blocked by an open subledger does not stop other expiries",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const other = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values (${other},${org.orgId},${org.subsidiaryId},'Second entity','CAD','CA')`);
      const ids = new Map<string, string>();
      for (const subsidiaryId of [org.subsidiaryId, other]) {
        await setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId,
          module: "gl",
          state: "closed",
          actorId: actors.adminId,
          reason: "Close for review",
        });
        const id = await requestReviewedReopenFixture({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId,
          modules: ["gl"],
          actorId: actors.adminId,
          reason: "Approved correction window",
        });
        await decideReopenFixture({
          orgId: org.orgId,
          requestId: id,
          actorId: actors.approver1Id,
          decision: "approved",
          hours: 2,
        });
        ids.set(subsidiaryId, id);
      }
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        module: "ap",
        state: "open",
        actorId: actors.adminId,
        reason: "AP remains open for review",
      });
      await db.execute(sql`update close_reopen_requests set expires_at=now()-interval '1 hour'
      where org_id=${org.orgId} and id=any(${`{${[...ids.values()].join(",")}}`}::uuid[])`);

      assert.equal(await recloseExpiredReopens(), 1);
      const states = await db.execute<{ id: string; status: string }>(
        sql`select id,status from close_reopen_requests
      where org_id=${org.orgId} and id=any(${`{${[...ids.values()].join(",")}}`}::uuid[])`,
        "objects",
      );
      assert.equal(states.find((row) => row.id === ids.get(org.subsidiaryId))?.status, "approved");
      assert.equal(states.find((row) => row.id === ids.get(other))?.status, "reclosed");
      const blocked = await db.execute<{ payload: { requestId: string; reason: string } }>(
        sql`select payload from close_events
      where org_id=${org.orgId} and event_type='period.reopen_expiry_blocked'`,
        "objects",
      );
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.payload.requestId, ids.get(org.subsidiaryId));
      assert.match(blocked[0]!.payload.reason, /AP remains open/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
