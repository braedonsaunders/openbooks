import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { requestPeriodReopen } from "../close/reopening.ts";
import { decideGate } from "../flows/gates.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { seedApprovalFlow, assertFixtureDatabase } from "./fixtures.ts";

/** Financial lifecycle scenarios explicitly configure their tenant review before submission. */
export async function requestReviewedReopenFixture(
  input: Parameters<typeof requestPeriodReopen>[0],
) {
  installEngineSeams();
  return withOrgTransaction(input.orgId, async () => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"fixture-reopen-review:" + input.orgId},0))`,
    );
    const existing = await db.execute(
      sql`select id from flows where org_id=${input.orgId} and subject_kind='close_reopen_request' and enabled`,
      "objects",
    );
    if (!existing.length) {
      const users = await db.execute<{ id: string }>(
        sql`select id from users where org_id=${input.orgId} and is_active and id<>${input.actorId} order by id`,
        "objects",
      );
      const assignees: Array<{ type: "user"; userId: string }> = [];
      for (const user of users)
        if (await actorHasPermission(db, input.orgId, user.id, "close.reopen"))
          assignees.push({ type: "user", userId: user.id });
      if (!assignees.length)
        throw new Error("The reviewed reopen scenario must declare an authorized reviewer.");
      await seedApprovalFlow(input.orgId, {
        subjectKind: "close_reopen_request",
        assignees,
        mode: "any",
        preventSelfApproval: true,
      });
    }
    return requestPeriodReopen({ ...input, hours: input.hours ?? 2 });
  });
}

/** Decide the real configured gate, preserving native rollback, scope and audit behavior. */
export async function decideReopenFixture(input: {
  orgId: string;
  requestId: string;
  actorId: string;
  decision: "approved" | "rejected";
  hours?: number;
  reason?: string;
}) {
  const gates = await db.execute<{
    id: string;
    flow_id: string;
    assignee_user_id: string | null;
  }>(
    sql`select id,flow_id,assignee_user_id from flow_gates
    where org_id=${input.orgId} and subject_kind='close_reopen_request' and subject_id=${input.requestId} and status='pending' order by id`,
    "objects",
  );
  const gate = gates.find((g) => g.assignee_user_id === input.actorId) ?? gates[0];
  if (!gate) throw new Error("pending reopen request not found");
  const result = await decideGate({
    gateId: gate.id,
    userId: input.actorId,
    decision: input.decision,
    comment: input.reason,
  });
  return result;
}

/** Seed retained decision evidence for tests of later locking and publication.
 * Readiness tests use the native request command and their actual task lifecycle. */
export async function seedCloseRunApprovalFixture(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<void> {
  await assertFixtureDatabase();
  installEngineSeams();
  const { routeSubjectSubmission } = await import("../flows/submission-policy.ts");
  const { lockApprovalSubject } = await import("../platform/approval-routing.ts");
  await withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "close_run", runId);
    const staged = await db.execute(
      sql`update close_runs set status='review',current_stage='review',approved_at=null,approved_by=null,
      updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${runId} and status in('in_progress','review','approved') returning id`,
      "objects",
    );
    if (staged.length !== 1) throw new Error("The fixture close run is not available for review.");
    const routing = await routeSubjectSubmission({
      orgId,
      subjectKind: "close_run",
      subjectId: runId,
      actorId,
      command: { action: "approve" },
    });
    if (routing.policy.kind !== "ungated")
      throw new Error(
        "This fixture requires a zero-gate close policy; approval lifecycle tests must decide their configured gates.",
      );
    const saved = await db.execute(
      sql`update close_runs set status='approved',current_stage='lock',approved_at=now(),approved_by=${actorId},
      updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${runId} and status='review' returning id`,
      "objects",
    );
    if (saved.length !== 1) throw new Error("The fixture close decision was not retained.");
  });
}
