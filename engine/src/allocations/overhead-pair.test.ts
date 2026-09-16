import assert from "node:assert/strict";
import test from "node:test";
import { assertContributorBalance, buildNetZeroPairLines } from "./post.ts";
import type { RuleInEffect } from "./types.ts";

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DRIVER_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY_1 = "e1111111-1111-4111-8111-111111111111";
const ENTRY_2 = "e2222222-2222-4222-8222-222222222222";
const ENTRY_3 = "e3333333-3333-4333-8333-333333333333";

function systemRule(override: Record<string, unknown> = {}): RuleInEffect {
  return {
    rule: {
      id: RULE_ID,
      orgId: "0f000000-0000-4000-8000-000000000000",
      key: "overhead-net-zero-pair",
      name: "Overhead net-zero pair (system)",
      mode: "post",
      sortOrder: 100,
      isActive: true,
      isSystem: true,
    },
    version: {
      id: VERSION_ID,
      orgId: "0f000000-0000-4000-8000-000000000000",
      ruleId: RULE_ID,
      versionNo: 1,
      status: "published",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      bookScope: "primary",
      bookIds: [],
      documentKinds: ["time_entry_approval"],
      accountScope: { kind: "accounts", accountIds: [ACCOUNT_ID] },
      dimensionFilters: {},
      applyPolicy: "manual",
      sourceMeasure: "period_activity",
      basisKind: "driver",
      driverId: DRIVER_ID,
      driverAsOf: "document_date",
      basisConfig: {},
      targetKind: "dynamic",
      dynamicTarget: { dimension: "project" },
      impact: "net_zero_pair",
      offsetAccountId: null,
      residualPolicy: "largest_share",
      residualTargetId: null,
      solveMethod: "sequential",
      runPolicy: "manual",
      runOffsetDays: 0,
      approvalFlowId: null,
      memoTemplate: "Overhead applied with approved hours (net-zero pair)",
      lineDescriptionTemplate: "Overhead applied",
      definitionHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      publishedAt: "2026-01-02T00:00:00.000Z",
      publishedBy: null,
      ...(override as Partial<RuleInEffect["version"]>),
    },
    targets: [],
  };
}

const SOURCE = { accountId: ACCOUNT_ID };

test("net-zero pair builds project legs plus the untagged contra", () => {
  const built = buildNetZeroPairLines({
    rule: systemRule(),
    currency: "CAD",
    source: SOURCE,
    total: "45",
    targets: [
      { projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] },
      {
        projectId: PROJECT_B,
        amount: "20",
        entries: [
          { id: ENTRY_2, amount: "12.5" },
          { id: ENTRY_3, amount: "7.5" },
        ],
      },
    ],
  });
  assert.equal(built.length, 3);
  const [legA, legB, contra] = built as [typeof built[0], typeof built[1], typeof built[2]];
  assert.deepEqual(
    { accountId: legA.line.accountId, projectId: legA.line.projectId, amount: legA.line.amount, memo: legA.line.memo },
    { accountId: ACCOUNT_ID, projectId: PROJECT_A, amount: "25.0000", memo: "Overhead applied" },
  );
  assert.deepEqual(
    { accountId: legB.line.accountId, projectId: legB.line.projectId, amount: legB.line.amount, memo: legB.line.memo },
    { accountId: ACCOUNT_ID, projectId: PROJECT_B, amount: "20.0000", memo: "Overhead applied" },
  );
  assert.deepEqual(
    { accountId: contra.line.accountId, projectId: contra.line.projectId, amount: contra.line.amount, memo: contra.line.memo },
    { accountId: ACCOUNT_ID, projectId: null, amount: "-45.0000", memo: "Overhead applied — contra" },
  );
  for (const leg of built) {
    assert.equal(leg.line.contributorKind, "rule");
    assert.equal(leg.line.contributorRef, VERSION_ID);
    assert.equal(leg.line.currency, "CAD");
  }
  assertContributorBalance(built.map((b) => b.line));
});

