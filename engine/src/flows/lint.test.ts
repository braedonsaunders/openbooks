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
  assert.equal(bankAccountsFlowAdapter.selfApprovalPolicy, "forbidden");
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
