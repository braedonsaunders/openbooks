import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native authoring contract for employment change requests from the
// Employment tab (Slice F). Runs without dependencies: it reads the
// maintained sources and proves the drawer posts the exact API body shapes
// for each payload kind (mirroring the zod contract in
// engine/src/hrm/change-requests.ts via web/app/api/hrm/change-requests/bodies.ts),
// that API refusals reach the UI with res.ok checked before parsing (toast +
// inline error, never swallowed), that terminal statuses expose no actions,
// and that withdraw/submit carry the required reason — every label from the
// hrm catalog.
const drawer = readFileSync(new URL("./ChangeRequestDrawer.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./ChangeRequestActions.tsx", import.meta.url), "utf8");
const tab = readFileSync(new URL("./EmploymentTab.tsx", import.meta.url), "utf8");
const partiesDrawer = readFileSync(new URL("../parties/PartyDrawer.tsx", import.meta.url), "utf8");
const entityView = readFileSync(new URL("../entities/[role]/view.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../messages/en/hrm.json", import.meta.url), "utf8");

test("authoring drawer uses the native Drawer shell and house field primitives", () => {
  assert.match(drawer, /<Drawer/, "proposal editor renders in the native Drawer shell");
  assert.match(
    drawer,
    /from '@openbooks\/ui'/,
    "field primitives come from the shared UI package, never local markup",
  );
  assert.match(drawer, /SearchSelect/, "department choice uses the native SearchSelect");
  assert.match(drawer, /<Select/, "kind and status choices use the house Select");
  assert.match(drawer, /<Textarea/, "the reason uses the house Textarea");
  assert.match(drawer, /useTranslations\('hrm'\)/, "every string resolves from the hrm catalog");
});

test("kind selector mirrors the four governed payload kinds exactly", () => {
  for (const kind of ["hire", "status_change", "assignment_change", "termination"]) {
    assert.ok(drawer.includes(`'${kind}'`), `drawer offers the ${kind} kind`);
  }
  assert.match(drawer, /assignmentKey/, "assignment change names its slot key");
  assert.match(drawer, /jobTitle/, "assignment change carries a job title");
  assert.match(drawer, /departmentId/, "assignment change carries a department reference");
  assert.match(drawer, /locationId/, "assignment change carries a location reference");
  assert.match(drawer, /managerEmploymentId/, "assignment change carries the line-manager repoint");
  assert.match(drawer, /effectiveDate/, "termination names its civil effective date");
  assert.match(drawer, /effectiveFrom/, "dated kinds name their effective start");
});

