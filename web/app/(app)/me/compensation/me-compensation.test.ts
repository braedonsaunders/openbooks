import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /me/compensation without booting Next: the page
 * 404s unless hrmCompensation is on and the person has a band or a
 * statement, and composes only shared primitives plus the two
 * compensation widgets.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("my compensation hides unless the person has something to see", () => {
  assert.match(view, /loadMyCompensation\(authz\)/, "the page resolves through the scoped loader");
  assert.match(view, /!data \|\| !data\.hasContent/, "the page 404s with no band and no statement");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("my compensation composes the statements table and the request widget", () => {
  assert.match(view, /route: '\/me\/compensation'/, "the spec names its own route for the registry");
  assert.match(view, /table\(\{/, "statements render through the shared table block");
  assert.match(view, /variant: 'app'/, "the table uses the shared app table primitives");
  assert.match(view, /widgetBlock\('hrm-placement-summary'/, "placement renders through the shared widget");
  assert.match(view, /widgetBlock\('hrm-pay-info-request'/, "the request action renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the Me strip");
});
