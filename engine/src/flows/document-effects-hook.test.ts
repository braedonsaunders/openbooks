import assert from "node:assert/strict";
import test from "node:test";
import {
  FlowDocumentEffectsNotInstalledError,
  flowDocumentEffects,
  registerFlowDocumentEffects,
} from "./document-effects-hook.ts";

// Unit tests for the document-effects port. The
// executor and the documents adapter resolve postings and void completions
// here instead of importing ledger/payments; a missing port must throw by
// name (naming installEngineSeams) rather than report posted/voided while
// writing nothing.

test("missing effects throw a named error, never a silent no-op", () => {
  assert.throws(flowDocumentEffects, FlowDocumentEffectsNotInstalledError);
  assert.throws(flowDocumentEffects, /installEngineSeams/);
});

test("an installed port delegates post and void completion inline", async () => {
  const calls: unknown[] = [];
  registerFlowDocumentEffects({
    async postSubject(args) {
      calls.push(["post", args]);
      return "entry-1";
    },
    async completeRequestedVoid(subjectId, orgId, allowedSubsidiaryIds) {
      calls.push(["complete", subjectId, orgId, allowedSubsidiaryIds]);
    },
    async rejectRequestedVoid(subjectId, orgId, userId, comment) {
      calls.push(["reject", subjectId, orgId, userId, comment]);
    },
  });
  const effects = flowDocumentEffects();
  const ctx = { orgId: "o", userId: "u" };
  assert.equal(
    await effects.postSubject({ subjectKind: "vendor_bill", subjectId: "s", ctx }),
    "entry-1",
  );
  await effects.completeRequestedVoid("s", "o", null);
  await effects.rejectRequestedVoid("s", "o", "u", "nope");
  assert.equal(calls.length, 3);
});
