import assert from "node:assert/strict";
import test from "node:test";
import { postEntry, type PostEntryInput } from "./post-entry.ts";
import type { SqlExecutor } from "../platform/db.ts";

const original: PostEntryInput = {
  orgId: "org", bookId: "book", subsidiaryId: "entity", entryNumber: "ORIGINAL",
  postingDate: "2026-07-01", periodId: "period", origin: "manual", currency: "CAD", idempotencyKey: "same-operation",
  lines: [{ accountId: "bank", amount: "10", partyId: "customer" }, { accountId: "income", amount: "-10" }],
};

function legacyExecutor() {
  let calls = 0;
  const executor = { async execute() {
    calls += 1;
    return { rows: original.lines.map((line, index) => ({
      entry_id: "existing-entry", id: `line-${index + 1}`, line_number: index + 1, request_hash: null, header: original,
      line: { ...line, subsidiaryId: original.subsidiaryId, currency: "CAD", txnAmount: line.amount, fxRate: "1.0000000000", lineNumber: index + 1 },
    })) };
  } } as unknown as SqlExecutor;
  return { executor, calls: () => calls };
}

test("legacy keyed replay compares stored financial content without changing history", async () => {
  const { executor, calls } = legacyExecutor();
  const result = await postEntry(executor, { ...original, entryNumber: "NEW-NUMBER", actorId: "new-actor", lines: [{ ...original.lines[0]!, amount: "10.0000" }, { ...original.lines[1]!, amount: "-10.00" }] });
  assert.equal(result.entryId, "existing-entry");
  assert.equal(result.lines.length, 2);
  assert.equal(calls(), 1, "identical replay must only read the existing entry");
});

test("legacy keyed replay refuses changed book, entity, period, date, origin and source", async () => {
  for (const patch of [{ bookId: "other-book" }, { subsidiaryId: "other-entity" }, { periodId: "other-period" }, { postingDate: "2026-07-02" }, { origin: "inventory" }, { sourceDocumentId: "other-source" }]) {
    const { executor } = legacyExecutor();
    await assert.rejects(() => postEntry(executor, { ...original, ...patch }), /same-operation.*existing-entry.*different posting content.*review that journal entry/);
  }
});

test("legacy keyed replay refuses changed amounts, accounts, currency, dimensions and open-item evidence", async () => {
  for (const patch of [{ amount: "20" }, { accountId: "other-bank" }, { currency: "USD" }, { txnAmount: "20" }, { fxRate: "2" }, { departmentId: "other-department" }, { partyId: "other-customer" }, { quantity: "1" }, { isOpenItem: true }, { custom: { obligation: "other" } }, { extraDims: { fund: "restricted" } }]) {
    const { executor } = legacyExecutor();
    await assert.rejects(() => postEntry(executor, { ...original, lines: [{ ...original.lines[0]!, ...patch }, original.lines[1]!] }), /different posting content.*correct this request/);
  }
});

test("posting evidence cannot be supplied through caller custom metadata", async () => {
  const { executor } = legacyExecutor();
  await assert.rejects(() => postEntry(executor, { ...original, custom: { postingRequestHash: "spoofed" } }), /reserved posting evidence/);
});
