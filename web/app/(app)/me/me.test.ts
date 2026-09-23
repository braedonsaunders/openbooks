import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the Me overview (/me). Employment
// summary, open steps, pending requests, and balances render through the
// shared `table` block and the leave-balances widget exactly like the HR
// overview; the primary action is the shared 'link-button' FIRST in the
// header, then 'module-home-tabs'. The extension rail fills from the
// self-service registry — never a placeholder.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../lib/hrm/self-service.ts", import.meta.url), "utf8");

test("me overview renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMePage/, "page loads through the overview loader");
  assert.match(view, /meSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("overview rows render through the shared table block", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('employments'\)/, "employment reads the loader-resolved summaries");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
});

test("the primary action lives in the page header through the shared button", () => {
  const header = view.slice(view.indexOf("pageHeader("));
  assert.ok(header.indexOf("'link-button'") < header.indexOf("'module-home-tabs'"), "the link-button precedes the tab strip");
  assert.match(view, /hrm-leave-balances/, "balances still render through their widget");
  assert.match(view, /directory-section/, "the extension rail renders the shared directory section");
});

test("the overview loader scopes every row to the login", () => {
  assert.match(loader, /getMyProfile\(\{\s*orgId/, "the overview reads the self-service profile, never an org list");
  assert.match(loader, /getMySteps\(\{\s*orgId/, "steps read the self-service path");
  assert.match(loader, /getMyRequests\(\{\s*orgId/, "requests read the self-service path");
  assert.match(view, /requirePermission\('hrm\.self\.read'\)/, "page requires the self-service grant");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a switched-off hrm switch redirects to the feature remedy, never a bare 404");
});

// HR-14 begin: the viewer's own certifications needing action ride the
// same shared table block — type, expiry, and a status badge — resolved
// per own employment through the canonical qualification read, never an
// org list and never license numbers.
test("the overview carries the viewer's expiring certifications", () => {
  assert.match(view, /f\('qualificationsTitle'\)/, "the panel titles from the loader");
  assert.match(view, /rows: f\('qualifications'\)/, "rows read the loader-resolved qualifications");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.match(view, /f\('qualificationsEmpty'\)/, "the empty state resolves from the loader");
  assert.match(loader, /listQualifications\(db, \{\s*orgId, actorId: authz\.user\.id, employmentId/, "qualifications read per own employment through the canonical service");
});

test("the qualifications panel never pulls license numbers or notes", () => {
  const panel = view.slice(view.indexOf("f('qualificationsTitle')"), view.indexOf("f('qualificationsTitle')") + 1500);
  assert.doesNotMatch(panel, /identifier/, "license numbers stay on the HR page, never the me panel");
  assert.doesNotMatch(panel, /notes/, "free-text notes stay on the HR page, never the me panel");
  assert.match(loader, /q\.status === 'expiring' \|\| q\.status === 'expired'/, "only action-needed rows reach the viewer");
});
// HR-14 end
