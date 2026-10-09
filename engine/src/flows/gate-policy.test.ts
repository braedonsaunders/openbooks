import assert from "node:assert/strict";
import test from "node:test";
import { pinnedGateAllowsSelfApproval } from "./gate-policy.ts";

function context(preventSelfApproval?: boolean) {
  return { submissionPolicy: { graph: { schemaVersion: 1, nodes: [{
    id: "approval", position: { x: 0, y: 0 }, data: { kind: "gate", gate: {
      title: "Approve", assignees: [{ type: "supervisor" }], mode: "any",
      ...(preventSelfApproval === undefined ? {} : { preventSelfApproval }),
    } },
  }], edges: [] } } };
}

test("self-approval requires an explicit valid policy on the exact frozen gate", () => {
  assert.equal(pinnedGateAllowsSelfApproval(context(false), "approval"), true);
  for (const candidate of [context(true), context(), null, {},
    { submissionPolicy: { graph: { nodes: [] } } }]) {
    assert.equal(pinnedGateAllowsSelfApproval(candidate, "approval"), false);
  }
  assert.equal(pinnedGateAllowsSelfApproval(context(false), "another-gate"), false);
});

test("editing an authored graph does not change an earlier submission policy", () => {
  const frozen = structuredClone(context(false));
  const authored = context(false);
  authored.submissionPolicy.graph.nodes[0]!.data.gate.preventSelfApproval = true;
  assert.equal(pinnedGateAllowsSelfApproval(frozen, "approval"), true);
  assert.equal(pinnedGateAllowsSelfApproval(authored, "approval"), false);
});
