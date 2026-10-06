import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the recruiting depth tabs: Interviews, Offers,
// Postings, and Pools ride /hrm/recruiting as ?tab= sub-tabs of the
// Recruiting module. Unknown tabs fall back to Applications (never an
// error) and selection hrefs are stable. The Hiring strip is the view-tab
// registry's and is covered with it; the tab services behind each surface
// stay covered by the engine recruiting tests, not doubled here.
const { hrefForDepth, resolveDepthTab } = await import("./depth-view.ts");

test("an unknown tab falls back to Applications", () => {
  assert.equal(resolveDepthTab("bogus"), "applications", "unknown tabs fall back");
  assert.equal(resolveDepthTab(undefined), "applications", "an absent tab is Applications");
  assert.equal(resolveDepthTab(123), "applications", "a non-string tab is Applications");
  assert.equal(resolveDepthTab("interviews"), "interviews", "a known tab resolves");
});

test("selection hrefs keep the tab and the selection", () => {
  assert.equal(hrefForDepth("openings", null), "/hrm/recruiting?tab=openings");
  assert.equal(hrefForDepth("interviews", { interview: "i-1" }), "/hrm/recruiting?tab=interviews&interview=i-1");
  assert.equal(hrefForDepth("offers", { offer: "o-9" }), "/hrm/recruiting?tab=offers&offer=o-9");
});
