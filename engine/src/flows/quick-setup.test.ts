import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(gate.data.gate.preventSelfApproval, undefined);
});