test("manager and location ride remote SearchSelects over the options route, never uuid boxes", () => {
  assert.match(drawer, /api\/hrm\/options/, "pickers read the native HRM options route");
  assert.match(drawer, /'source', 'employments'/, "the manager picker pages employments");
  assert.match(drawer, /'source', 'locations'/, "the location picker pages native locations");
  assert.match(drawer, /params\.set\('include'/, "the draft's stored value pins first under edit");
  assert.match(drawer, /remote/, "picker search is remote per query, not a fixed roster");
  assert.match(drawer, /onSearchChange/, "typing forwards the query to the scoped server search");
  assert.match(drawer, /statusMessage/, "picker lookup errors surface through the native status message");
  assert.match(
    drawer,
    /(managerRequestId|locationRequestId)\.current/,
    "a sequence guard drops stale picker responses so older results never overwrite newer ones",
  );
  assert.match(
    drawer,
    /managerEmploymentId \? \{ managerEmploymentId \}/,
    "the payload carries the picked manager employment id",
  );
  assert.match(drawer, /locationId \? \{ locationId \}/, "the payload carries the picked location id");
  assert.ok(!/<Input[^>]*id="cr-manager"/s.test(drawer), "no raw uuid text box takes the manager");
  assert.ok(!/<Input[^>]*id="cr-location"/s.test(drawer), "no raw uuid text box takes the location");
});

test("create posts the exact collection body shape, edit patches the payload shape", () => {
  assert.match(
    drawer,
    /fetch\(`\/api\/hrm\/change-requests`, \{\s*method: 'POST'/,
    "create posts the native collection route",
  );
  assert.match(
    drawer,
    /JSON\.stringify\(\{\s*employmentId,\s*payload(: payload)?\s*\}\)/,
    "create body is exactly { employmentId, payload }",
  );
  assert.match(
    drawer,
    /fetch\(`\/api\/hrm\/change-requests\/\$\{/,
    "edit and lifecycle calls address the single-request route",
  );
  assert.match(drawer, /method: 'PATCH'/, "draft edit uses PATCH");
  assert.match(
    drawer,
    /JSON\.stringify\(\{\s*payload(: payload)?\s*\}\)/,
    "patch body is exactly { payload }",
  );
  assert.match(drawer, /\/submit/, "submit rides the native submit route");
  assert.match(drawer, /JSON\.stringify\(\{\s*reason/, "submit body carries the reason");
});

test("civil dates travel verbatim — no Date coercion touches a payload date", () => {
  const dateInputs = drawer.match(/type="date"/g) ?? [];
  assert.ok(dateInputs.length >= 3, `drawer edits dates through native date controls (found ${dateInputs.length})`);
  const dateConstructions = drawer.match(/new Date\(/g) ?? [];
  assert.ok(
    dateConstructions.length <= 1,
    "at most one Date construction exists in the drawer (the today default)",
  );
  assert.match(drawer, /toISOString\(\)\.slice\(0, 10\)/, "the only default date is today's civil date");
  assert.ok(!/Date\.parse/.test(drawer), "no Date.parse touches a payload date");
  assert.ok(!/Number\(fte/.test(drawer), "FTE renders and posts as the exact stored text, never through Number");
  assert.ok(!/parseFloat/.test(drawer), "no parseFloat touches FTE");
});

test("refusals from the API render with their message intact", () => {
  for (const [name, source] of [["drawer", drawer], ["actions", actions]] as const) {
    assert.match(source, /if \(!res\.ok\)/, `${name}: API failure is detected with res.ok before parsing`);
    assert.match(source, /await res\.json\(\)\.catch/, `${name}: payload parsing never throws on an error body`);
    assert.match(source, /readApiErrorMessage/, `${name}: error bodies surface the server message with a status fallback`);
    assert.match(source, /toast\.error/, `${name}: failures toast through the existing channel`);
    assert.match(source, /role="alert"/, `${name}: failures also render an inline error`);
  }
});

test("submit and withdraw require the reason the service enforces", () => {
  assert.match(
    actions,
    /change-requests\/\$\{requestId\}\/\$\{action\}/,
    "submit and withdraw ride the native single-request lifecycle routes",
  );
  assert.match(actions, /action: 'submit' \| 'withdraw'/, "one reason drawer serves both lifecycle calls");
  assert.match(actions, /method: 'POST'/, "lifecycle calls post");
  assert.match(actions, /reason\.trim\(\)/, "an empty reason never leaves the client silently");
  assert.match(actions, /reasonRequired/, "a blank reason renders the catalog refusal locally");
  assert.match(drawer, /reason\.trim\(\)/, "submit-for-approval requires the non-blank reason the service enforces");
});

test("row actions follow the service status rules — terminal rows show none", () => {
  for (const status of ["approved", "rejected", "withdrawn", "applied"]) {
    assert.ok(actions.includes(`'${status}'`), `actions know the terminal ${status} status`);
  }
  assert.match(actions, /TERMINAL/, "terminal membership is named once, not repeated per row");
  assert.match(actions, /status === 'draft'/, "draft-only actions are gated on the draft status");
  assert.match(actions, /pending_approval/, "pending rows keep their withdraw path");
  assert.ok(!/fetch\(.*?decide/.test(actions), "decisions stay in native Approvals — no decide call");
  assert.ok(!/approveChangeRequest|decideApproval/.test(actions), "no approval execution rides the authoring surface");
});

test("the Employment tab gates authoring on the manage grant — readers see the list only", () => {
  assert.match(tab, /canManageHrm/, "the tab takes the manage grant as a prop");
  assert.match(tab, /proposeButton/, "the propose action labels from the catalog");
  assert.match(tab, /ChangeRequestActions/, "rows render the native lifecycle actions");
  assert.match(tab, /href="\/approvals"/, "bound runs still link to the native approvals surface");
  assert.ok(!/decide/.test(tab), "no approval decision rides the Employment tab");
  assert.match(partiesDrawer, /canManageHrm/, "the drawer passes the manage grant to the Employment tab");
  assert.match(entityView, /hrm\.employment\.manage/, "the loader reads the employment manage grant");
});

test("authoring copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "proposeButton",
    "titleNew",
    "titleEdit",
    "kindLabel",
    "kindHire",
    "kindStatusChange",
    "kindAssignmentChange",
    "kindTermination",
    "statusLabel",
    "effectiveFromLabel",
    "effectiveToLabel",
    "effectiveDateLabel",
    "assignmentKeyLabel",
    "jobTitleLabel",
    "departmentLabel",
    "locationLabel",
    "locationUnset",
    "managerLabel",
    "managerUnset",
    "fteLabel",
    "primaryLabel",
    "reasonLabel",
    "reasonRequired",
    "saveDraft",
    "saveChanges",
    "submitForApproval",
    "submitTitle",
    "withdrawTitle",
    "withdrawConfirm",
    "editDraft",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries ${key}`);
  }
});

// Vendor/org/country neutrality for these files is enforced by the
// repository gate itself (npm run check:product-neutrality and
// check:country-neutrality scan every file): naming a vendor inside this
// test to assert its absence would itself trip that gate, so no fixture
// here quotes vendor or tenant names.
