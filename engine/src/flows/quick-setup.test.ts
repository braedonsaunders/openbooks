import assert from "node:assert/strict";
import test from "node:test";
import { pinnedGateAllowsSelfApproval } from "./gate-policy.ts";
import { documentSubjectProfile } from "./subject-profiles.ts";
import { lintFlowGraphForSubject } from "./lint.ts";
import {
  QUICK_APPROVAL_FLOW_DESCRIPTION,
  buildQuickApprovalGraph,
  quickApprovalAmountField,
} from "./quick-setup.ts";

/**
 * One-step approval setup builds the whole wired graph (trigger → optional
 * threshold condition → gate) that the dialog persists through the native
 * save path. Lint-cleanliness here is the contract: the save route refuses
 * to leave an enabled flow warning-bearing, so a graph that lints dirty
 * could never be created enabled.
 */

const PROFILE = documentSubjectProfile("vendor_bill");

test("a subject with totals exposes its canonical amount field", () => {
  assert.equal(quickApprovalAmountField(PROFILE), "total");
});

test("no threshold builds a wired trigger → gate graph", () => {
  const built = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "role", role: "admin" },
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(
    built.graph.edges.map((edge) => [edge.source, edge.target, edge.sourceHandle]),
    [["trigger", "gate", "next"]],
  );
  const gate = built.graph.nodes.find((node) => node.id === "gate");
  assert.equal(gate?.data.kind, "gate");
  if (gate?.data.kind !== "gate") return;
  assert.deepEqual(gate.data.gate.assignees, [{ type: "role", role: "admin" }]);
  assert.equal(gate.data.gate.mode, "any");
  assert.equal(gate.data.gate.preventSelfApproval, true);
});

test("a threshold inserts a wired total condition between trigger and gate", () => {
  const built = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "user", userId: "u-1" },
    threshold: 10000,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.amountField, "total");
  assert.deepEqual(
    built.graph.edges.map((edge) => [edge.source, edge.target, edge.sourceHandle]),
    [
      ["trigger", "condition", "next"],
      ["condition", "gate", "then"],
    ],
  );
  const condition = built.graph.nodes.find((node) => node.id === "condition");
  assert.equal(condition?.data.kind, "condition");
  if (condition?.data.kind !== "condition") return;
  assert.deepEqual(condition.data.rule, {
    op: "gt",
    field: "total",
    value: 10000,
    valueType: "number",
  });
});

test("both shapes are lint-clean against the subject profile", () => {
  for (const input of [
    { approver: { type: "role", role: "admin" } as const },
    { approver: { type: "user", userId: "u-1" } as const, threshold: 10000 },
  ]) {
    const built = buildQuickApprovalGraph(PROFILE, input);
    assert.equal(built.ok, true);
    if (!built.ok) continue;
    const lint = lintFlowGraphForSubject("vendor_bill", built.graph, PROFILE);
    assert.deepEqual(lint.ok ? [] : lint.errors, []);
  }
});

test("the marker is a stable machine token the dialog can match exactly", () => {
  assert.equal(QUICK_APPROVAL_FLOW_DESCRIPTION, "quick-approval");
});

test("refusals name the remedy: bad threshold, amountless subject, unknown role/user", () => {
  const negative = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "role", role: "admin" },
    threshold: -5,
  });
  assert.equal(negative.ok, false);
  if (negative.ok) return;
  assert.equal(negative.code, "bad-threshold");

  const amountless = buildQuickApprovalGraph(
    { ...PROFILE, fields: PROFILE.fields.filter((field) => field.type !== "number") },
    { approver: { type: "role", role: "admin" }, threshold: 10 },
  );
  assert.equal(amountless.ok, false);
  if (amountless.ok) return;
  assert.equal(amountless.code, "no-amount-field");

  const role = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "role", role: "no-such-role" },
  });
  assert.equal(role.ok, false);
  if (role.ok) return;
  assert.equal(role.code, "unknown-role");

  const user = buildQuickApprovalGraph(
    PROFILE,
    { approver: { type: "user", userId: "ghost" } },
    new Set(["u-1"]),
  );
  assert.equal(user.ok, false);
  if (user.ok) return;
  assert.equal(user.code, "unknown-user");
});

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";

