import assert from "node:assert/strict";
import test from "node:test";
import { mergeOssUrlState, readOssUrlState } from "./view-state";

const defaults = {
  union: { from: "2026-01-01", to: "2026-03-31" },
  non_union: { from: "2026-01-01", to: "2026-03-31" },
  ioss: { from: "2026-01-01", to: "2026-01-31" },
};

test("OSS URL state reads valid settings and falls back for malformed values", () => {
  assert.deepEqual(
    readOssUrlState(
      new URLSearchParams("scheme=ioss&from=2024-02-29&to=2024-03-31&tab=fx"),
      defaults,
    ),
    { scheme: "ioss", from: "2024-02-29", to: "2024-03-31", tab: "fx" },
  );
  assert.deepEqual(
    readOssUrlState(
      new URLSearchParams("scheme=other&from=2026-02-30&to=nope&tab=other"),
      defaults,
    ),
    { scheme: "union", from: "2026-01-01", to: "2026-03-31", tab: "return" },
  );
});

test("OSS URL updates retain unrelated page context and the other selected filters", () => {
  assert.equal(
    mergeOssUrlState("tenant=west&scheme=union&from=2026-01-01&to=2026-03-31", {
      tab: "threshold",
    }),
    "tenant=west&scheme=union&from=2026-01-01&to=2026-03-31&tab=threshold",
  );
});
