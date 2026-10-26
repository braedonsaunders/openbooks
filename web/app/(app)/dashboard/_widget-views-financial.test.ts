import assert from "node:assert/strict";
import test from "node:test";
import { trendTileContext } from "./_widget-views-financial";

// The revenue headline is one month's figure, so its context names the
// dashboard period beside the trailing chart span; the margin tile carries
// no headline, so the span alone stays unambiguous.
test("the revenue trend context names the dashboard period beside the trailing span", () => {
  assert.equal(
    trendTileContext({ margin: false, periodLabel: "November 2026", span: "12 months" }),
    "November 2026 · 12 months",
  );
});

test("the margin trend context keeps the span alone", () => {
  assert.equal(
    trendTileContext({ margin: true, periodLabel: "November 2026", span: "12 months" }),
    "12 months",
  );
});
