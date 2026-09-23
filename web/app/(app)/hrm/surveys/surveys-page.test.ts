import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/surveys without booting Next: source
 * assertions over the page shell, the loader/spec split, and the
 * results/author islands (suppression marks, aggregate-only reads).
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/surveys-home.ts", import.meta.url), "utf8");

test("surveys page carries the gate where the route-gate scanner reads it", () => {
  assert.match(loader, /requirePermission\('hrm\.surveys\.manage'\)/, "the page enforces the surveys manage grant");
  assert.match(loader, /requireFeatureEnabled\(gate\.user\.orgId, 'hrmSurveys'\)/, "a switched-off surveys switch redirects to the feature remedy, never a bare 404");
  assert.match(page, /loadSurveysPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("surveys spec composes shared primitives: filter chips, table, drawer, dialog", () => {
  assert.match(view, /route: '\/hrm\/surveys'/, "the spec names its own route for the registry");
  assert.match(view, /widgetBlock\('filter-chips'/, "segments render through the shared filter chips");
  assert.match(view, /paramKey: 'status'/, "segments filter over the status search param");
  assert.match(view, /table\(\{/, "the register renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the list uses the shared app table primitives");
  assert.match(view, /tabular-nums/, "participation renders as tabular numerals");
  assert.match(view, /widgetBlock\('hrm-surveys-drawer'/, "the drawer renders through the shared widget");
  assert.match(view, /widgetBlock\('hrm-surveys-author-dialog'/, "the author dialog renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(sections, /UrlDrawer/, "the drawer and dialog close by navigation");
  assert.ok(!sections.includes('<table'), "the heatmap is the one deliberate table: colour-scaled cells the shared table cannot express");
});

test("rows and results resolve through the read services, aggregate only", () => {
  assert.match(loader, /listSurveys\(\{/, "the register resolves through the canonical surveys read service");
  assert.match(loader, /getSurveyResults\(\{/, "participation and the results panel share the results reader");
  assert.match(loader, /hrmTalentViewTabs/, "Surveys rides the Talent viewTabs so it stays findable after leaving the group strip");
  assert.match(loader, /getSurvey\(\{/, "the drawer resolves one survey through the same service");
  assert.match(loader, /sp\.survey/, "the open survey comes from the query string");
  assert.match(loader, /sp\.author/, "the author dialog opens through the query string");
  assert.ok(!/respondent/i.test(loader), "the loader never resolves respondent links");
  assert.ok(!/from hrm_survey_responses/.test(loader), "loader issues no direct response-table reads");
  assert.ok(!/from hrm_survey_invitations/.test(loader), "loader issues no direct invitation-table reads");
});

test("the results panel marks suppression and posts open/close through the routes", () => {
  assert.match(sections, /suppressed/, "suppressed cells carry the suppression mark, never a traceable figure");
  assert.match(sections, /heatColor/, "heatmap cells colour-scale the mean");
  assert.match(sections, /\?action=open/, "open posts through the survey route");
  assert.match(sections, /\?action=close/, "close posts through the survey route");
  assert.match(sections, /\/api\/hrm\/surveys'/, "authoring posts through the surveys route");
  assert.match(sections, /readApiErrorMessage/, "islands render refusals, never swallow them");
  assert.match(sections, /!res\.ok/, "error bodies are checked before they are parsed");
  assert.ok(!sections.includes('orgId') && !sections.includes('actorId'), "no org, user, or Authz crosses into the client");
});
