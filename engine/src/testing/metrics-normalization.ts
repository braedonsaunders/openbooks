import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import {
  getNormalizationRequest,
  approveAndExecuteNormalizationRequest,
} from "../billing/metrics/metrics-normalization-service.ts";
import { assertFixtureDatabase, grantScratchPermissions, seedApprovalFlow } from "./fixtures.ts";

export interface NormalizationFlowFixture {
  org: { orgId: string };
  requester: string;
  approver: string;
}

/** Financial correction fixtures use the same tenant-authored gates as the application. */
export async function prepareNormalizationFlowFixture(
  ctx: NormalizationFlowFixture,
  options: { gates?: number; allowSelfApproval?: boolean } = {},
): Promise<void> {
  await assertFixtureDatabase();
  installEngineSeams();
  for (const actorId of [ctx.requester, ctx.approver])
    await grantScratchPermissions(ctx.org.orgId, actorId, ["usage.manage"]);
  for (let index = 0; index < (options.gates ?? 1); index++)
    await seedApprovalFlow(ctx.org.orgId, {
      subjectKind: "metrics_normalization",
      assignees: [
        { type: "user", userId: options.allowSelfApproval ? ctx.requester : ctx.approver },
      ],
      mode: "all",
      preventSelfApproval: !options.allowSelfApproval,
    });
}

export async function normalizationGateIds(
  ctx: NormalizationFlowFixture,
  requestId: string,
): Promise<string[]> {
  return withOrgContext(ctx.org.orgId, async () =>
    (
      await db.execute<{ id: string }>(
        sql`select id from flow_gates
    where org_id=${ctx.org.orgId} and subject_kind='metrics_normalization' and subject_id=${requestId}
      and status='pending' order by created_at,id`,
        "objects",
      )
    ).map((row) => row.id),
  );
}

/** Complete actual native decisions, then resolve the authoritative request and result. */
export async function completeNormalizationFlowFixture(
  ctx: NormalizationFlowFixture,
  requestId: string,
  actorId = ctx.approver,
) {
  const before = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId });
  if (before.status === "succeeded")
    return approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId,
      approverId: actorId,
    });
  const gates = await normalizationGateIds(ctx, requestId);
  assert.ok(gates.length > 0, "the correction must retain its configured native gates");
  for (const gateId of gates) await decideGate({ gateId, userId: actorId, decision: "approved" });
  const request = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId });
  assert.equal(request.status, "succeeded");
  assert.ok(request.result);
  return { request, result: request.result };
}

export async function executeNormalizationFlowFixture(
  ctx: NormalizationFlowFixture,
  requestId: string,
) {
  return (await completeNormalizationFlowFixture(ctx, requestId)).result;
}
