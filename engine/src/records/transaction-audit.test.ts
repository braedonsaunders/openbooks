import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTransactionAuditChanges,
  transactionSnapshotsMatch,
  type TransactionAuditSnapshot,
} from "./transaction-audit.ts";

const before: TransactionAuditSnapshot = {
  document: { id: "doc-1", total: "10.0000" },
  lines: [{ id: "line-1", amount: "10.0000" }],
  taxComponents: [{ id: "tax-1", taxAmount: "1.3000" }],
  applications: [{ id: "app-1", amount: "10.0000", unappliedAt: null }],
  glImpact: {
    entry: { id: "entry-1", status: "posted" },
    lines: [
      { id: "gl-1", amount: "10.0000" },
      { id: "gl-2", amount: "-10.0000" },
    ],
    reversals: [],
  },
};

test("controlled void evidence retains complete before and after snapshots", () => {
  const after: TransactionAuditSnapshot = {
    ...before,
    document: { id: "doc-1", total: "15.0000" },
  };
  assert.deepEqual(
    buildTransactionAuditChanges({
      mode: "transaction_void",
      source: "ui",
      before,
      after,
    }),
    { mode: "transaction_void", source: "ui", before, after },
  );
});

test("draft edits use the general record-update audit mode", () => {
  assert.deepEqual(
    buildTransactionAuditChanges({
      mode: "record_update",
      source: "ui",
      before: {
        ...before,
        document: { ...before.document, status: "draft" },
      },
      after: {
        ...before,
        document: { ...before.document, status: "draft", memo: "Updated memo" },
      },
    }).mode,
    "record_update",
  );
});

test("posting evidence has an explicit lifecycle mode", () => {
  assert.equal(
    buildTransactionAuditChanges({
      mode: "record_post",
      source: "ui",
      before,
      after: {
        ...before,
        document: { ...before.document, status: "posted" },
      },
    }).mode,
    "record_post",
  );
});

test("transaction deletion evidence is a tombstone with a reason", () => {
  assert.deepEqual(
    buildTransactionAuditChanges({
      mode: "transaction_delete",
      source: "ui",
      reason: "user_requested",
      before,
      after: null,
    }),
    {
      mode: "transaction_delete",
      source: "ui",
      reason: "user_requested",
      before,
      after: null,
    },
  );
});

// A save that changes nothing writes no audit row: the UPDATE always bumps
// the write stamps (and the line writer re-mints row ids on a rewrite), so
// the comparison ignores stamps and surrogate line identity and only
// material content decides.
function snapshot(overrides: Partial<TransactionAuditSnapshot> = {}): TransactionAuditSnapshot {
  return {
    document: {
      id: "doc-1",
      org_id: "org-1",
      kind: "customer_invoice",
      status: "posted",
      document_number: "INV-1",
      memo: null,
      total: "100.0000",
      created_at: "2026-07-15T00:00:00+00:00",
      created_by: "u1",
      updated_at: "2026-07-15T00:00:00+00:00",
      updated_by: "u1",
      revision_seq: "4",
    },
    lines: [
      {
        id: "line-1",
        document_id: "doc-1",
        line_number: 1,
        account_id: "a1",
        amount: "100.0000",
        description: null,
      },
    ],
    taxComponents: [],
    applications: [],
    glImpact: null,
    ...overrides,
  };
}

test("stamp-only differences match", () => {
  const before = snapshot();
  const after = snapshot({
    document: {
      ...before.document,
      updated_at: "2026-07-16T00:00:00+00:00",
      updated_by: "u2",
      revision_seq: "5",
    },
  });
  assert.equal(transactionSnapshotsMatch(before, after), true);
});

test("a material header change does not match", () => {
  const before = snapshot();
  const after = snapshot({
    document: {
      ...before.document,
      memo: "hello",
      updated_at: "2026-07-16T00:00:00+00:00",
      revision_seq: "5",
    },
  });
  assert.equal(transactionSnapshotsMatch(before, after), false);
});

test("an identical line rewrite with re-minted ids matches", () => {
  const before = snapshot();
  const after = snapshot({
    lines: [
      {
        id: "line-2",
        document_id: "doc-1",
        line_number: 1,
        account_id: "a1",
        amount: "100.0000",
        description: null,
      },
    ],
  });
  assert.equal(transactionSnapshotsMatch(before, after), true);
});

test("a line content change does not match", () => {
  const before = snapshot();
  const after = snapshot({
    lines: [
      {
        id: "line-1",
        document_id: "doc-1",
        line_number: 1,
        account_id: "a1",
        amount: "200.0000",
        description: null,
      },
    ],
  });
  assert.equal(transactionSnapshotsMatch(before, after), false);
});

test("a removed line does not match", () => {
  assert.equal(transactionSnapshotsMatch(snapshot(), snapshot({ lines: [] })), false);
});
