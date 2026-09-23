import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the change-request queue
// (/hrm/change-requests). Runs without dependencies: it reads the
// maintained sources and proves the queue renders through the shared table
// block (variant 'app') over loader-resolved display cells, segments on the
// shared filter chips, carries the primary action in the page header, and
// opens the propose dialog from a URL param — with every label from the hrm
// catalog.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./ProposeChangeDialog.tsx", import.meta.url), "utf8");
const rowActions = readFileSync(new URL("./ChangeRequestRowActions.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/change-requests.ts", import.meta.url), "utf8");
const mapping = readFileSync(new URL("../../../../lib/hrm/queue-status.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("queue renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadChangeRequestQueuePage/, "page loads through the queue loader");
  assert.match(view, /changeRequestQueueSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("queue rows render through the shared table block, not a bespoke table", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  assert.ok(!/<table/.test(dialog), "the dialog island holds no hand-rolled table");
  assert.ok(!/<table/.test(rowActions), "the row-actions island holds no hand-rolled table");
  assert.ok(
    !existsSync(new URL("./QueueClient.tsx", import.meta.url)),
    "the hand-rolled queue table component is deleted",
  );
});

test("status segments ride the shared filter chips", () => {
  assert.match(view, /filter-chips/, "status segments ride the shared filter chips");
  assert.match(view, /paramKey: 'status'/, "segments filter on the status search param");
});

test("the primary action lives in the page header through the shared button", () => {
  assert.match(view, /'link-button'/, "propose rides the shared header button widget");
  assert.match(view, /f\('proposeHref'\)/, "the button navigates to a loader-built href");
  assert.match(view, /iconKey: 'plus'/, "the button carries the house plus icon");
  assert.match(
    view,
    /widget\(\s*'link-button'[\s\S]*?f\('canManage'\)/,
    "the propose button renders only when the viewer can manage",
  );
});

test("cells compose the shared primitives over loader-resolved display fields", () => {
  assert.match(view, /link\(item\('employeeLabel'\), item\('employeeHref'\)\)/, "employee opens the drawer href");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.match(
    view,
    /widgetCell\('hrm-change-request-actions'/,
    "row actions ride a client island only where a client is needed",
  );
  assert.match(loader, /employeeHref/, "the loader builds the employee drawer href");
  assert.match(loader, /kindLabel/, "the loader resolves the kind label");
  assert.match(loader, /statusVariant/, "the loader resolves the badge variant");
});

test("the propose dialog opens from a URL param and closes by navigating away", () => {
  assert.match(view, /hrm-propose-change-dialog/, "the dialog island renders in the page body");
  assert.match(view, /f\('proposeOpen'\)/, "the dialog opens only when the propose param is present");
  assert.match(loader, /proposeOpen/, "the loader derives the dialog state from the search params");
  assert.match(loader, /dialogCloseHref/, "the loader builds the dialog return href");
  assert.match(dialog, /router\.push\(closeHref/, "closing the dialog navigates the param away");
  assert.match(dialog, /ChangeRequestDrawer/, "propose hands off to the existing authoring drawer");
  assert.match(dialog, /\/api\/hrm\/options\?/, "the propose picker rides the existing options route");
  assert.match(dialog, /if \(!res\.ok\)/, "error bodies are checked before they are parsed");
});

test("queue gates on the hrm feature switch plus the employment read grant", () => {
  assert.match(view, /requirePermission\('hrm\.employment\.read'\)/, "page requires the employment read grant");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a switched-off hrm switch redirects to the feature remedy, never a bare 404");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a disabled switch redirects to the feature remedy instead of rendering a gated queue");
  assert.match(loader, /loadChangeRequestQueue\(\s*authz/, "loader takes the authorized session, never re-gates");
});

test("the queue list comes from the existing service, never a table read", () => {
  assert.match(loader, /listChangeRequests\(/, "the list resolves through the change-request service");
  assert.ok(!/from hrm_employment_change_requests/.test(loader), "loader issues no direct request-table reads");
  assert.ok(!/from worker_employment_versions/.test(loader), "loader issues no direct version reads");
  assert.match(loader, /order|newest/i, "loader documents the newest-first ordering it inherits");
});

test("unknown segments and scope denials render as refusals, never empty tables", () => {
  assert.match(mapping, /UNKNOWN_QUEUE_STATUS/, "an unknown segment is a coded refusal");
  assert.match(loader, /HrmAuthorizationError/, "a subsidiary-scope denial is caught, never a partial list");
  assert.match(loader, /refusal/, "refusals travel as data the page renders");
  assert.match(view, /empty-state/, "the refusal renders with its message intact");
});

test("queue widgets are registered exactly once in every registry", () => {
  for (const name of ['hrm-change-request-actions', 'hrm-propose-change-dialog']) {
    assert.match(widgets, new RegExp(`'${name}'`), `${name} renders its island, never a second copy`);
    assert.match(contracts, new RegExp(`'${name}': \\{ props: \\[`), `${name} contract pins the prop surface`);
    assert.match(names, new RegExp(`'${name}'`), `${name} is registered`);
  }
  assert.ok(!widgets.includes('hrm-change-request-queue'), "the bespoke queue widget is deleted");
  assert.ok(!names.includes('hrm-change-request-queue'), "the bespoke queue widget name is unregistered");
});

test("queue copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "title",
    "listTitle",
    "segmentsLabel",
    "allLabel",
    "emptyTitle",
    "proposeButton",
    "notAvailable",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries queue.${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
