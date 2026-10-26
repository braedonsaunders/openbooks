import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  grantScratchPermissions,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import {
  requestPeriodReopen,
  submitPeriodReopen,
  recloseApprovedReopen,
  withdrawPeriodReopen,
} from "./reopening.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };
async function fixture(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>) {
  installEngineSeams();
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "gl",
      state: "closed",
      actorId: actors.adminId,
      reason: "Close the period before its governed correction",
    });
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
function request(org: ScratchOrg, actorId: string, hours = 2) {
  return requestPeriodReopen({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    modules: ["gl"],
    actorId,
    reason: "Correct the retained original-period accounting evidence",
    hours,
  });
}
async function gates(orgId: string, id: string) {
  return await db.execute<{ id: string; status: string }>(
    sql`select id,status from flow_gates where org_id=${orgId} and subject_kind='close_reopen_request' and subject_id=${id} order by id`,
    "objects",
  );
}
async function status(orgId: string, id: string) {
  return (
    await db.execute<{ status: string }>(
      sql`select status from close_reopen_requests where org_id=${orgId} and id=${id}`,
      "objects",
    )
  )[0]?.status;
}

test(
  "zero-gate reopen releases immediately without an attestation or another eligible person",
  DB,
  async () =>
    fixture(async (org, actors) => {
      const id = await request(org, actors.adminId);
      assert.equal(await status(org.orgId, id), "approved");
      assert.deepEqual(await gates(org.orgId, id), []);
      const receipt = (
        await db.execute<{ kind: string; hours: number }>(
          sql`select policy->>'kind' as kind,(context->'command'->>'hours')::integer as hours from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        )
      )[0];
      assert.deepEqual(receipt, { kind: "ungated", hours: 2 });
      const audit = await db.execute<{ action: string; actor_id: string; routing: string }>(
        sql`select action,actor_id,changes->'after'->>'routing' as routing from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${id} and action='release'`,
        "objects",
      );
      assert.deepEqual(audit, [
        { action: "release", actor_id: actors.adminId, routing: "ungated" },
      ]);
      await recloseApprovedReopen({
        orgId: org.orgId,
        requestId: id,
        actorId: actors.adminId,
        reason: "The correction is complete; close its access window",
      });
      assert.equal(await status(org.orgId, id), "reclosed");
      const ended = (
        await db.execute<{ reason: string; actor_id: string }>(
          sql`select coalesce(changes->'after'->>'reason',changes->>'reason') as reason,actor_id from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${id} and action='end'`,
          "objects",
        )
      )[0];
      assert.equal(ended?.actor_id, actors.adminId);
      assert.match(ended?.reason ?? "", /correction is complete/);
    }),
);

test("every tenant reopen Flow must finish before any period lock opens", DB, async () =>
  fixture(async (org, actors) => {
    for (let i = 0; i < 10; i++)
      await seedApprovalFlow(org.orgId, {
        subjectKind: "close_reopen_request",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
        preventSelfApproval: true,
      });
    const id = await request(org, actors.adminId);
    const pending = await gates(org.orgId, id);
    assert.equal(pending.length, 10);
    await assert.rejects(
      decideGate({
        gateId: pending[0]!.id,
        userId: actors.adminId,
        decision: "approved",
      }),
      /not an approver|own submission/,
    );
    for (const [index, gate] of pending.entries()) {
      await decideGate({
        gateId: gate.id,
        userId: actors.approver1Id,
        decision: "approved",
      });
      assert.equal(await status(org.orgId, id), index === 9 ? "approved" : "requested");
      if (index < 9)
        assert.equal(
          (
            await db.execute<{ state: string }>(
              sql`select state from period_locks where org_id=${org.orgId} and period_id=${org.periodId} and module='gl' and subsidiary_id is null`,
              "objects",
            )
          )[0]?.state,
          "closed",
        );
    }
  }),
);

test("a tenant may permit the requester to decide its own assigned reopen gate", DB, async () =>
  fixture(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "close_reopen_request",
      assignees: [{ type: "user", userId: actors.adminId }],
      mode: "all",
      preventSelfApproval: false,
    });
    const id = await request(org, actors.adminId);
    const [gate] = await gates(org.orgId, id);
    assert.ok(gate);
    await decideGate({
      gateId: gate.id,
      userId: actors.adminId,
      decision: "approved",
    });
    assert.equal(await status(org.orgId, id), "approved");
    const audit = (
      await db.execute<{ routing: string; attestation: unknown }>(
        sql`select changes->'after'->>'routing' as routing,changes->'after'->'attestation' as attestation from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${id} and action='approve'`,
        "objects",
      )
    )[0];
    assert.equal(audit?.routing, "gated");
    assert.equal(audit?.attestation, null);
  }),
);

test(
  "withdrawal is owned by the requester, validates its reason and invalidates all pending decisions atomically",
  DB,
  async () =>
    fixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "close_reopen_request",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const id = await request(org, actors.adminId);
      const [gate] = await gates(org.orgId, id);
      assert.ok(gate);
      for (const reason of ["too short", "x".repeat(501)])
        await assert.rejects(
          withdrawPeriodReopen({
            orgId: org.orgId,
            requestId: id,
            actorId: actors.adminId,
            reason,
          }),
          /10-500 character/,
        );
      await assert.rejects(
        withdrawPeriodReopen({
          orgId: org.orgId,
          requestId: id,
          actorId: actors.approver1Id,
          reason: "The reviewer cannot recall another actor’s request",
        }),
        /Only the requester/,
      );
      assert.equal(await status(org.orgId, id), "requested");
      await withdrawPeriodReopen({
        orgId: org.orgId,
        requestId: id,
        actorId: actors.adminId,
        reason: "The correction is no longer needed; retain the closed period",
      });
      assert.equal(await status(org.orgId, id), "withdrawn");
      assert.ok((await gates(org.orgId, id)).every((g) => g.status === "cancelled"));
      await assert.rejects(
        decideGate({
          gateId: gate.id,
          userId: actors.approver1Id,
          decision: "approved",
        }),
        /resolved/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${id} and action='withdraw'`,
            "objects",
          )
        ).length,
        1,
      );
    }),
);

