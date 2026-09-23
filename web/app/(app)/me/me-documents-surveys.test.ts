import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /me/documents and /me/surveys without booting
 * Next: source assertions over the page shells, the own-scope loaders,
 * and the inline action islands.
 */

const documentsView = readFileSync(new URL("./documents/view.ts", import.meta.url), "utf8");
const documentsPage = readFileSync(new URL("./documents/page.tsx", import.meta.url), "utf8");
const documentsSections = readFileSync(new URL("./documents/sections.tsx", import.meta.url), "utf8");
const documentsLoader = readFileSync(new URL("../../../lib/hrm/me-documents.ts", import.meta.url), "utf8");
const surveysView = readFileSync(new URL("./surveys/view.ts", import.meta.url), "utf8");
const surveysPage = readFileSync(new URL("./surveys/page.tsx", import.meta.url), "utf8");
const surveysSections = readFileSync(new URL("./surveys/sections.tsx", import.meta.url), "utf8");
const surveysLoader = readFileSync(new URL("../../../lib/hrm/me-surveys.ts", import.meta.url), "utf8");

test("me documents page renders own documents behind the documents switch", () => {
  assert.match(documentsLoader, /requireFeatureEnabled\(gate\.user\.orgId, 'hrmDocuments'\)/, "a switched-off documents switch redirects to the feature remedy, never a bare 404");
  assert.match(documentsLoader, /listOwnDocuments\(\{/, "rows resolve through the own-scope documents read");
  assert.match(documentsLoader, /listOwnExports\(\{/, "exports resolve through the own-scope export read");
  assert.match(documentsLoader, /hrmDataSubjectExport/, "the export request renders only while its switch is on");
  assert.match(documentsPage, /loadMeDocumentsPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(documentsPage, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(documentsView, /route: '\/me\/documents'/, "the spec names its own route for the registry");
  assert.match(documentsView, /widgetCell\('hrm-me-document-actions'/, "row actions render through the shared cell widget");
  assert.match(documentsView, /module-home-tabs/, "the header carries the Me tab strip");
});

test("me document islands sign and acknowledge in-session with refusals intact", () => {
  assert.match(documentsSections, /\/api\/hrm\/documents\/\$\{documentId\}\/sign/, "sign posts the typed name to the own-session route");
  assert.match(documentsSections, /\/api\/hrm\/documents\/\$\{documentId\}\/acknowledge/, "acknowledge posts to the own-session route");
  assert.match(documentsSections, /\/api\/hrm\/data-subject-exports'/, "the export request posts through the exports route");
  assert.match(documentsSections, /readApiErrorMessage/, "islands render refusals, never swallow them");
  assert.match(documentsSections, /!res\.ok/, "error bodies are checked before they are parsed");
  assert.match(documentsSections, /UrlDrawer/, "the export dialog closes by navigation");
  assert.ok(!documentsSections.includes('orgId') && !documentsSections.includes('actorId'), "no org, user, or Authz crosses into the client");
});

test("me surveys page lists open invitations with the respond link", () => {
  assert.match(surveysLoader, /requireFeatureEnabled\(gate\.user\.orgId, 'hrmSurveys'\)/, "a switched-off surveys switch redirects to the feature remedy, never a bare 404");
  assert.match(surveysLoader, /listOwnInvitations\(\{/, "rows resolve through the own-scope invitation read");
  assert.match(surveysPage, /loadMeSurveysPage\(\)/, "the page renders only after the view gate resolves");
  assert.match(surveysView, /route: '\/me\/surveys'/, "the spec names its own route for the registry");
  assert.match(surveysView, /widgetCell\('hrm-me-survey-respond'/, "respond renders through the shared cell widget");
  assert.match(surveysSections, /\/surveys\/invitations\/\$\{invitationId\}\/reissue/, "respond re-mints the token in-session");
  assert.match(surveysSections, /router\.push\(`\/survey\/\$\{body\.token\}`\)/, "respond navigates to the public response page");
  assert.match(surveysSections, /readApiErrorMessage/, "the island renders refusals, never swallows them");
  assert.match(surveysSections, /!res\.ok/, "error bodies are checked before they are parsed");
  assert.ok(!surveysSections.includes('orgId') && !surveysSections.includes('actorId'), "no org, user, or Authz crosses into the client");
});
