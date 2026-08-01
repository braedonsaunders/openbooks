import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  NonJsonValueError,
  requestHash,
  toJsonValue,
} from "./idempotency-core";

test("canonical JSON is stable across object insertion order", () => {
  const left = { z: 3, nested: { b: 2, a: 1 }, a: [2, 1] };
  const right = { a: [2, 1], nested: { a: 1, b: 2 }, z: 3 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(requestHash(left), requestHash(right));
});

test("canonical JSON preserves array order and normalizes dates and bigint", () => {
  assert.deepEqual(toJsonValue({
    values: [2n, 1n],
    at: new Date("2026-07-31T12:00:00.000Z"),
    omitted: undefined,
  }), {
    at: "2026-07-31T12:00:00.000Z",
    values: ["2", "1"],
  });
  assert.notEqual(requestHash([1, 2]), requestHash([2, 1]));
});

test("canonical JSON rejects unsafe values", () => {
  assert.throws(() => canonicalJson({ amount: Number.NaN }), NonJsonValueError);
  assert.throws(() => canonicalJson({ handler: () => undefined }), NonJsonValueError);
});