test("a selected legal entity becomes the graph's typed subject scope", () => {
  for (const input of [
    { approver: { type: "role", role: "admin" } as const, subsidiaryIds: [ENTITY_A.toUpperCase()] },
    {
      approver: { type: "user", userId: "u-1" } as const,
      threshold: 10,
      subsidiaryIds: [ENTITY_A, ENTITY_B],
    },
  ]) {
    const built = buildQuickApprovalGraph(PROFILE, input);
    assert.equal(built.ok, true);
    if (!built.ok) continue;
    // Stored canonical (lowercase) so runtime admission compares against
    // database uuid output without case drift.
    const expected = input.subsidiaryIds.map((id) => id.toLowerCase());
    assert.deepEqual(built.graph.subjectScope, { subsidiaryIds: expected });
    const gate = built.graph.nodes.find((node) => node.id === "gate");
    assert.equal(gate?.data.kind, "gate", "the scope never replaces the human gate");
    const lint = lintFlowGraphForSubject("vendor_bill", built.graph, PROFILE);
    assert.deepEqual(lint.ok ? [] : lint.errors, []);
  }
});

test("no legal entity selected keeps organization-wide scope absent, not aliased", () => {
  const built = buildQuickApprovalGraph(PROFILE, { approver: { type: "role", role: "admin" } });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.graph.subjectScope, undefined);
});

test("empty, blank and repeated legal entities are refused by name", () => {
  for (const subsidiaryIds of [
    [],
    [""],
    [ENTITY_A, ENTITY_A],
    [ENTITY_A, ENTITY_A.toUpperCase()],
  ]) {
    const built = buildQuickApprovalGraph(PROFILE, {
      approver: { type: "role", role: "admin" },
      subsidiaryIds,
    });
    assert.equal(built.ok, false, JSON.stringify(subsidiaryIds));
    if (built.ok) continue;
    assert.equal(built.code, "bad-subject-scope");
    assert.match(built.message, /legal entity/);
  }
});

test("invalid, mixed and overlength legal entities refuse through the shared graph schema", () => {
  const overlength = Array.from(
    { length: 101 },
    (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
  );
  for (const subsidiaryIds of [
    ["not-a-uuid"],
    [ENTITY_A, "not-a-uuid"],
    ["not-a-uuid", ENTITY_B],
    [` ${ENTITY_A} `],
    [ENTITY_A, 42 as unknown as string],
    overlength,
  ]) {
    const built = buildQuickApprovalGraph(PROFILE, {
      approver: { type: "role", role: "admin" },
      subsidiaryIds,
    });
    assert.equal(built.ok, false, JSON.stringify(subsidiaryIds).slice(0, 80));
    if (built.ok) continue;
    assert.equal(built.code, "bad-subject-scope");
  }
  // Exactly at the cap remains valid.
  const atCap = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "role", role: "admin" },
    subsidiaryIds: overlength.slice(0, 100),
  });
  assert.equal(atCap.ok, true);
});

test("self-approval prevention stays on unless the author explicitly opts out", () => {
  const off = buildQuickApprovalGraph(PROFILE, {
    approver: { type: "role", role: "admin" },
    preventSelfApproval: false,
  });
  assert.equal(off.ok, true);
  if (!off.ok) return;
  const gate = off.graph.nodes.find((node) => node.id === "gate");
  assert.equal(gate?.data.kind, "gate");
  if (gate?.data.kind !== "gate") return;
  assert.equal(gate.data.gate.preventSelfApproval, false);
  assert.equal(
    pinnedGateAllowsSelfApproval({ submissionPolicy: { graph: off.graph } }, gate.id),
    true,
  );
});
