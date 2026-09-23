import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the leave desk (/hrm/leave). Runs
// without dependencies: it reads the maintained sources and proves the queue
// renders through the shared table block (variant 'app') over
// loader-resolved display cells, segments on the shared filter chips, carries
// both primary actions in the page header, and opens the drawer from URL
// params — with every label from the hrm catalog. The department calendar is
// not a list and stays a component.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./LeaveDialog.tsx", import.meta.url), "utf8");
const calendar = readFileSync(new URL("./LeaveCalendar.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/leave.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("leave renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadLeaveQueuePage/, "page loads through the leave loader");
  assert.match(view, /leaveQueueSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("leave rows render through the shared table block, not a bespoke table", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  assert.ok(!/<table/.test(dialog), "the dialog island holds no hand-rolled table");
  assert.ok(!/<table/.test(calendar), "the calendar island holds no hand-rolled table");
  assert.ok(
    !existsSync(new URL("./LeaveQueue.tsx", import.meta.url)),
    "the hand-rolled queue table component is deleted",
  );
});

test("leave segments ride the shared list toolbar", () => {
  assert.match(view, /widgetBlock\('list-toolbar'/, "segments ride the shared toolbar");
  assert.match(view, /paramKey: 'segment'/, "segments filter on the segment search param");
  assert.doesNotMatch(view, /widgetBlock\('filter-chips'/, "no second filter treatment beside the toolbar");
});

test("requests and the department calendar are TABS, never stacked panels", () => {
  assert.match(view, /widgetBlock\('module-home-tabs', \{ tabs: data\.viewTabs \}\)/,
    "the view switch is the shared subtab strip");
  assert.match(view, /when: f\('onRequests'\)/, "the requests table renders only on its own tab");
  assert.match(view, /when: f\('onCalendar'\)/, "the calendar renders only on its own tab");
  // The defect this pins: the calendar used to render BELOW the requests
  // table on the same page, so a viewport-filling list sat on top of it.
  assert.ok(
    view.indexOf("when: f('onCalendar')") > view.indexOf("when: f('onRequests')"),
    "the two surfaces are alternatives, not a sequence",
  );
  // The calendar renders DAYS. Department/from/to are the shared toolbar's,
  // so the island takes no basePath, no currentParams and no options.
  assert.doesNotMatch(calendar, /method="get"/, "the calendar owns no filter form of its own");
  assert.doesNotMatch(calendar, /departmentOptions/, "the department picker is the toolbar's");
});

test("both primary actions live in the page header through the shared button", () => {
  assert.match(view, /f\('fileHref'\)/, "file navigates to a loader-built href");
  assert.match(view, /f\('recordHref'\)/, "record navigates to a loader-built href");
  assert.match(view, /f\('canFile'\)/, "the file button renders only with the request grant");
  assert.match(view, /f\('canRecord'\)/, "the record button renders only with the manage grant");
  assert.match(view, /variant: 'outline'/, "record is the secondary header action");
});

test("cells compose the shared primitives over loader-resolved display fields", () => {
  assert.match(view, /link\(item\('employeeLabel'\), item\('employeeHref'\)\)/, "employee opens the drawer href");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.match(view, /link\(item\('openLabel'\), item\('requestHref'\)\)/, "each row opens its request");
  assert.match(view, /align: 'right'/, "hours align right");
  assert.match(loader, /employeeHref/, "the loader builds the employee drawer href");
  assert.match(loader, /statusVariant/, "the loader resolves the badge variant");
  assert.match(loader, /requestHref/, "the loader builds the per-row request href");
});

test("the drawer opens from URL params and closes by navigating away", () => {
  assert.match(view, /hrm-leave-dialog/, "the dialog island renders in the page body");
  assert.match(view, /f\('dialogOpen'\)/, "the dialog opens only when a file/record/request param is present");
  assert.match(loader, /dialogOpen/, "the loader derives the dialog state from the search params");
  assert.match(loader, /dialogCloseHref/, "the loader builds the dialog return href");
  assert.match(dialog, /LeaveDrawer/, "file and detail open the existing drawer");
  assert.match(dialog, /router\.push\(closeHref/, "closing the dialog navigates the params away");
});

test("the calendar stays a component — it is not a list", () => {
  assert.match(view, /hrm-leave-calendar/, "the calendar still renders through its widget");
  assert.equal((view.match(/table\(\{/g) ?? []).length, 1, "exactly one table block exists: the queue");
  assert.ok(!/<table/.test(calendar), "the calendar holds no hand-rolled table");
});

test("leave gates on the hrm feature switch plus the leave read grant", () => {
  assert.match(view, /requirePermission\('hrm\.leave\.read'\)/, "page requires the leave read grant");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a switched-off hrm switch redirects to the feature remedy, never a bare 404");
  assert.match(view, /requireFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "a disabled switch redirects to the feature remedy instead of rendering a gated queue");
  assert.match(loader, /loadLeaveQueue\(\s*authz/, "loader takes the authorized session, never re-gates");
});

test("the leave list comes from the existing service, never a table read", () => {
  assert.match(loader, /listOrgLeaveRequests\(/, "the list resolves through the leave read service");
  assert.ok(!/from hrm_leave_requests/.test(loader), "loader issues no direct request-table reads");
});

test("unknown segments and scope denials render as refusals, never empty tables", () => {
  assert.match(loader, /unknownSegment/, "an unknown segment is a refusal naming the segment");
  assert.match(loader, /HrmAuthorizationError/, "a subsidiary-scope denial is caught, never a partial list");
  assert.match(loader, /refusal/, "refusals travel as data the page renders");
  assert.match(view, /empty-state/, "the refusal renders with its message intact");
});

test("the leave dialog widget is registered exactly once in every registry", () => {
  assert.match(widgets, /'hrm-leave-dialog'/, "the dialog widget renders its island, never a second copy");
  assert.match(contracts, /'hrm-leave-dialog': \{ props: \[/, "the dialog contract pins the prop surface");
  assert.match(names, /'hrm-leave-dialog'/, "the dialog widget name is registered");
  assert.ok(!widgets.includes('hrm-leave-queue'), "the bespoke queue widget is deleted");
  assert.ok(!names.includes('hrm-leave-queue'), "the bespoke queue widget name is unregistered");
});

test("leave copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "title",
    "listTitle",
    "segmentsLabel",
    "allLabel",
    "emptyTitle",
    "fileButton",
    "recordButton",
    "openRequest",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries leave.${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
