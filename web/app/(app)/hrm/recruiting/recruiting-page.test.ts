import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the recruiting depth tabs: Interviews, Offers,
// Postings, and Pools ride /hrm/recruiting as ?tab= sub-tabs of the
// Recruiting module. Unknown tabs fall back to Openings (absent, never an
// error) and selection hrefs are stable. The Hiring strip is the view-tab
// registry's and is covered with it; the tab services behind each surface
// stay covered by the engine recruiting tests, not doubled here.
const { hrefForDepth, resolveDepthTab } = await import("./depth-view.ts");

test("an unknown tab falls back to Openings", () => {
  assert.equal(resolveDepthTab("bogus"), "openings", "unknown tabs fall back");
  assert.equal(resolveDepthTab(undefined), "openings", "an absent tab is Openings");
  assert.equal(resolveDepthTab(123), "openings", "a non-string tab is Openings");
  assert.equal(resolveDepthTab("interviews"), "interviews", "a known tab resolves");
});

test("selection hrefs keep the tab and the selection", () => {
  assert.equal(hrefForDepth("openings", null), "/hrm/recruiting?tab=openings");
  assert.equal(hrefForDepth("interviews", { interview: "i-1" }), "/hrm/recruiting?tab=interviews&interview=i-1");
  assert.equal(hrefForDepth("offers", { offer: "o-9" }), "/hrm/recruiting?tab=offers&offer=o-9");
});
