import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the change-request queue
// (/hrm/change-requests). Runs without dependencies: it reads the
// maintained sources and proves the queue lists through the existing
// change-request service (never a direct table read), segments on the
// shared filter chips, opens the existing drawer, and reuses the existing
// actions and API refusals — gated on the hrm feature switch plus
// hrm.employment.read, with every label from the hrm catalog.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("./QueueClient.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/change-requests.ts", import.meta.url), "utf8");
const mapping = readFileSync(new URL("../../../../lib/hrm/queue-status.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("queue renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadChangeRequestQueuePage/, "page loads through the queue loader");
  assert.match(view, /changeRequestQueueSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
  assert.match(view, /filter-chips/, "status segments ride the shared filter chips");
  assert.match(view, /paramKey: 'status'/, "segments filter on the status search param");
  assert.match(view, /hrm-change-request-queue/, "rows render through the shared queue widget");
});

test("queue gates on the hrm feature switch plus the employment read grant", () => {
  assert.match(view, /requirePermission\('hrm\.employment\.read'\)/, "page requires the employment read grant");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "page checks the Company Settings Features switch");
  assert.match(view, /notFound\(\)/, "a disabled switch 404s instead of rendering a gated queue");
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

test("rows open the existing drawer and reuse the existing actions", () => {
  assert.match(client, /ChangeRequestDrawer/, "propose and edit open the existing authoring drawer");
  assert.match(client, /ChangeRequestActions/, "row actions reuse the existing lifecycle actions");
  assert.match(client, /\/api\/hrm\/options\?/, "the propose picker rides the existing options route");
  assert.match(client, /if \(!res\.ok\)/, "error bodies are checked before they are parsed");
});

test("queue widget is registered exactly once in every registry", () => {
  assert.match(widgets, /'hrm-change-request-queue'/, "widget renders the shared queue body, never a second copy");
  assert.match(contracts, /'hrm-change-request-queue': \{ props: \[/, "widget contract pins the prop surface");
  assert.match(names, /'hrm-change-request-queue'/, "widget name is registered");
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
