import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for /me/benefits. Elections with the
// stored payroll amounts, open windows, and dependents render through the
// shared `table` block; elect and change ride URL-param dialogs posting to
// the Me routes, which delegate to the existing enrollment service. The
// page computes no amount — the loader renders stored figures only.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/self-service.ts", import.meta.url), "utf8");

test("me benefits renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMeBenefitsPage/, "page loads through the benefits loader");
  assert.match(view, /meBenefitsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("benefit rows render through the shared table block", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('elections'\)/, "elections read the loader-resolved rows");
  assert.match(view, /rows: f\('windows'\)/, "windows read the loader-resolved rows");
  assert.match(view, /rows: f\('dependents'\)/, "dependents read the loader-resolved rows");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
});

test("the primary action lives in the page header through the shared button", () => {
  const header = view.slice(view.indexOf("pageHeader("));
  assert.ok(header.indexOf("'link-button'") < header.indexOf("'module-home-tabs'"), "the link-button precedes the tab strip");
  assert.match(view, /hrm-benefit-dialog/, "elect rides the shared dialog widget");
  assert.match(view, /hrm-benefit-change-dialog/, "change rides the shared dialog widget");
});

test("the benefits loader scopes every row to the login and computes nothing", () => {
  assert.match(loader, /getMyBenefitsWorkspace\(\{\s*orgId/, "the page reads the self-service workspace, never an org list");
  assert.match(view, /requirePermission\('hrm\.self\.read'\)/, "page requires the self-service grant");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a switched-off hrm switch redirects to the feature remedy, never a bare 404");
});
