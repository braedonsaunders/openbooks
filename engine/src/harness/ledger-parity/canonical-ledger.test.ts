import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeLines, compareSnapshots } from "./canonical-ledger.ts";

test("canonicalizeLines aggregates source row ordering using exact money units", () => {
  assert.deepEqual(
    canonicalizeLines([
      { account: "AR", amount: "0.0050" },
      { account: "REVENUE", amount: "-1.0000" },
      { account: "AR", amount: "0.9950" },
    ]),
    [
      { account: "AR", amount: "1.0000" },
      { account: "REVENUE", amount: "-1.0000" },
    ],
  );
});

test("compareSnapshots reports penny-level differences and balance failures", () => {
  const result = compareSnapshots(
    {
      source: "openbooks",
      company: "Parity",
      checkpoint: "invoice",
      lines: [
        { account: "AR", amount: "10.0000" },
        { account: "REVENUE", amount: "-10.0000" },
      ],
    },
    {
      source: "erpnext",
      company: "Parity",
      checkpoint: "invoice",
      lines: [
        { account: "AR", amount: "10.0100" },
        { account: "REVENUE", amount: "-10.0100" },
      ],
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [
    { key: "AR|||", openbooks: "10.0000", erpnext: "10.0100", delta: "-0.0100" },
    { key: "REVENUE|||", openbooks: "-10.0000", erpnext: "-10.0100", delta: "0.0100" },
  ]);
});
