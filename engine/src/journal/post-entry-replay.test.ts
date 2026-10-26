import assert from "node:assert/strict";
import test from "node:test";
import { postEntry, postingRequestHash, type PostEntryInput } from "./post-entry.ts";
import type { SqlExecutor } from "../platform/db.ts";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const original: PostEntryInput = {
  orgId: id(1),
  bookId: id(2),
  subsidiaryId: id(3),
  entryNumber: "ORIGINAL",
  postingDate: "2026-07-01",
  periodId: id(4),
  origin: "manual",
  currency: "CAD",
  idempotencyKey: "same-operation",
  lines: [
    { accountId: id(5), currency: "CAD", amount: "10", partyId: id(7) },
    { accountId: id(6), currency: "CAD", amount: "-10" },
  ],
};

test("request identity normalizes decimals and excludes numbers and attribution", () => {
  const changedAttribution = { ...original, entryNumber: "RETRY", actorId: id(8) };
  assert.equal(
    postingRequestHash(original, original.lines),
    postingRequestHash(changedAttribution, [
      { ...original.lines[0]!, amount: "10.0000" },
      { ...original.lines[1]!, amount: "-10.00" },
    ]),
  );
});

test("request identity retains every financial header and line distinction", () => {
  const hash = postingRequestHash(original, original.lines);
  for (const patch of [
    { bookId: id(8) },
    { subsidiaryId: id(9) },
    { periodId: id(10) },
    { postingDate: "2026-07-02" },
    { origin: "inventory" },
    { sourceDocumentId: id(11) },
  ]) {
    assert.notEqual(postingRequestHash({ ...original, ...patch }, original.lines), hash);
  }
  for (const patch of [
    { amount: "20" },
    { accountId: id(12) },
    { currency: "USD" },
    { txnAmount: "20" },
    { fxRate: "2" },
    { departmentId: id(13) },
    { partyId: id(14) },
    { quantity: "1" },
    { isOpenItem: true },
    { custom: { obligation: "other" } },
    { extraDims: { fund: "restricted" } },
  ]) {
    assert.notEqual(
      postingRequestHash(original, [{ ...original.lines[0]!, ...patch }, original.lines[1]!]),
      hash,
    );
  }
});

test("reserved posting evidence and malformed UUIDs refuse before database work", async () => {
  let calls = 0;
  const executor = {
    execute: async () => {
      calls++;
      throw new Error("unexpected SQL");
    },
  } as unknown as SqlExecutor;
  for (const custom of [{ postingRequestHash: "spoofed" }, { postingRequestBasis: "spoofed" }]) {
    await assert.rejects(
      () => postEntry(executor, { ...original, custom }),
      /reserved posting evidence/,
    );
  }
  for (const input of [
    { ...original, bookId: "Primary" },
    { ...original, subsidiaryId: "Company" },
    { ...original, periodId: "2026-07" },
    { ...original, lines: [{ ...original.lines[0]!, accountId: "1000" }, original.lines[1]!] },
    {
      ...original,
      lines: [{ ...original.lines[0]!, subsidiaryId: "Company" }, original.lines[1]!],
    },
  ])
    await assert.rejects(() => postEntry(executor, input), /must be a UUID/);
  assert.equal(calls, 0);
});
