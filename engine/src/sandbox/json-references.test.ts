import assert from "node:assert/strict";
import test from "node:test";
import {
  validateClonedFlowGraphScope,
  remapRoleRestriction,
  remapScopeFilter,
} from "./json-references.ts";

const ids = {
  subsidiaries: new Map([
    ["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ]),
  departments: new Map([
    ["22222222-2222-4222-8222-222222222222", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  ]),
};

test("remapScopeFilter keeps absent and null pins, maps both identities case-insensitively", () => {
  assert.deepEqual(remapScopeFilter({}, ids, "t"), {});
  assert.deepEqual(
    remapScopeFilter({ employer_subsidiary_id: null, department_id: null }, ids, "t"),
    { employer_subsidiary_id: null, department_id: null },
  );
  assert.deepEqual(
    remapScopeFilter(
      {
        employer_subsidiary_id: "11111111-1111-4111-8111-111111111111".toUpperCase(),
        department_id: "22222222-2222-4222-8222-222222222222",
      },
      ids,
      "t",
    ),
    {
      employer_subsidiary_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      department_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  );
});

const flowCounterparts = new Set([
  "abcdefab-abcd-4bcd-8bcd-abcdefabcdef",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
]);

function scopedFlowGraph(subsidiaryIds: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ungatedOutcome: "apply",
    subjectScope: { subsidiaryIds, note: "kept verbatim" },
    nodes: [
      {
        id: "trigger",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: "on_submit" } },
      },
      {
        id: "gate",
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: { title: "Approval", assignees: [{ type: "role", role: "admin" }], mode: "any" },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: "gate", sourceHandle: "next" }],
  };
}

test("copied Flow scope validation accepts canonical counterparts without rewriting evidence", () => {
  const graph = scopedFlowGraph([
    "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ]);
  const before = structuredClone(graph);
  validateClonedFlowGraphScope(graph, flowCounterparts, "flow");
  assert.deepEqual(graph, before);
});

test("copied Flow scope validation leaves an unscoped graph untouched", () => {
  const graph = { schemaVersion: 1, nodes: [], edges: [] };
  validateClonedFlowGraphScope(graph, flowCounterparts, "flow");
  assert.deepEqual(graph, { schemaVersion: 1, nodes: [], edges: [] });
});

test("validateClonedFlowGraphScope refuses counterparts that cannot be proven", () => {
  const unknown = "33333333-3333-4333-8333-333333333333";
  for (const graph of [
    scopedFlowGraph([unknown]),
    scopedFlowGraph(["abcdefab-abcd-4bcd-8bcd-abcdefabcdef", unknown]),
    scopedFlowGraph([unknown, "abcdefab-abcd-4bcd-8bcd-abcdefabcdef"]),
  ]) {
    assert.throws(
      () => validateClonedFlowGraphScope(graph, flowCounterparts, "sandbox flow 9"),
      /sandbox flow 9: flow subject scope subsidiary has no counterpart/,
    );
  }
});

test("validateClonedFlowGraphScope refuses malformed scopes rather than repairing them", () => {
  const overlength = Array.from(
    { length: 101 },
    (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
  );
  for (const graph of [
    null,
    [],
    "graph",
    { subjectScope: null },
    { subjectScope: [] },
    { subjectScope: {} },
    { subjectScope: { subsidiaryIds: "11111111-1111-4111-8111-111111111111" } },
    { subjectScope: { subsidiaryIds: [] } },
    { subjectScope: { subsidiaryIds: [42] } },
    { subjectScope: { subsidiaryIds: [null] } },
    { subjectScope: { subsidiaryIds: ["not-a-uuid"] } },
    scopedFlowGraph([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]),
    scopedFlowGraph([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111".toUpperCase(),
    ]),
    scopedFlowGraph(overlength),
  ]) {
    assert.throws(
      () => validateClonedFlowGraphScope(graph, flowCounterparts, "sandbox flow 9"),
      /sandbox flow 9: invalid flow/,
    );
  }
});

test("remapScopeFilter refuses unknown keys, non-objects and identities without a counterpart", () => {
  assert.throws(() => remapScopeFilter(null, ids, "row"), /row: invalid scope filter/);
  assert.throws(() => remapScopeFilter([], ids, "row"), /row: invalid scope filter/);
  assert.throws(
    () => remapScopeFilter({ location_id: "x" }, ids, "row"),
    /row: scope filter carries an unknown key location_id/,
  );
  assert.throws(
    () => remapScopeFilter({ department_id: "33333333-3333-4333-8333-333333333333" }, ids, "row"),
    /row: scope filter department_id has no counterpart in the target organization/,
  );
  assert.throws(
    () => remapScopeFilter({ employer_subsidiary_id: 7 }, ids, "row"),
    /row: scope filter employer_subsidiary_id has no counterpart/,
  );
});

test("role captures require an explicit valid policy", () => {
  assert.throws(
    () => remapRoleRestriction(null, ids.subsidiaries, "role"),
    /invalid subsidiary restriction/,
  );
  assert.deepEqual(remapRoleRestriction({ mode: "all" }, ids.subsidiaries, "role"), {
    mode: "all",
  });
  assert.deepEqual(
    remapRoleRestriction({ mode: "list", subsidiaryIds: [] }, ids.subsidiaries, "role"),
    { mode: "list", subsidiaryIds: [] },
  );
  assert.throws(
    () => remapRoleRestriction(undefined, ids.subsidiaries, "role"),
    /invalid subsidiary restriction/,
  );
  assert.throws(
    () => remapRoleRestriction({ mode: "unknown" }, ids.subsidiaries, "role"),
    /invalid subsidiary restriction/,
  );
});
