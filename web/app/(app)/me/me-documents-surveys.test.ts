import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the documents and surveys pages (/me/documents,
// /me/surveys). Both spec builders run over hand-built data: an unlinked
// login reads the refusal state with its remedy, and each page carries
// its action surfaces (sign/acknowledge/export on documents, respond on
// surveys) through the shared widgets. Evidence-link redaction and
// respondent anonymity stay covered by the engine documents and surveys
// tests, which own the service shapes — these specs render what the
// loaders carry, never more.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meDocumentsSpec } = await import("./documents/view.ts");
const { meSurveysSpec } = await import("./surveys/view.ts");

const TABS = [{ label: "Documents", href: "/me/documents" }];

function documentsData(): Record<string, unknown> {
  return {
    tabs: TABS,
    refusal: null,
    columns: {},
    exportColumns: {},
    partyId: "party-1",
    acknowledgeLabel: "Acknowledge",
    actionFailed: "Action failed",
    downloadLabel: "Download",
    requestExportDone: "Export requested",
    requestExportLabel: "Request export",
    signLabel: "Sign",
    signNameLabel: "Full name",
  } as unknown as Record<string, unknown>;
}

function surveysData(): Record<string, unknown> {
  return {
    tabs: [{ label: "Surveys", href: "/me/surveys" }],
    refusal: null,
    columns: {},
    actionFailed: "Action failed",
    respondLabel: "Respond",
  } as unknown as Record<string, unknown>;
}

test("an unlinked login reads the refusal state on both surfaces", () => {
  const documents = documentsData();
  documents.refusal = { title: "No documents", message: "ask an administrator for a linked employment" };
  const documentsJson = JSON.stringify(meDocumentsSpec(documents as never));
  assert.ok(documentsJson.includes("\"empty-state\""), "the documents refusal renders through the empty-state block");
  assert.ok(documentsJson.includes("ask an administrator for a linked employment"), "the documents remedy reaches the page");

  const surveys = surveysData();
  surveys.refusal = { title: "No surveys", message: "ask an administrator for a linked employment" };
  const surveysJson = JSON.stringify(meSurveysSpec(surveys as never));
  assert.ok(surveysJson.includes("\"empty-state\""), "the surveys refusal renders through the empty-state block");
  assert.ok(surveysJson.includes("ask an administrator for a linked employment"), "the surveys remedy reaches the page");
});

test("each page carries its action surfaces through the shared widgets", () => {
  const documentsJson = JSON.stringify(meDocumentsSpec(documentsData() as never));
  assert.ok(documentsJson.includes("\"hrm-me-document-actions\""), "sign and acknowledge ride the shared actions widget");
  assert.ok(documentsJson.includes("\"hrm-me-export-dialog\""), "the export dialog renders with the party scope");
  assert.ok(documentsJson.includes("party-1"), "the export dialog carries the party it exports for");

  const surveysJson = JSON.stringify(meSurveysSpec(surveysData() as never));
  assert.ok(surveysJson.includes("\"hrm-me-survey-respond\""), "responding rides the shared respond widget");
  assert.ok(surveysJson.includes("Respond"), "the respond surface resolves its label from its data");
});