test(
  "rejection preserves its reason and a refused decision leaves the gate pending",
  DB,
  async () =>
    fixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "close_reopen_request",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const id = await request(org, actors.adminId);
      const [gate] = await gates(org.orgId, id);
      assert.ok(gate);
      for (const comment of [undefined, "short"])
        await assert.rejects(
          decideGate({
            gateId: gate.id,
            userId: actors.approver1Id,
            decision: "rejected",
            comment,
          }),
          /10-500 character/,
        );
      assert.equal((await gates(org.orgId, id))[0]?.status, "pending");
      const comment = "The requested access exceeds the correction work to be performed";
      await decideGate({
        gateId: gate.id,
        userId: actors.approver1Id,
        decision: "rejected",
        comment,
      });
      assert.equal(await status(org.orgId, id), "rejected");
      const audit = await db.execute<{ reason: string }>(
        sql`select changes->'after'->>'decisionReason' as reason from audit_log where org_id=${org.orgId} and table_name='close_reopen_requests' and row_id=${id} and action='reject'`,
        "objects",
      );
      assert.deepEqual(audit, [{ reason: comment }]);
    }),
);

test(
  "reopen duration and graph are frozen while current native permission is rechecked at the decision",
  DB,
  async () =>
    fixture(async (org, actors) => {
      const { flowId } = await seedApprovalFlow(org.orgId, {
        subjectKind: "close_reopen_request",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const id = await request(org, actors.adminId, 2);
      const [gate] = await gates(org.orgId, id);
      assert.ok(gate);
      await assert.rejects(
        submitPeriodReopen({
          orgId: org.orgId,
          requestId: id,
          actorId: actors.adminId,
          hours: 3,
        }),
        /window is frozen/,
      );
      await db.execute(
        sql`update flows set enabled=false,graph='{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb where org_id=${org.orgId} and id=${flowId}`,
      );
      await db.execute(
        sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.approver1Id},'close.reopen','deny')`,
      );
      await assert.rejects(
        decideGate({
          gateId: gate.id,
          userId: actors.approver1Id,
          decision: "approved",
        }),
      );
      assert.equal(await status(org.orgId, id), "requested");
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["close.reopen"]);
      await decideGate({
        gateId: gate.id,
        userId: actors.approver1Id,
        decision: "approved",
      });
      const result = (
        await db.execute<{ hours: string }>(
          sql`select extract(epoch from(expires_at-approved_at))/3600 as hours from close_reopen_requests where org_id=${org.orgId} and id=${id}`,
          "objects",
        )
      )[0];
      assert.ok(result);
      assert.ok(
        Math.abs(Number(result.hours) - 2) < 1 / 3600,
        "the frozen two-hour window is retained to within one second",
      );
    }),
);
