import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t11-003 wiring pins (database-free): the billing quick filter must keep
// its tenant type loader, and the shared list view must merge loaded options
// behind the static translated ones and consult them for cell labels. Loader
// behavior itself is covered by project-type-options.integration.test.ts.
// Only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { entityListSource } = await import("./entity-sources.ts");

const view = readFileSync(new URL("../../components/entity-list-view.tsx", import.meta.url), "utf8");

test("the billing filter carries a tenant type loader", () => {
  const billing = entityListSource("project")?.quickFilters?.find((filter) => filter.filterKey === "project_type");
  assert.equal(typeof billing?.loadOptions, "function", "custom type keys resolve to names");
});

test("the list merges loaded options and labels cells from them", () => {
  assert.match(view, /loaded\.filter\(\(option\) => !seen\.has\(option\.value\)\)/, "loaded options merge behind statics");
  assert.match(view, /if \(loaded\) return loaded\.label/, "cells prefer the loaded label");
});
