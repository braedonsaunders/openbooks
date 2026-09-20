import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/recruiting without booting Next: source
 * assertions over the page shell (gate placement, metadata, search-params
 * passthrough) and the loader/spec split between the view and the shared
 * drawer component.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.tsx", import.meta.url), "utf8");
const form = readFileSync(new URL("./RecruitingCreateForm.tsx", import.meta.url), "utf8");

test("recruiting page carries the gate where the route-gate scanner reads it", () => {
  assert.match(view, /requirePermission\('hrm\.recruiting\.read'\)/, "the page enforces the recruiting read grant, not the employment one");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "the page enforces the hrm switch with a 404");
  assert.match(page, /loadRecruitingPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("recruiting spec composes shared primitives: filter chips, table, URL drawer", () => {
  assert.match(view, /route: '\/hrm\/recruiting'/, "the spec names its own route for the registry");
  assert.match(view, /widgetBlock\('filter-chips'/, "segments render through the shared filter chips");
  assert.match(view, /paramKey: 'status'/, "segments filter over the status search param");
  assert.match(view, /table\(\{/, "the list renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the list uses the shared app table primitives");
  assert.match(view, /badge\(item\('statusLabel'\)/, "status renders through the shared badge cell");
  assert.match(view, /link\(item\('number'\), item\('href'\)\)/, "the number opens the drawer through the row href");
  assert.match(view, /widgetBlock\('hrm-recruiting-drawer'/, "the drawer renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(sections, /RecruitingDrawer/, "the drawer stays a shared component, never a copy");
  assert.match(sections, /UrlDrawer/, "the drawer closes by navigation");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the recruiting sections");
});

test("segments filter server-side and rows resolve through the read service", () => {
  assert.match(view, /listRequisitions\(\{/, "segments and rows resolve through the canonical recruiting read service");
  assert.match(view, /getRequisitionDetail\(\{/, "the drawer resolves one opening through the same service");
  assert.match(view, /getCandidateDetail\(\{/, "the candidate drawer resolves through the same service");
  assert.match(view, /getOfferDetail\(\{/, "the offer drawer resolves through the same service");
  assert.match(view, /sp\.status/, "the active segment comes from the query string");
  assert.match(view, /sp\.requisition/, "the open requisition comes from the query string");
  assert.match(view, /sp\.candidate/, "the open candidate comes from the query string");
  assert.match(view, /sp\.offer/, "the open offer comes from the query string");
  assert.match(view, /segmentOptions/, "filter options resolve in the loader with counts");
  assert.match(view, /currentParams/, "the query string survives a segment change");
  assert.match(view, /statusVariant/, "badge presentation resolves in the loader, never in render");
  assert.match(view, /closeHref/, "the drawer closes by navigation to the segment href");
  assert.ok(!/from hrm_requisitions/.test(view), "loader issues no direct requisition-table reads");
  assert.ok(!/from hrm_applications/.test(view), "loader issues no direct application reads");
});

// The header primary action and its create form (Braedon's review: no way to add an opening).
test("the header carries New requisition first, then the strip, behind the manage ref", () => {
  const add = view.indexOf("widget('link-button'");
  const tabs = view.indexOf("widget('module-home-tabs'");
  assert.ok(add > 0 && tabs > add, "the primary action precedes the tab strip");
  assert.match(view, /widget\('link-button', \{ href: f\('addHref'\), label: f\('addLabel'\), iconKey: 'plus' \}, f\('canManage'\)\)/);
  assert.match(view, /requisition === 'new' && canManage/, "the create form opens only for the manage grant");
  assert.match(form, /fetch\('\/api\/hrm\/recruiting\/requisitions'/, "the form posts through the requisitions route");
  assert.match(form, /readApiErrorMessage/, "the form renders refusals, never swallows them");
  assert.ok(!form.includes('<table'), "no table in the create form");
});

test("drawer islands post through the recruiting routes with refusals intact", () => {
  for (const island of [
    'ApplicationAttachIsland',
    'ApplicationActionsIsland',
    'InterviewScheduleIsland',
    'InterviewActionsIsland',
    'OfferCreateIsland',
    'OfferActionsIsland',
  ]) {
    assert.match(actions, new RegExp(`export function ${island}`), `${island} is a small client island`);
  }
  assert.match(actions, /(fetch|postJson)\('\/api\/hrm\/recruiting\/applications'/, "funnel acts post through the applications route");
  assert.match(actions, /(fetch|postJson)\('\/api\/hrm\/recruiting\/interviews'/, "interview acts post through the interviews route");
  assert.match(actions, /(fetch|postJson)\('\/api\/hrm\/recruiting\/offers'/, "offer acts post through the offers route");
  assert.match(actions, /readApiErrorMessage/, "islands render refusals, never swallow them");
  assert.match(actions, /!res\.ok/, "error bodies are checked before they are parsed");
  assert.match(sections, /from '@openbooks\/ui'/, "forms use the house primitives");
  assert.ok(!actions.includes('orgId') && !actions.includes('actorId'), "no org, user, or Authz crosses into the client");
});
