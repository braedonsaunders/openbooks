/**
 * Vendor pay-application line validation — behavioural unit tests, no
 * database. Every malformed draw is refused before any transaction opens,
 * and every refusal names the line (1-based position plus SOV identity)
 * so the route can answer 422 instead of 500.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubcontractError,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const SOV_A = "00000000-0000-4000-8000-00000000c001";
const SOV_B = "00000000-0000-4000-8000-00000000c002";

const base = {
  orgId: "org-1",
  userId: "user-1",
  payApplicationId: "00000000-0000-4000-8000-00000000c000",
  expectedRevision: 1,
};

async function refusal(input: unknown): Promise<string> {
  const error = await updateVendorPayApplicationLines(
    input as Parameters<typeof updateVendorPayApplicationLines>[0],
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(error instanceof SubcontractError, "malformed lines refuse with SubcontractError");
  return (error as Error).message;
}

test("missing, foreign-shaped, and empty line lists refuse without touching the database", async () => {
  for (const lines of [undefined, "nope", [], 42]) {
    assert.match(
      await refusal({ ...base, lines }),
      /non-empty array/,
      `lines=${JSON.stringify(lines)}`,
    );
  }
});

test("a non-object entry refuses naming its position", async () => {
  assert.match(await refusal({ ...base, lines: ["nope"] }), /line 1: a pay-application line object is required/);
});

test("a line without a uuid identity refuses naming its position", async () => {
  assert.match(
    await refusal({
      ...base,
      lines: [{ workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }],
    }),
    /line 1: sovLineId must be a valid uuid/,
  );
});

test("an unparseable work amount refuses naming the line and its identity", async () => {
  const message = await refusal({
    ...base,
    lines: [{ sovLineId: SOV_A, workCompletedThisPeriod: "ten", materialsStoredCurrent: "0" }],
  });
  assert.match(message, /line 1/);
  assert.match(message, new RegExp(SOV_A));
  assert.match(message, /work completed this period must be an exact decimal/);
});

test("an unparseable stored amount refuses naming the line and its identity", async () => {
  const message = await refusal({
    ...base,
    lines: [{ sovLineId: SOV_A, workCompletedThisPeriod: "10", materialsStoredCurrent: "1,000" }],
  });
  assert.match(message, /line 1/);
  assert.match(message, /materials stored current must be an exact decimal/);
});

test("a negative amount refuses naming the line", async () => {
  const message = await refusal({
    ...base,
    lines: [{ sovLineId: SOV_A, workCompletedThisPeriod: "-5", materialsStoredCurrent: "0" }],
  });
  assert.match(message, /line 1/);
  assert.match(message, /cannot be negative/);
});

test("a missing or non-integer revision token refuses before any line is read", async () => {
  for (const expectedRevision of [undefined, 0, -1, 1.5, "1"]) {
    assert.match(
      await refusal({
        ...base,
        expectedRevision,
        lines: [{ sovLineId: SOV_A, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }],
      }),
      /expectedRevision must be a positive integer/,
    );
  }
});

test("positions count from one across the whole submission", async () => {
  const message = await refusal({
    ...base,
    lines: [
      { sovLineId: SOV_A, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" },
      { sovLineId: SOV_B, workCompletedThisPeriod: "oops", materialsStoredCurrent: "0" },
    ],
  });
  assert.match(message, /line 2/);
  assert.match(message, new RegExp(SOV_B));
});
