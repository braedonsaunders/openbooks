import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateOldestFirst,
  planStatementSettlement,
  settlementOrder,
  StatementSettlementError,
  type SettlementDocument,
} from "./statement-settlement.ts";

const doc = (
  openLineId: string,
  open: string,
  dueDate: string | null,
  postingDate = "2026-07-01",
): SettlementDocument => ({
  openLineId,
  open,
  dueDate,
  postingDate,
  label: `INV-${openLineId}`,
});

const refused = (pattern: RegExp) => (error: unknown) =>
  error instanceof StatementSettlementError &&
  pattern.test(error.message) &&
  error.remedy.length > 0;

test("cash is applied oldest due first, undated documents last, each up to its open balance", () => {
  const docs = [
    doc("c", "50.0000", null),
    doc("b", "30.0000", "2026-07-20"),
    doc("a", "40.0000", "2026-07-10"),
  ];
  assert.deepEqual(
    settlementOrder(docs).map((d) => d.openLineId),
    ["a", "b", "c"],
  );
  assert.deepEqual(allocateOldestFirst("55.0000", docs), {
    a: "40.0000",
    b: "15.0000",
    c: "0.0000",
  });
  assert.deepEqual(allocateOldestFirst("200.0000", docs), {
    a: "40.0000",
    b: "30.0000",
    c: "50.0000",
  });
});

test("equal due dates fall back to the posting date, then the document label", () => {
  const docs = [
    doc("y", "10.0000", "2026-07-10", "2026-06-02"),
    doc("x", "10.0000", "2026-07-10", "2026-06-01"),
  ];
  assert.deepEqual(
    settlementOrder(docs).map((d) => d.openLineId),
    ["x", "y"],
  );
});

test("a line smaller than the documents pays them in part and leaves the rest open", () => {
  const plan = planStatementSettlement({
    lineAmount: "60.0000",
    documents: [doc("a", "40.0000", "2026-07-10"), doc("b", "30.0000", "2026-07-20")],
    applied: { a: "40.0000", b: "20.0000" },
    writeOff: false,
  });
  assert.equal(plan.appliedTotal, "60.0000");
  assert.equal(plan.onAccount, "0.0000");
  assert.equal(plan.writeOffTotal, "0.0000");
  assert.deepEqual(
    plan.documents.map((d) => [d.openLineId, d.applied, d.remaining]),
    [
      ["a", "40.0000", "0.0000"],
      ["b", "20.0000", "10.0000"],
    ],
  );
});

test("a line larger than the documents keeps the excess on account to the minor unit", () => {
  const plan = planStatementSettlement({
    lineAmount: "100.0100",
    documents: [doc("a", "40.0000", "2026-07-10")],
    applied: { a: "40.0000" },
    writeOff: false,
  });
  assert.equal(plan.onAccount, "60.0100");
});

test("a write-off clears each document's shortfall exactly", () => {
  const plan = planStatementSettlement({
    lineAmount: "68.9900",
    documents: [doc("a", "40.0000", "2026-07-10"), doc("b", "30.0000", "2026-07-20")],
    applied: { a: "40.0000", b: "28.9900" },
    writeOff: true,
  });
  assert.equal(plan.writeOffTotal, "1.0100");
  assert.deepEqual(
    plan.documents.map((d) => [d.openLineId, d.writeOff, d.remaining]),
    [
      ["a", "0.0000", "0.0000"],
      ["b", "1.0100", "0.0000"],
    ],
  );
});

test("the operator's allocation is refused when it over-applies, under-fills or names the wrong documents", () => {
  const documents = [doc("a", "40.0000", "2026-07-10"), doc("b", "30.0000", "2026-07-20")];
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "41.0000", b: "5.0000" },
        writeOff: false,
      }),
    refused(/more than its open balance/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "40.0000", b: "20.0000" },
        writeOff: false,
      }),
    refused(/more than the statement line/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "40.0000" },
        writeOff: false,
      }),
    refused(/has no amount to apply/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "40.0000", b: "0" },
        writeOff: false,
      }),
    refused(/receives nothing/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "40.0000", b: "1.5", z: "1" },
        writeOff: false,
      }),
    refused(/not selected/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "50.0000",
        documents,
        applied: { a: "40.00001", b: "1" },
        writeOff: false,
      }),
    refused(/not a valid amount/),
  );
});

test("a write-off is refused while cash stays unapplied, or when nothing is short-paid", () => {
  const documents = [doc("a", "40.0000", "2026-07-10"), doc("b", "30.0000", "2026-07-20")];
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "70.0000",
        documents,
        applied: { a: "40.0000", b: "20.0000" },
        writeOff: true,
      }),
    refused(/stay unapplied/),
  );
  assert.throws(
    () =>
      planStatementSettlement({
        lineAmount: "70.0000",
        documents,
        applied: { a: "40.0000", b: "30.0000" },
        writeOff: true,
      }),
    refused(/nothing to write off/),
  );
});
