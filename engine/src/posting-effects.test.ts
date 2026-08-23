import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAX_POSTING_EFFECTS_ATTEMPTS, postingEffectsBackoffMs } from "./posting-effects.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("posting effects backoff doubles then caps at one hour", () => {
  assert.equal(postingEffectsBackoffMs(1), 60_000);
  assert.equal(postingEffectsBackoffMs(2), 120_000);
  assert.equal(postingEffectsBackoffMs(3), 240_000);
  assert.equal(postingEffectsBackoffMs(MAX_POSTING_EFFECTS_ATTEMPTS), 60 * 60_000);
});

test("posting writes a posting_effects row inside the transaction and drains via runPostDocumentEffects", () => {
  const posting = source("./posting.ts");
  assert.match(posting, /enqueuePostingEffects\(tx/);
  assert.match(posting, /createObligationsFromInvoice/);
  assert.match(posting, /applyInventoryIssuesForInvoice/);
  assert.match(posting, /applyInventoryReceiptsForBill/);
  assert.match(posting, /alreadyClaimed/);

  const postDocument = posting.slice(
    posting.indexOf("export async function postDocument"),
    posting.indexOf("export async function runPostDocumentEffects"),
  );
  assert.match(postDocument, /enqueuePostingEffects\(tx/);
  assert.doesNotMatch(postDocument, /createObligationsFromInvoice/);
  assert.doesNotMatch(postDocument, /applyInventoryIssuesForInvoice/);
  assert.doesNotMatch(postDocument, /applyInventoryReceiptsForBill/);
  assert.match(postDocument, /runPostDocumentEffects/);

  const drain = posting.slice(posting.indexOf("export async function runPostDocumentEffects"));
  assert.match(drain, /createObligationsFromInvoice/);
  assert.match(drain, /applyInventoryIssuesForInvoice/);
  assert.match(drain, /applyInventoryReceiptsForBill/);
  assert.match(drain, /claimPostingEffectsForDocument/);

  const outbox = source("./posting-effects.ts");
  assert.match(outbox, /runPostDocumentEffects/);
  assert.match(outbox, /insert into posting_effects/);

  const scheduler = source("./scheduler.ts");
  assert.match(scheduler, /processDuePostingEffects/);

  const worker = source("./worker/scheduler.ts");
  assert.match(worker, /processDuePostingEffects/);
  assert.doesNotMatch(worker, /bullmq.*dlq|dead.?letter/i);
});
