import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the audited Admin Users -> linked person
// workflow. Runs without dependencies: it reads the maintained sources and
// proves the UI uses the native Drawer + remote SearchSelect (per-query
// bounded search, selected preserved, stale races dropped), never a custom
// list/table, with localized labels, accessible controls, and res.ok before
// parsing plus toast/inline error on save.
const actions = readFileSync(new URL("./UserActions.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../../api/admin/users/route.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/admin.json", import.meta.url), "utf8");

test("link drawer uses the native Drawer and remote SearchSelect, never a custom list", () => {
  assert.match(actions, /<Drawer/, "link editor renders in the native Drawer shell");
  assert.match(actions, /<SearchSelect/, "person choice uses the native SearchSelect");
  assert.match(actions, /remote/, "search is remote per query, not a fixed first-N roster");
  assert.match(actions, /onSearchChange/, "typing forwards the query to the scoped server search");
  assert.match(actions, /loading=\{loading\}/, "remote lookup announces loading");
  assert.match(actions, /statusMessage/, "remote errors surface through the native status message");
  assert.match(
    actions,
    /requestId\.current/,
    "a sequence guard drops stale search responses so older results never overwrite newer ones",
  );
  assert.match(
    actions,
    /ensure\(payload\.selected\)|ensure\(selectedOption\)/,
    "the selected option is merged back when the page does not contain it",
  );
  assert.ok(!/<table/.test(actions), "the link drawer builds no custom table");
  assert.ok(!/PagedTable/.test(actions), "person choice does not fork a parallel roster table");
});

test("link save reaches the audited endpoint with concurrency, reason, and attestation", () => {
  assert.match(actions, /action: 'set-party'/, "save posts the native set-party action");
  assert.match(actions, /expectedPartyId/, "save carries the optimistic-concurrency token including null");
  assert.match(actions, /attestation: true/, "save carries the explicit human-identity attestation");
  assert.match(actions, /reason\.trim\(\)/, "save requires a nonblank reason");
  assert.match(
    actions,
    /if \(!res\.ok\)/,
    "API failure is detected with res.ok before parsing",
  );
  assert.match(actions, /await res\.json\(\)\.catch/, "payload parsing never throws on an error body");
  assert.match(actions, /toast\.error/, "failures toast through the existing channel");
  assert.match(actions, /role="alert"/, "failures also render an inline error");
  assert.match(actions, /router\.refresh\(\)/, "success refreshes the native list");
});

test("link form controls are localized and accessible", () => {
  assert.match(actions, /<Label htmlFor="link-person-search">/, "person picker has an associated label");
  assert.match(actions, /<Label htmlFor="link-person-reason">/, "reason has an associated label");
  assert.match(actions, /<Label htmlFor="link-person-attest">/, "attestation has an associated label");
  assert.match(actions, /ariaLabel=\{t\('linkPersonLabel'\)\}/, "picker exposes an accessible name");
  assert.match(actions, /title=\{t\('linkPersonTitle'/, "drawer title resolves from shared labels, never empty");
  for (const key of [
    "linkPersonButton",
    "linkPersonTitle",
    "linkPersonDescription",
    "linkAttestationLabel",
    "linkSelfRefused",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `shared en/admin labels carry ${key}`);
  }
});

test("users list shows the native link without a parallel roster", () => {
  assert.match(sections, /LinkPersonButton/, "row actions offer the native link editor");
  assert.match(sections, /linkedPerson/, "list carries a localized linked-person column");
  assert.match(view, /left join parties p on p\.id = u\.party_id/, "loader reads the native users.party_id join");
  assert.match(view, /partyId: u\.party_id/, "loader exposes the concurrency token per row");
  assert.ok(!view.includes("worker_employments"), "loader does not gate on the future canonical table");
});

test("set-party endpoint enforces attestation, active scope, self-refusal, and audited stale handling", () => {
  assert.match(route, /attestation !== true/, "absent/false attestation fails closed");
  assert.match(route, /select id, kind, display_name, is_active from parties/, "party validation reads active state");
  assert.match(route, /party is not active/, "inactive parties fail closed");
  assert.match(
    route,
    /you cannot change your own linked person/,
    "self-change is refused with an explicit separation-of-duties message",
  );
  assert.match(route, /stale link/, "stale expected reports 409");
  assert.match(route, /returning id/, "link update checks the precise affected-row count");
  assert.match(route, /before: \{ party_id: current \}/, "audit records the exact before link");
  assert.match(route, /after: \{ party_id: partyId \}/, "audit records the exact after link");
  assert.match(route, /attestation: true/, "audit records the attestation");
  assert.match(route, /party: partySignals/, "audit records kind/role signals without inferring identity");
});
