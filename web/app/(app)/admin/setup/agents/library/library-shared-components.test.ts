import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Wave-4 UI consistency (shard c02): the Agents library must render the
// marketplace card grid (the /apps/library precedent — `repeat` over a card
// widget with the install action in its footer) instead of the monolithic
// `agents-library-workspace` island that hand-rolled its sections, detector
// lists and install flow with raw primitives.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const widgets = read("../../../../../../components/viewspec/widgets.tsx");

test("the library spec places a card grid bound to one pack-card widget", () => {
  assert.match(view, /repeat\(\{/);
  assert.match(view, /widgetBlock\('agents-pack-card'/);
  assert.doesNotMatch(view, /agents-library-workspace/);
  assert.equal(
    existsSync(new URL("./AgentsLibraryWorkspace.tsx", import.meta.url)),
    false,
    "the monolithic library island must be retired",
  );
});

test("the registry exposes the pack card and drops the workspace", () => {
  assert.match(widgets, /'agents-pack-card'/);
  assert.doesNotMatch(widgets, /agents-library-workspace/);
});

test("the loader resolves pack and detector display strings", () => {
  assert.match(view, /getTranslations\('admin'\)/);
  assert.match(view, /detectorSpecsForAgent/);
});
