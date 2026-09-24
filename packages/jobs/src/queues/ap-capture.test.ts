import assert from "node:assert/strict";
import test from "node:test";
import { apCaptureReprocessJobId } from "./ap-capture";

const ITEM = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";

test("reprocess queue identity is deterministic per item and attempt generation", () => {
  // A double-click or retried request reads the same attempt generation, so
  // both submissions must carry the same job id and dedupe in BullMQ.
  assert.equal(apCaptureReprocessJobId(ITEM, 0), apCaptureReprocessJobId(ITEM, 0));
  assert.equal(apCaptureReprocessJobId(ITEM, 3), apCaptureReprocessJobId(ITEM, 3));
});

test("a later attempt generation mints a new queue identity", () => {
  // The worker's claim increments attempts on every run: a legitimate
  // reprocess after a completed or failed run must never collapse onto a
  // retained completed job and be silently skipped.
  assert.notEqual(apCaptureReprocessJobId(ITEM, 3), apCaptureReprocessJobId(ITEM, 4));
  assert.notEqual(apCaptureReprocessJobId(ITEM, 0), apCaptureReprocessJobId("01904632-9c9a-7b1e-8f2a-1c3d5e7f9000", 0));
});

test("reprocess queue identity carries no wall-clock component", () => {
  const first = apCaptureReprocessJobId(ITEM, 2);
  assert.doesNotMatch(first, /\d{13,}/, "a millisecond timestamp would defeat dedupe");
  assert.equal(first, `ap-capture|${ITEM}|reprocess|a2`);
});

test("reprocess queue identity refuses unusable inputs", () => {
  assert.throws(() => apCaptureReprocessJobId("", 0));
  assert.throws(() => apCaptureReprocessJobId("   ", 0));
  assert.throws(() => apCaptureReprocessJobId(ITEM, -1));
  assert.throws(() => apCaptureReprocessJobId(ITEM, 1.5));
  assert.throws(() => apCaptureReprocessJobId(ITEM, Number.NaN));
});