test("net-zero pair lineage traces every cent to its time entry", () => {
  const built = buildNetZeroPairLines({
    rule: systemRule(),
    currency: "CAD",
    source: SOURCE,
    total: "45",
    targets: [
      { projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] },
      {
        projectId: PROJECT_B,
        amount: "20",
        entries: [
          { id: ENTRY_2, amount: "12.5" },
          { id: ENTRY_3, amount: "7.5" },
        ],
      },
    ],
  });
  const drafts = built.flatMap((b) => b.lineage);
  assert.equal(drafts.length, 4);
  for (const draft of drafts) {
    assert.equal(draft.mode, "post");
    assert.equal(draft.ruleId, RULE_ID);
    assert.equal(draft.versionId, VERSION_ID);
    assert.equal(draft.definitionHash, systemRule().version.definitionHash);
    assert.equal(draft.runId, null);
    assert.equal(draft.documentId, null);
    assert.equal(draft.driverId, DRIVER_ID);
  }
  const byEntry = new Map(drafts.filter((d) => d.sourceTimeEntryId).map((d) => [d.sourceTimeEntryId, d]));
  assert.deepEqual(byEntry.get(ENTRY_1), {
      mode: "post",
      ruleId: RULE_ID,
      versionId: VERSION_ID,
      definitionHash: systemRule().version.definitionHash,
      runId: null,
      documentId: null,
      sourceJournalLineId: null,
      sourceDocumentLineId: null,
      targetDocumentLineId: null,
      sourceTimeEntryId: ENTRY_1,
      driverId: DRIVER_ID,
      driverValue: "25.0000",
      driverTotal: "45.0000",
      share: "0.5555555556",
      amount: "25.0000",
      residual: "0",
    },
  );
  const contra = drafts.find((d) => d.sourceTimeEntryId === null || d.sourceTimeEntryId === undefined)!;
  assert.equal(contra.amount, "-45.0000");
  assert.equal(contra.share, null);
});

test("net-zero pair skips zero legs and refuses to invent or lose a cent", () => {
  const built = buildNetZeroPairLines({
    rule: systemRule(),
    currency: "CAD",
    source: SOURCE,
    total: "25",
    targets: [
      { projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] },
      { projectId: PROJECT_B, amount: "0", entries: [] },
    ],
  });
  assert.equal(built.length, 2);
  assert.throws(
    () =>
      buildNetZeroPairLines({
        rule: systemRule(),
        currency: "CAD",
        source: SOURCE,
        total: "26",
        targets: [{ projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] }],
      }),
    /does not equal the leg total/,
  );
  assert.throws(
    () =>
      buildNetZeroPairLines({
        rule: systemRule(),
        currency: "CAD",
        source: SOURCE,
        total: "25",
        targets: [{ projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "20" }] }],
      }),
    /entries do not sum to the leg amount/,
  );
  assert.throws(
    () =>
      buildNetZeroPairLines({
        rule: systemRule(),
        currency: "CAD",
        source: SOURCE,
        total: "0",
        targets: [],
      }),
    /nothing to pair/,
  );
});

test("net-zero pair refuses non-pair impacts and unhashed versions", () => {
  assert.throws(
    () =>
      buildNetZeroPairLines({
        rule: systemRule({ impact: "reclass" }),
        currency: "CAD",
        source: SOURCE,
        total: "25",
        targets: [{ projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] }],
      }),
    /net_zero_pair/,
  );
  assert.throws(
    () =>
      buildNetZeroPairLines({
        rule: systemRule({ definitionHash: null }),
        currency: "CAD",
        source: SOURCE,
        total: "25",
        targets: [{ projectId: PROJECT_A, amount: "25", entries: [{ id: ENTRY_1, amount: "25" }] }],
      }),
    /definition hash/,
  );
});
