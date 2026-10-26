import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as routing from "../platform/approval-routing.ts";
import type { ApprovalRoutingReceipt } from "../platform/approval-routing.ts";
import { registerDocumentApprovalFacts } from "./document-approval-facts.ts";
import { registerFlowCommandWithdrawalHandler } from "./approval-release-hook.ts";

test("native approval composition remains available across server module instances", async () => {
  const other = await import(
    new URL("../platform/approval-routing.ts?server-instance", import.meta.url).href
  );
  assert.notEqual(other.routeNativeApproval, routing.routeNativeApproval);
  const input = {
    orgId: randomUUID(),
    actorId: randomUUID(),
    subjectKind: "close_run",
    subjectId: randomUUID(),
  };
  const receipt: ApprovalRoutingReceipt = {
    submissionId: randomUUID(),
    gatingRunId: null,
    policy: { version: 1, trigger: "on_submit", kind: "ungated", flowIds: [], runIds: [] },
  };
  const seen: string[] = [];
  routing.registerApprovalRouter(async (command) => {
    assert.deepEqual(command, input);
    seen.push("submission");
    return receipt;
  });
  routing.registerApprovalDecisionReader(async (command) => {
    assert.equal(command.subjectId, input.subjectId);
    seen.push("decision");
    return { allowsSelfApproval: false };
  });
  routing.registerApprovalCanceller(async (command) => {
    assert.deepEqual(command, input);
    seen.push("cancellation");
  });
  routing.registerApprovalCommandRouter(async (command) => {
    assert.deepEqual(command.command, { action: "approve" });
    seen.push("command");
    return true;
  });
  assert.deepEqual(await other.routeNativeApproval(input), receipt);
  assert.deepEqual(await other.readNativeApprovalDecision({ ...input, outcome: "approved" }), {
    allowsSelfApproval: false,
  });
  await other.cancelNativeApprovals(input);
  assert.equal(
    await other.requestNativeCommandApproval({ ...input, command: { action: "approve" } }),
    true,
  );
  assert.deepEqual(seen, ["submission", "decision", "cancellation", "command"]);
  other.registerApprovalCommandRouter(async () => false);
  assert.equal(await routing.requestNativeCommandApproval({ ...input, command: {} }), false);
});

test("record facts and withdrawal projections share their installed server composition", async () => {
  const facts = await import(
    new URL("./document-approval-facts.ts?server-instance", import.meta.url).href
  );
  const releases = await import(
    new URL("./approval-release-hook.ts?server-instance", import.meta.url).href
  );
  const input = {
    orgId: randomUUID(),
    actorId: randomUUID(),
    subjectKind: "close_run",
    subjectId: randomUUID(),
    reason: "Review revised evidence",
  };
  const kind = randomUUID();
  registerDocumentApprovalFacts(kind, async (orgId, id) => ({ orgId, id, amount: "125.0000" }));
  assert.deepEqual(await facts.readDocumentApprovalFacts(kind, input.orgId, input.subjectId), {
    orgId: input.orgId,
    id: input.subjectId,
    amount: "125.0000",
  });
  const restored: string[] = [];
  registerFlowCommandWithdrawalHandler(input.subjectKind, async (command) => {
    assert.deepEqual(command, input);
    restored.push(command.subjectId);
  });
  await releases.withdrawFlowCommandSubject(input);
  assert.deepEqual(restored, [input.subjectId]);
});

test("financial change submission shares its installed server composition", async () => {
  const installed = await import("../platform/financial-changes.ts");
  const other = await import(
    new URL("../platform/financial-changes.ts?server-instance", import.meta.url).href
  );
  assert.notEqual(other.submitNativeFinancialChange, installed.submitNativeFinancialChange);
  const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
  const seen: string[][] = [];
  installed.registerFinancialChangeSubmission(async (...args) => {
    seen.push(args);
  });
  await other.submitNativeFinancialChange(...ids);
  assert.deepEqual([...seen], [[...ids]]);
  other.registerFinancialChangeSubmission(async (...args: string[]) => {
    seen.push(args);
  });
  await installed.submitNativeFinancialChange(...ids);
  assert.deepEqual([...seen], [[...ids], [...ids]]);
});
