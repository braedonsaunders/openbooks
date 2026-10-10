import { test } from "node:test";
import assert from "node:assert/strict";
import { lintFlowGraphForSubject } from "./lint.ts";
import { bankAccountsFlowAdapter } from "./bank-accounts-adapter.ts";

/**
 * Document approval release is engine-enforced (decideGate → releaseApproval),
 * so an authored change_status to a release status must be rejected at author
 * time — that's what prevents an author from wiring an early/duplicate release.
 */

const gate = {
  kind: "gate" as const,
  gate: { title: "Approval", assignees: [{ type: "role" as const, role: "approver" }], mode: "any" as const },
};

function graph(nodes: unknown[], edges: unknown[]) {
  return { schemaVersion: 1, nodes, edges };
}

test("rejects a change_status to 'approved' on a document flow", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
      { id: "a", position: { x: 2, y: 0 }, data: { kind: "action", action: { action: "change_status", to: "approved" } } },
    ],
    [
      { id: "e1", source: "t", target: "g", sourceHandle: "next" },
      { id: "e2", source: "g", target: "a", sourceHandle: "approve" },
    ],
  );
  const res = lintFlowGraphForSubject("vendor_bill", g);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /change_status.*approved.*engine-enforced/i.test(e)));
});

function scheduledGraph(cron: string) {
  return graph(
    [
      { id: "trig", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "scheduled", cron } } },
      {
        id: "n1",
        position: { x: 0, y: 1 },
        data: {
          kind: "action",
          action: { action: "notify", to: [{ type: "user", userId: "someone" }], title: "Scheduled probe" },
        },
      },
    ],
    [{ id: "e1", source: "trig", target: "n1", sourceHandle: "next" }],
  );
}

test("rejects a scheduled trigger whose cron can never fire, naming the node", () => {
  const res = lintFlowGraphForSubject("vendor_bill", scheduledGraph("not-a-cron"));
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => /node "trig".*cron 'not-a-cron' is not a valid cron expression/i.test(e)),
    `expected a named cron refusal, got: ${res.errors.join("; ")}`,
  );
});

test("a scheduled trigger with a valid cron draws no cron refusal", () => {
  const res = lintFlowGraphForSubject("vendor_bill", scheduledGraph("0 9 * * *"));
  const cronErrors = res.ok ? [] : res.errors.filter((e) => /cron|timezone/i.test(e));
  assert.deepEqual(cronErrors, []);
});

test("rejects a change_status to 'draft' on a document flow", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
      { id: "a", position: { x: 2, y: 0 }, data: { kind: "action", action: { action: "change_status", to: "draft" } } },
    ],
    [
      { id: "e1", source: "t", target: "g", sourceHandle: "next" },
      { id: "e2", source: "g", target: "a", sourceHandle: "reject" },
    ],
  );
  assert.equal(lintFlowGraphForSubject("vendor_bill", g).ok, false);
});

test("accepts a gate-only document approval flow (engine releases it)", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
    ],
    [{ id: "e1", source: "t", target: "g", sourceHandle: "next" }],
  );
  const res = lintFlowGraphForSubject("vendor_bill", g);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
});

test("rejects an authored bank-detail approval without a gate", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_create" } } },
      { id: "a", position: { x: 1, y: 0 }, data: { kind: "action", action: { action: "change_status", to: "approved" } } },
    ],
    [{ id: "e1", source: "t", target: "a", sourceHandle: "next" }],
  );
  const res = lintFlowGraphForSubject("party_bank_account", g);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /change_status.*approved.*bank-detail.*engine-enforced/i.test(e)));
});

test("accepts a gate-only bank-detail approval flow (engine releases it)", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_create" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
    ],
    [{ id: "e1", source: "t", target: "g", sourceHandle: "next" }],
  );
  const res = lintFlowGraphForSubject("party_bank_account", g);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
});

test("bank-detail adapter rejects authored approval at the runtime boundary", async () => {
  await assert.rejects(
    bankAccountsFlowAdapter.changeStatus("not-a-real-bank-account", "approved", {
      orgId: "org",
      userId: "author",
    }),
    /bank-detail approval release is engine-enforced.*approval gate/i,
  );
  assert.equal(bankAccountsFlowAdapter.selfApprovalPolicy, "configurable");
  assert.equal(bankAccountsFlowAdapter.profile.pinsSubmissionPolicy, true);
});

test("rejects an approval gate reachable from before_post", () => {
  const g = graph(
    [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "before_post" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
    ],
    [{ id: "e1", source: "t", target: "g", sourceHandle: "next" }],
  );
  const res = lintFlowGraphForSubject("vendor_bill", g);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((error) => /before_post.*on_submit/i.test(error)));
});

