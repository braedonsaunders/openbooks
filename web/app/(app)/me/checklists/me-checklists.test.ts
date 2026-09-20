import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Composition contract for Me checklists (/me/checklists): my steps through
// the shared `table` block with the complete action in a row-action island.
// Completion rides the existing step endpoint — the island posts there and
// renders the service refusal inline.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");

test("checklists render through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMeChecklistsPage/, "page loads through the checklists loader");
  assert.match(view, /meChecklistsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("steps render through the shared table block with an island action", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('rows'\)/, "the table reads the loader-resolved steps");
  assert.match(view, /widgetCell\('hrm-step-complete'/, "completion rides a row-action island, never a bespoke button");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
});

test("the complete island posts to the existing step endpoint", () => {
  const islands = readFileSync(new URL("../islands.tsx", import.meta.url), "utf8");
  assert.match(
    islands,
    /\/api\/hrm\/processes\/steps\/\$\{stepId\}\/complete/,
    "completion rides the existing step endpoint with unchanged evidence rules",
  );
  assert.match(islands, /if \(!res\.ok\)/, "error bodies are checked before they are parsed");
});
