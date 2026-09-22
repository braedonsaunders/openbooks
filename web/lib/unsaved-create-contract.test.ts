import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Canonical unsaved-create contract, Parties + Projects slice.
//
// New/redirect open URL-controlled unsaved editable drawers (?partyNew=1 /
// ?projectNew=1, active default true). Cancel/close write nothing. Explicit
// Save is one idempotent audited POST to the collection endpoint. The
// inactive-placeholder draft flow is gone from every caller this slice owns.
//
// web/components/global-create-menu.tsx is OUT of this slice (parent-owned):
// it still mints drafts, so the draft endpoints stay until the parent
// rewires those four actions to the hrefs below and deletes the routes. The
// paired assertion at the bottom names that handoff — it fails the moment
// the menu stops referencing drafts, which is the signal to delete them.

const ROOT = process.cwd();

function src(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

const PARTY_BUTTON = "web/app/(app)/parties/NewPartyButton.tsx";
const PARTY_REDIRECT = "web/app/(app)/parties/NewPartyRedirect.tsx";
const PROJECT_BUTTON = "web/app/(app)/projects/NewProjectButton.tsx";
const PROJECT_REDIRECT = "web/app/(app)/projects/NewProjectRedirect.tsx";
const HRM_BUTTON = "web/app/(app)/hrm/NewHrmButton.tsx";
const PARTY_DRAWER = "web/app/(app)/parties/PartyDrawer.tsx";
const PROJECT_DRAWER = "web/app/(app)/projects/ProjectDrawer.tsx";
const PARTIES_VIEW = "web/app/(app)/parties/view.ts";
const ENTITIES_VIEW = "web/app/(app)/entities/[role]/view.ts";
const PROJECTS_VIEW = "web/app/(app)/projects/view.ts";
const PARTIES_ROUTE = "web/app/api/parties/route.ts";
const PROJECTS_ROUTE = "web/app/api/projects/route.ts";
const PARTIES_DRAFT_ROUTE = "web/app/api/parties/draft/route.ts";
const PROJECTS_DRAFT_ROUTE = "web/app/api/projects/draft/route.ts";
const GLOBAL_MENU = "web/components/global-create-menu.tsx";

const SLICE_CALLERS = [
  PARTY_BUTTON,
  PARTY_REDIRECT,
  PROJECT_BUTTON,
  PROJECT_REDIRECT,
  HRM_BUTTON,
  PARTY_DRAWER,
  PROJECT_DRAWER,
  PARTIES_VIEW,
  ENTITIES_VIEW,
  PROJECTS_VIEW,
  PARTIES_ROUTE,
  PROJECTS_ROUTE,
];

test("no caller in this slice mints inactive placeholder drafts", () => {
  for (const file of SLICE_CALLERS) {
    const body = src(file);
    assert.doesNotMatch(
      body,
      /api\/parties\/draft/,
      `${file} must not reference the parties draft endpoint`,
    );
    assert.doesNotMatch(
      body,
      /api\/projects\/draft/,
      `${file} must not reference the projects draft endpoint`,
    );
  }
  // The scanner above is not vacuous: the allowlisted owners still reference
  // the draft endpoints, and the scanner sees them.
  assert.match(src(GLOBAL_MENU), /api\/parties\/draft/);
  assert.match(src(GLOBAL_MENU), /api\/projects\/draft/);
  assert.match(src(PARTIES_DRAFT_ROUTE), /New party/);
  assert.match(src(PROJECTS_DRAFT_ROUTE), /New project/);
});

test("new and redirect open URL-controlled unsaved drawers with zero writes", () => {
  for (const [file, param] of [
    [PARTY_BUTTON, "partyNew"],
    [PARTY_REDIRECT, "partyNew"],
    [PROJECT_BUTTON, "projectNew"],
    [PROJECT_REDIRECT, "projectNew"],
  ] as const) {
    const body = src(file);
    assert.match(body, new RegExp(`${param}: '1'`), `${file} must open ?${param}=1`);
    assert.doesNotMatch(body, /fetch\(/, `${file} must perform zero writes on open`);
  }
  assert.match(src(HRM_BUTTON), /entities\/employees\?partyNew=1/);
  assert.doesNotMatch(src(HRM_BUTTON), /fetch\(/);
});

test("loaders serve the unsaved drawer only to managers, active by default", () => {
  for (const [file, param] of [
    [PARTIES_VIEW, "partyNew"],
    [ENTITIES_VIEW, "partyNew"],
    [PROJECTS_VIEW, "projectNew"],
  ] as const) {
    const body = src(file);
    assert.match(
      body,
      new RegExp(`pickString\\(sp\\.${param}\\) === '1' && canManage`),
      `${file} must gate ?${param}=1 on the manage grant`,
    );
    assert.match(body, /is_active: true/, `${file} must default the unsaved record to active`);
    assert.match(body, /createMode/, `${file} must hand the drawer its create mode`);
    assert.match(body, /closeHref/, `${file} must hand the drawer its list return URL`);
  }
});

test("drawers cancel with zero writes and save with one idempotent POST", () => {
  const party = src(PARTY_DRAWER);
  assert.match(party, /if \(createMode\) \{\n\s*clearRefusal\(\)\n\s*router\.push\(returnHref as never\)/);
  assert.match(party, /fetchAction\(`\/api\/parties`, \{\n\s*method: 'POST',/);
  assert.match(party, /'Idempotency-Key': requestIdRef\.current!/);

  const project = src(PROJECT_DRAWER);
  assert.match(project, /if \(createMode\) \{\n\s*router\.push\(returnHref as never\)/);
  assert.match(project, /fetch\('\/api\/projects', \{\n\s*method: 'POST',/);
  assert.match(project, /'Idempotency-Key': requestIdRef\.current/);
});

test("create routes refuse nameless payloads and replay only exact requests", () => {
  for (const file of [PARTIES_ROUTE, PROJECTS_ROUTE]) {
    const body = src(file);
    assert.match(body, /Idempotency-Key/);
    assert.match(body, /on conflict \(id\) do nothing/);
    assert.match(body, /idempotency_key_conflict/);
    assert.match(body, /insert into audit_log/);
    assert.match(body, /request_id/);
  }
  assert.match(src(PARTIES_ROUTE), /PLACEHOLDER_NAMES/);
  assert.match(src(PROJECTS_ROUTE), /name === 'New project'/);
});

test("handoff: draft endpoints stay exactly while the global menu mints drafts", () => {
  // The parent owns the menu. Rewire its four actions to the unsaved hrefs —
  //   /parties?partyNew=1, /entities/customers?partyNew=1&role=customer,
  //   /entities/vendors?partyNew=1&role=vendor,
  //   /entities/employees?partyNew=1&role=employee, /projects?projectNew=1 —
  // then delete the two draft routes and update this test to assert they are
  // gone. A menu that no longer references drafts with the routes still
  // present fails here on purpose: dead placeholder-minting endpoints must
  // not linger.
  const menu = src(GLOBAL_MENU);
  const menuMintsDrafts =
    menu.includes("/api/parties/draft") || menu.includes("/api/projects/draft");
  let routesExist = true;
  try {
    src(PARTIES_DRAFT_ROUTE);
    src(PROJECTS_DRAFT_ROUTE);
  } catch {
    routesExist = false;
  }
  assert.equal(
    routesExist,
    menuMintsDrafts,
    "draft endpoints and global-menu draft references must appear and disappear together",
  );
});
