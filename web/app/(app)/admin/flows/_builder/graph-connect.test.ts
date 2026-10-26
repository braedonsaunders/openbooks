import assert from "node:assert/strict";
import test from "node:test";
import type { Edge } from "@xyflow/react";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import {
  CANVAS_CONNECTION_MODE,
  autoWireEdge,
  buildConnectEdge,
  connectHandles,
  connectTargets,
  defaultGateRole,
  defaultNodeData,
  defaultTargetRow,
  type FlowNode,
} from "./graph";

// Pure unit suite for the single keyboard/pointer edge path
// (web/app/(app)/admin/flows/_builder/graph.ts): what each kind can
// connect from, which successors the picker may offer, and what the
// shared builder accepts or refuses.

const LABELS = { then: "then", else: "else", approve: "approve", reject: "reject" };

function node(id: string, kind: FlowNode["data"]["kind"]): FlowNode {
  const data = {
    trigger: { kind: "trigger", trigger: { trigger: "manual", buttonId: "btn", label: "Run" } },
    condition: { kind: "condition", rule: { op: "isSet", field: "status" } },
    action: {
      kind: "action",
      action: { action: "notify", to: [{ type: "submitter" }], title: "Hi" },
    },
    gate: {
      kind: "gate",
      gate: { title: "Approval", assignees: [{ type: "role", role: "approver" }], mode: "any" },
    },
  }[kind] as FlowNode["data"];
  return { id, position: { x: 0, y: 0 }, data };
}

const NODES = [
  node("t", "trigger"),
  node("c", "condition"),
  node("a", "action"),
  node("g", "gate"),
];

test("each kind exposes exactly the handles the canvas renders", () => {
  assert.deepEqual(connectHandles("trigger"), ["next"]);
  assert.deepEqual(connectHandles("action"), ["next"]);
  assert.deepEqual(connectHandles("condition"), ["then", "else"]);
  assert.deepEqual(connectHandles("gate"), ["approve", "reject"]);
});

test("the picker offers every step except the source and triggers", () => {
  // Triggers render no target handle: wiring into one would be a dead edge
  // the pointer path cannot even draw.
  assert.deepEqual(
    connectTargets("t", NODES).map((n) => n.id),
    ["c", "a", "g"],
  );
  assert.deepEqual(
    connectTargets("a", NODES).map((n) => n.id),
    ["c", "a", "g"].filter((id) => id !== "a"),
  );
  assert.deepEqual(connectTargets("only", [node("only", "trigger")]), []);
});

test("a keyboard connect builds the same edge a drag would", () => {
  const edge = buildConnectEdge({ source: "t", sourceHandle: "next", target: "a" }, NODES, LABELS);
  assert.ok(edge);
  assert.equal(edge.source, "t");
  assert.equal(edge.target, "a");
  assert.equal(edge.sourceHandle, "next");
  assert.equal(edge.label, undefined);

  const branch = buildConnectEdge(
    { source: "c", sourceHandle: "else", target: "g" },
    NODES,
    LABELS,
  );
  assert.ok(branch);
  assert.equal(branch?.sourceHandle, "else");
  assert.equal(branch?.label, "else");
});

test("the canvas accepts drops on the target node, not only its handle", () => {
  // React Flow Strict (the default) drops a drag that lands on a card body,
  // which is why wiring worked only through the side-panel Connect. Loose
  // finishes the drop on the node; the edge still validates through
  // buildConnectEdge exactly like a picked one.
  assert.equal(CANVAS_CONNECTION_MODE, "loose");
});

const PROFILE: FlowSubjectProfile = {
  subjectKind: "vendor_bill",
  label: "Vendor bill",
  triggers: ["on_submit"],
  actions: ["notify"],
  statuses: [],
  fields: [{ key: "total", label: "Total", type: "number" }],
  roles: ["admin", "accountant", "approver"],
};

function at(id: string, kind: FlowNode["data"]["kind"], x = 0): FlowNode {
  const n = node(id, kind);
  return { ...n, position: { x, y: 0 } };
}

function edge(source: string, target: string, sourceHandle = "next"): Edge {
  return { id: `e_${source}_${target}`, source, target, sourceHandle };
}

