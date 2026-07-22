import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTransactionAuditChanges,
  type TransactionAuditSnapshot,
} from "./transaction-audit.ts";

const before: TransactionAuditSnapshot = {
  document: { id: "doc-1", total: "10.0000" },
  lines: [{ id: "line-1", amount: "10.0000" }],
  taxComponents: [{ id: "tax-1", taxAmount: "1.3000" }],
  glImpact: {
    entry: { id: "entry-1", status: "posted" },
    lines: [
      { id: "gl-1", amount: "10.0000" },
      { id: "gl-2", amount: "-10.0000" },
    ],
  },
};

test("posted amendment evidence retains complete before and after snapshots", () => {
  const after: TransactionAuditSnapshot = {
    ...before,
    document: { id: "doc-1", total: "15.0000" },
  };
  assert.deepEqual(
    buildTransactionAuditChanges({
      mode: "posted_amendment",
      source: "ui",
      before,
      after,
    }),
    { mode: "posted_amendment", source: "ui", before, after },
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
