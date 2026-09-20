import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/processes without booting Next: source
 * assertions over the page shell (gate placement, metadata, nothing leaked
 * from the loader into the component) and the write/read authority split
 * between the loader and the client panel.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../processes-client.tsx", import.meta.url), "utf8");

test("processes page carries the gate where the route-gate scanner reads it", () => {
  assert.match(view, /requirePermission\('hrm\.process\.read'\)/, "the page enforces the process read grant, not the employment one");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "the page enforces the hrm switch with a 404");
  assert.match(page, /loadProcessesRoute\(\)/, "the page renders only after the view gate resolves");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("processes spec is chrome-only: the list resolves client-side", () => {
  assert.match(view, /widgetBlock\('hrm-processes', \{\}\)/, "the list widget takes no ids — segments fetch the collection");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.doesNotMatch(view, /listProcesses|getProcess\(/, "the spec resolves no rows; the client fetches the API");
});

test("the client panel checks refusals before parsing, on every action", () => {
  for (const path of [
    "/api/hrm/processes?segment=",
    "/api/hrm/processes/${processId}",
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
