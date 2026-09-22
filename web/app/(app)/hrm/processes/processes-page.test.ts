import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/processes without booting Next: source
 * assertions over the page shell (gate placement, metadata, search-params
 * passthrough) and the loader/spec split between the view and the shared
 * section components.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/processes-page.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../processes-client.tsx", import.meta.url), "utf8");
const create = readFileSync(new URL("./ProcessCreateDrawer.tsx", import.meta.url), "utf8");
const newMenu = readFileSync(new URL("./ProcessNewMenu.tsx", import.meta.url), "utf8");
const templateDrawer = readFileSync(new URL("./templates/ProcessTemplateDrawer.tsx", import.meta.url), "utf8");
const templatePage = readFileSync(new URL("./templates/page.tsx", import.meta.url), "utf8");

test("processes page carries the gate where the route-gate scanner reads it", () => {
  assert.match(view, /requirePermission\('hrm\.process\.read'\)/, "the page enforces the process read grant, not the employment one");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "the page enforces the hrm switch with a 404");
  assert.match(page, /loadProcessesRoute\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("processes spec composes shared primitives: list toolbar, table, URL drawer", () => {
  assert.match(view, /route: '\/hrm\/processes'/, "the spec names its own route for the registry");
  assert.match(view, /widgetBlock\('list-toolbar'/, "filters ride the shared list toolbar, never a lone dropdown over a bare table");
  assert.doesNotMatch(view, /widgetBlock\('filter-chips'/, "no second filter treatment beside the toolbar");
  assert.match(view, /paramKey: 'segment'/, "segments filter over the segment search param");
  assert.match(view, /table\(\{/, "the list renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the list uses the shared app table primitives");
  assert.match(view, /badge\(item\('statusLabel'\)/, "status renders through the shared badge cell");
  assert.match(view, /widgetBlock\('hrm-process-drawer'/, "the drawer renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(sections, /from '\.\.\/processes-client'/, "the drawer body is the shared client component, never a copy");
  assert.match(sections, /UrlDrawer/, "the drawer closes by navigation");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the process sections");
});

test("segments filter server-side and rows resolve through the read service", () => {
  assert.match(loader, /listProcesses\(\{/, "segments and rows resolve through the canonical process read service");
  assert.match(loader, /getProcess\(\{/, "the drawer resolves one checklist through the same service");
  assert.match(loader, /sp\.segment/, "the active segment comes from the query string");
  assert.match(loader, /sp\.process/, "the open checklist comes from the query string");
  assert.match(loader, /closeHref/, "the drawer closes by navigation to the segment href");
  assert.match(loader, /segmentOptions/, "filter options resolve in the loader with counts");
  assert.match(loader, /currentParams/, "the active segment survives inside the filter params");
  assert.match(loader, /statusVariant/, "badge presentation resolves in the loader, never in render");
  assert.ok(!/from hrm_processes /.test(loader), "loader issues no direct process-table reads");
  assert.ok(!/from hrm_process_steps/.test(loader), "loader issues no direct step-table reads");
});

test("the checklist body checks refusals before parsing, on every action", () => {
  for (const path of [
    "/api/hrm/processes/steps/${step.id}/complete",
    "/api/hrm/processes/steps/${reasonFor.stepId}/skip",
    "/api/hrm/processes/${detail.id}/complete",
    "/api/hrm/processes/${detail.id}/cancel",
  ]) {
    assert.ok(panel.includes(path), `the panel must call ${path}`);
  }
  assert.match(panel, /if \(!res\.ok\)/, "refusals are checked before parsing");
  assert.match(panel, /readApiErrorMessage\(res,/, "refusal messages render intact");
});

test("process managers can open a real, permission-gated checklist authoring flow", () => {
  assert.match(view, /hrm-process-new-menu/, "the header uses the shared New dropdown");
  assert.match(newMenu, /\/hrm\/processes\?new=1/, "the menu exposes the new-checklist entry point");
  assert.match(newMenu, /\/hrm\/processes\/templates\?template=new/, "the same menu exposes template creation");
  assert.match(view, /f\('canManage'\)/, "the create action is omitted without the manage grant");
  assert.match(view, /widgetBlock\('hrm-process-create'/, "creation renders through the registered drawer island");
  assert.match(loader, /can\(authz, 'hrm\.process\.manage'\)/, "the loader independently resolves the manage grant");
  assert.match(create, /SearchSelect/, "the employment picker pages and searches instead of truncating the roster");
  assert.match(create, /\/api\/hrm\/process-templates/, "the checklist picker loads eligible templates explicitly");
  assert.match(create, /templateId/, "the selected template crosses the create boundary");
  assert.match(create, /fetch\('\/api\/hrm\/processes'/, "the drawer posts the canonical process collection route");
  assert.ok(create.indexOf("if (!response.ok)") < create.indexOf("await response.json()"), "the API refusal is surfaced before success JSON is parsed");
});

test("template authoring is in HRM and create/edit share one drawer", () => {
  assert.match(templatePage, /requirePermission\('hrm\.process\.manage'\)/, "template authoring uses the process-management grant, not hidden Setup access");
  assert.match(templatePage, /ProcessTemplateDrawer/, "the template list mounts the shared editor");
  assert.match(templateDrawer, /creating \? 'POST' : 'PATCH'/, "one drawer owns both create and edit writes");
  assert.match(templateDrawer, /process-templates\/\$\{template\.id\}\/steps/, "template steps stay in the same authoring surface");
  assert.match(templateDrawer, /editDescription/, "the editor renders the snapshot-immutability explanation");
});
