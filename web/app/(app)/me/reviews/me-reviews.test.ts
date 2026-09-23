import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for /me/reviews. Owed
// self-assessments, shared manager reviews with the acknowledge action,
// and own goals render through the shared `table` block; answering rides
// the existing performance drawer through row links, never a new write
// surface. No calibration ever renders — the loader strips it before the
// spec is built.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/self-service.ts", import.meta.url), "utf8");
const engine = readFileSync(new URL("../../../../../engine/src/hrm/self-service/my-work.ts", import.meta.url), "utf8");

test("me reviews renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMeReviewsPage/, "page loads through the reviews loader");
  assert.match(view, /meReviewsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("review rows render through the shared table block", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('selfRows'\)/, "self-assessments read the loader-resolved rows");
  assert.match(view, /rows: f\('sharedRows'\)/, "shared reviews read the loader-resolved rows");
  assert.match(view, /rows: f\('goalRows'\)/, "goals read the loader-resolved rows");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
});

test("answering rides the performance drawer and acknowledge rides a row island", () => {
  assert.match(view, /link\(item\('openLabel'\), item\('openHref'\)\)/, "self rows link to the existing drawer");
  assert.match(view, /hrm-review-acknowledge/, "shared rows carry the acknowledge island");
  assert.match(view, /hrm-goal-dialog/, "goals carry the progress dialog");
  assert.match(engine, /\/hrm\/performance\?cycle=/, "the engine builds drawer hrefs into its slices");
  assert.ok(!/calibratedRating|calibrationReason|managerGapCount/.test(view), "the spec never names a calibration field");
});

test("the reviews loader scopes every row to the login", () => {
  assert.match(loader, /getMyReviewWorkspace\(\{\s*orgId/, "the page reads the self-service workspace, never an org list");
  assert.match(view, /requirePermission\('hrm\.self\.read'\)/, "page requires the self-service grant");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a switched-off hrm switch redirects to the feature remedy, never a bare 404");
});
