import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCountTransition,
  countVariance,
  parseCountStatus,
} from "./stock-counts.ts";
import { InventoryError } from "./inventory.ts";

/**
 * Stock-count lifecycle guards, proved without a database: variance math and
 * every status refusal must fire with a remedy-naming message. These are the
 * properties worth guarding — a test that still passed with the guard blind
 * would not be testing the guard.
 */

test("variance is counted minus expected, never float math", () => {
  assert.equal(countVariance("10.5", "8.25"), "2.2500");
  assert.equal(countVariance("8.25", "10.5"), "-2.2500");
  assert.equal(countVariance("7", "7"), "0.0000");
  // Exact decimals: the classic 0.1 + 0.2 trap stays exact.
  assert.equal(countVariance("0.3", "0.1"), "0.2000");
});

test("variance refuses junk with a named InventoryError, not a bare Error", () => {
  assert.throws(() => countVariance("twelve", "8"), (e: unknown) => {
    assert.ok(e instanceof InventoryError);
    assert.match((e as Error).message, /counted quantity/i);
    return true;
  });
  // Thousands separators are refused rather than coerced: silently stripping
  // "," is how 1,234 becomes 1234 in a quantity.
  assert.throws(() => countVariance("1,234", "8"), /exact decimal/i);
});

test("the happy lifecycle transitions pass", () => {
  assertCountTransition("draft", "counting");
  assertCountTransition("counting", "review");
  assertCountTransition("review", "posted");
  assertCountTransition("review", "counting");
  assertCountTransition("draft", "cancelled");
  assertCountTransition("counting", "cancelled");
  assertCountTransition("review", "cancelled");
});

test("posting twice refuses with the immutability remedy", async () => {
  await assert.rejects(
    (async () => assertCountTransition("posted", "posted"))(),
    (e: unknown) => {
      assert.ok(e instanceof InventoryError);
      // The refusal must name the remedy, and the remedy (a NEW count) must
      // exist — createStockCount is the surface it points at.
      assert.match((e as Error).message, /already posted/i);
      assert.match((e as Error).message, /new count/i);
      return true;
    },
    "posting a posted count must be refused",
  );
});

test("posting a draft names the lifecycle remedy, not just the states", async () => {
  await assert.rejects(
    (async () => assertCountTransition("draft", "posted"))(),
    /start the count first/i,
    "a draft→posted attempt must name the first step",
  );
  await assert.rejects(
    (async () => assertCountTransition("counting", "posted"))(),
    /submit .* review/i,
    "a counting→posted attempt must name review as the missing step",
  );
});

test("resurrecting finished counts refuses by name", () => {
  // posted → counting would rewrite immutable history; cancelled → anything
  // would reuse a dead count. Both must name the new-count remedy.
  assert.throws(() => assertCountTransition("posted", "counting"), /new count/i);
  assert.throws(() => assertCountTransition("cancelled", "review"), /new count/i);
  assert.throws(() => assertCountTransition("cancelled", "cancelled"), /already cancelled/i);
});

test("unknown statuses fail closed, never pass through", () => {
  assert.throws(() => parseCountStatus("archived"), /unknown stock count status/i);
  assert.throws(() => parseCountStatus(null), /unknown stock count status/i);
  assert.equal(parseCountStatus("review"), "review");
});