test("refuses a graph with more than one trigger, naming every trigger by kind", () => {
  const g = graph(
    [
      { id: "t1", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "t2", position: { x: 0, y: 1 }, data: { kind: "trigger", trigger: { trigger: "manual", buttonId: "btn_1", label: "Run" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
    ],
    [
      { id: "e1", source: "t1", target: "g", sourceHandle: "next" },
      { id: "e2", source: "t2", target: "g", sourceHandle: "next" },
    ],
  );
  const res = lintFlowGraphForSubject("vendor_bill", g);
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => /2 triggers.*"on_submit".*"manual".*exactly one trigger/i.test(e)),
    `expected a named single-trigger refusal, got: ${res.errors.join("; ")}`,
  );
});

test("refusal messages never name storage ids outside the submitted graph", () => {
  // A hostile graph: two triggers, duplicated conditions, an empty rule,
  // and edges into the void. Every id-shaped token in every message must be
  // a node or edge the graph actually contains — never a stale deleted id.
  const g = graph(
    [
      { id: "t1", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "t2", position: { x: 0, y: 1 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      { id: "c1", position: { x: 1, y: 0 }, data: { kind: "condition", label: "Same", rule: { op: "isSet", field: "total" } } },
      { id: "c2", position: { x: 1, y: 1 }, data: { kind: "condition", label: "Same", rule: { op: "isSet", field: "total" } } },
    ],
    [
      { id: "e1", source: "t1", target: "c1", sourceHandle: "next" },
      { id: "e2", source: "ghost", target: "c2", sourceHandle: "next" },
    ],
  );
  const res = lintFlowGraphForSubject("vendor_bill", g);
  assert.equal(res.ok, false);
  const ids = new Set(["t1", "t2", "c1", "c2", "e1", "e2"]);
  const vocab = new Set([
    "on_create", "on_update", "on_submit", "before_post", "after_post", "before_void",
    "status_change", "on_field_value", "scheduled", "manual",
    "send_email", "notify", "set_field", "change_status", "post_document",
    "lock_record", "unlock_record", "distribute_schedule", "send_board_schedule",
  ]);
  const stray = res.errors.filter((message) => {
    const tokens = message.match(/[\w-]+_[\w-]+/g) ?? [];
    return tokens.some((token) => !ids.has(token) && !vocab.has(token));
  });
  assert.deepEqual(stray, [], `messages must not name ids outside the graph, got: ${stray.join("; ")}`);
});

test("names posting and create triggers that can never fire for quotes", () => {
  // Quotes never post and live outside the document writers: both triggers
  // would save a silently dead flow, so enabling names the node and the cause.
  const g = graph(
    [
      { id: "t-post", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "before_post" } } },
      { id: "t-create", position: { x: 0, y: 1 }, data: { kind: "trigger", trigger: { trigger: "on_create" } } },
      { id: "g", position: { x: 1, y: 0 }, data: gate },
    ],
    [
      { id: "e1", source: "t-post", target: "g", sourceHandle: "next" },
      { id: "e2", source: "t-create", target: "g", sourceHandle: "next" },
    ],
  );
  const res = lintFlowGraphForSubject("quote", g);
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((error) => /Trigger t-post: "before_post" never fires for Quote/i.test(error)),
    `expected a named posting refusal, got: ${res.errors.join("; ")}`,
  );
  assert.ok(
    res.errors.some((error) => /Trigger t-create: "on_create" never fires for Quote/i.test(error)),
    `expected a named create refusal, got: ${res.errors.join("; ")}`,
  );
});


test("board delivery drafts keep generic timing neutral; explicit multi-time clocks preserve paired times and require timezone/selection", async () => {
  const { scheduleBoardTimerGraph } = await import('./schedule-board-adapter.ts');
  const { scheduledTriggerCrons } = await import('./scheduled.ts');
  const id = '00000000-0000-4000-8000-000000000001';
  const ordinary = scheduleBoardTimerGraph(id, 'America/Toronto');
  const trigger = ordinary.nodes[0]!.data;
  assert.equal(trigger.kind, 'trigger');
  if (trigger.kind !== 'trigger' || trigger.trigger.trigger !== 'scheduled') throw new Error('Native board trigger missing');
  assert.equal(trigger.trigger.clockSchedule, undefined, 'no company sending times activate by default');
  const selected = scheduleBoardTimerGraph(id, 'America/Toronto', true);
  const authored = selected.nodes[0]!.data;
  if (authored.kind !== 'trigger' || authored.trigger.trigger !== 'scheduled') throw new Error('Native board trigger missing');
  assert.deepEqual(scheduledTriggerCrons(authored.trigger), ['0 6 * * 1,2,3,4,5', '30 14 * * 1,2,3,4,5']);
  assert.equal(lintFlowGraphForSubject('schedule_board', selected).ok, true);
  for (const field of ['tz', 'select'] as const) {
    const invalid = structuredClone(selected);
    const node = invalid.nodes[0]!.data;
    if (node.kind !== 'trigger' || node.trigger.trigger !== 'scheduled') throw new Error('Native board trigger missing');
    delete node.trigger[field];
    const refused = lintFlowGraphForSubject('schedule_board', invalid);
    assert.equal(refused.ok, false);
    assert.ok(refused.errors.some(error => field === 'tz' ? /timezone/.test(error) : /record selection/.test(error)));
  }
  for (const clockSchedule of [ { days: [1], times: ['06:00', '06:00'] }, { days: [1, 1], times: ['06:00'] }, { days: [1], times: ['25:00'] }, { days: [], times: [] } ]) {
    const invalid = structuredClone(selected);
    const node = invalid.nodes[0]!.data;
    if (node.kind !== 'trigger' || node.trigger.trigger !== 'scheduled') throw new Error('Native board trigger missing');
    node.trigger.clockSchedule = clockSchedule;
    assert.equal(lintFlowGraphForSubject('schedule_board', invalid).ok, false);
  }
});
