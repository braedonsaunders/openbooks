import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /me/compensation without booting Next: a linked
 * person with no band and no statement reads the page with its explicit
 * empty state (the pay-information request below is the next step), a
 * login with no employment reads the named no-link refusal — neither is
 * an ambiguous 404 — and content renders unchanged through the shared
 * primitives plus the two compensation widgets.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/compensation.ts", import.meta.url), "utf8");

test("linked with no content reads the empty state plus a next step, never a 404", () => {
  assert.doesNotMatch(view, /!data \|\| !data\.hasContent/, "no band and no statement must not 404");
  assert.match(view, /if \(!data\) return myCompRefusal\(authz\)/, "the loader's null converts to the named refusal");
  assert.match(view, /widgetBlock\(\s*'empty-state'/, "the states render through the house empty-state block");
  assert.match(view, /f\('showEmpty'\)/, "the no-content block shows exactly for linked-but-empty");
  assert.match(
    view,
    /widgetBlock\('hrm-pay-info-request', \{[\s\S]*?\}, f\('canRequest'\)\)/,
    "the pay-information request stays the next step while an employment resolves",
  );
  assert.match(view, /when: f\('hasContent'\)/, "the content panels hide without content");
  assert.match(loader, /showEmpty: !hasContent/, "the loader derives the empty flag from content");
  assert.match(
    loader,
    /canRequest: true/,
    "the loader marks the request applicable while an employment resolves",
  );
  assert.match(loader, /refusal: null/, "content rows carry no refusal");
});

test("an unlinked login reads the named no-link refusal, never a 404", () => {
  assert.match(
    view,
    /if \(!authz\) notFound\(\)/,
    "only a missing session 404s — the route genuinely does not exist there",
  );
  assert.match(loader, /if \(!person\.partyId\) return null/, "only an unlinked login reports null");
  assert.match(loader, /return myCompRefusal\(authz, 'no-employment'\)/, "a linked login with no employment gets its own refusal");
  assert.match(loader, /myComp\.noEmployment/, "the refusal names the create-employment remedy");
  assert.match(loader, /myComp\.notLinked/, "the refusal names the link-person remedy");
  assert.match(loader, /me\.refusedTitle/, "the refusal carries the shared self-service title");
  assert.match(loader, /canRequest: false/, "the refusal carries no employment to file against");
  assert.match(view, /f\('refusal'\)/, "the spec shows the refusal block exactly when the refusal is set");
});

test("my compensation composes the statements table and the request widget", () => {
  assert.match(view, /loadMyCompensation\(authz\)/, "the page resolves through the scoped loader");
  assert.match(view, /route: '\/me\/compensation'/, "the spec names its own route for the registry");
  assert.match(view, /table\(\{/, "statements render through the shared table block");
  assert.match(view, /variant: 'app'/, "the table uses the shared app table primitives");
  assert.match(view, /widgetBlock\('hrm-placement-summary'/, "placement renders through the shared widget");
  assert.match(view, /widgetBlock\('hrm-pay-info-request'/, "the request action renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the Me strip");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});
