import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Composition contract for the Me profile (/me/profile): read-only facts
// through the shared facts widget, Edit in the header through the shared
// button, and the pending banner plus the edit drawer gated on loader
// booleans. No hand-rolled markup, no second profile surface.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");

test("profile renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMeProfilePage/, "page loads through the profile loader");
  assert.match(page, /searchParams/, "the page forwards search params for the URL-param drawer");
  assert.match(view, /meProfileSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("contact fields render through the shared facts widget with a drawer edit", () => {
  assert.match(view, /hrm-facts/, "facts render through the shared facts widget");
  assert.match(view, /'link-button'/, "edit rides the shared header button widget");
  assert.match(view, /f\('editHref'\)/, "the button navigates to a loader-built href");
  assert.match(view, /hrm-profile-dialog/, "edit opens the shared profile dialog island");
  assert.match(view, /when: f\('hasPending'\)/, "the pending banner renders only for a pending proposal");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  assert.ok(!/<input/.test(view), "the spec holds no hand-rolled form: fields live in the island");
});

test("the profile dialog submits through the self-service endpoint", () => {
  const islands = readFileSync(new URL("../islands.tsx", import.meta.url), "utf8");
  assert.match(islands, /\/api\/hrm\/me\/profile-changes/, "submit files through the profile-changes route");
  assert.match(islands, /\/api\/hrm\/me\/profile/, "fields prefill from the profile read");
  assert.match(islands, /if \(!res\.ok\)/, "error bodies are checked before they are parsed");
});