test("a palette add wires after the selected node", () => {
  const nodes = [at("t", "trigger"), at("g", "gate"), at("fresh", "action")];
  const edges = [edge("t", "g")];
  const wired = autoWireEdge("fresh", nodes, edges, "g", LABELS);
  assert.ok(wired);
  assert.equal(wired.source, "g");
  assert.equal(wired.target, "fresh");
  assert.equal(wired.sourceHandle, "approve");
});

test("a palette add with no selection extends the tail of a linear graph", () => {
  const nodes = [at("t", "trigger"), at("a", "action"), at("fresh", "gate")];
  const edges = [edge("t", "a")];
  const wired = autoWireEdge("fresh", nodes, edges, undefined, LABELS);
  assert.ok(wired);
  assert.equal(wired.source, "a");
  assert.equal(wired.target, "fresh");
  // The edge is one the pointer path would draw: it rebuilds through it.
  const rebuilt = buildConnectEdge(
    { source: wired.source, sourceHandle: wired.sourceHandle ?? "next", target: wired.target },
    nodes,
    LABELS,
  );
  assert.ok(rebuilt);
});

test("auto-wire takes the open branch of a condition first", () => {
  const nodes = [
    at("t", "trigger"),
    at("c", "condition"),
    at("a", "action"),
    at("fresh", "action"),
  ];
  const edges = [edge("t", "c"), edge("c", "a", "then")];
  const wired = autoWireEdge("fresh", nodes, edges, "c", LABELS);
  assert.ok(wired);
  assert.equal(wired.sourceHandle, "else");
  assert.equal(wired.label, "else");
});

test("auto-wire wires nothing for a trigger or an empty canvas", () => {
  assert.equal(
    autoWireEdge("fresh", [at("t", "trigger"), at("fresh", "trigger")], [], undefined, LABELS),
    null,
  );
  assert.equal(autoWireEdge("fresh", [at("fresh", "action")], [], undefined, LABELS), null);
});

test("a fresh gate defaults to one admin role with self-approval prevention on", () => {
  assert.equal(defaultGateRole(PROFILE), "admin");
  const data = defaultNodeData("gate", PROFILE);
  assert.equal(data.kind, "gate");
  if (data.kind !== "gate") return;
  assert.deepEqual(data.gate.assignees, [{ type: "role", role: "admin" }]);
  assert.equal(data.gate.preventSelfApproval, true);
});

test("a fresh gate on a profile without admins falls back to its first role", () => {
  const noAdmin: FlowSubjectProfile = { ...PROFILE, roles: ["accountant"] };
  assert.equal(defaultGateRole(noAdmin), "accountant");
  const data = defaultNodeData("gate", noAdmin);
  assert.equal(data.kind, "gate");
  if (data.kind !== "gate") return;
  assert.deepEqual(data.gate.assignees, [{ type: "role", role: "accountant" }]);
});

test("the submitter is never a default approver, but stays the message default", () => {
  assert.deepEqual(defaultTargetRow(PROFILE, false), { type: "role", role: "admin" });
  assert.deepEqual(defaultTargetRow(PROFILE, true), { type: "submitter" });
});

test("an invalid connect builds nothing", () => {
  // Self-connect.
  assert.equal(
    buildConnectEdge({ source: "a", sourceHandle: "next", target: "a" }, NODES, LABELS),
    null,
  );
  // Into a trigger (no target handle exists there).
  assert.equal(
    buildConnectEdge({ source: "a", sourceHandle: "next", target: "t" }, NODES, LABELS),
    null,
  );
  // A handle the source kind does not expose.
  assert.equal(
    buildConnectEdge({ source: "t", sourceHandle: "then", target: "a" }, NODES, LABELS),
    null,
  );
  // Unknown ids.
  assert.equal(
    buildConnectEdge({ source: "ghost", sourceHandle: "next", target: "a" }, NODES, LABELS),
    null,
  );
  assert.equal(
    buildConnectEdge({ source: "t", sourceHandle: "next", target: "ghost" }, NODES, LABELS),
    null,
  );
});
