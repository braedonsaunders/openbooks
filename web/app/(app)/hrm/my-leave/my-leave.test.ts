import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the self-service inbox
// (/hrm/my-leave). The inbox lists only the caller's own requests through
// the shared table block exactly like the org queue; balances stay a
// labelled list component (they are not a table); filing opens the same
// LeaveDrawer through the `file` search param.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const balances = readFileSync(new URL("./LeaveBalances.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/leave.ts", import.meta.url), "utf8");

test("my leave renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMyLeavePage/, "page loads through the inbox loader");
  assert.match(page, /searchParams/, "the page forwards search params for the URL-param dialog");
  assert.match(view, /myLeaveSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("inbox rows render through the shared table block", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('requests'\)/, "the table reads the loader-resolved inbox");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.match(view, /hrm-leave-dialog/, "detail and filing open the shared leave dialog island");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
});

test("filing lives in the page header through the shared button", () => {
  assert.match(view, /'link-button'/, "file rides the shared header button widget");
  assert.match(view, /f\('fileHref'\)/, "the button navigates to a loader-built href");
});

test("balances stay a labelled list — they are not a table", () => {
  assert.match(view, /hrm-leave-balances/, "balances still render through their widget");
  assert.ok(!/<table/.test(balances), "the balances list holds no hand-rolled table");
});

test("the inbox loader scopes every row to the login and resolves display cells", () => {
  assert.match(loader, /myLeaveRequests\(\{\s*orgId/, "the inbox reads the self-service path, never the org list");
  assert.match(view, /requirePermission\('hrm\.leave\.request'\)/, "page requires the self-service grant");
  assert.match(loader, /requestHref/, "inbox rows build their own request hrefs");
});
