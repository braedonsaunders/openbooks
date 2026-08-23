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

test("posting effects have an explicit terminal lifecycle and an audited operator replay", () => {
  const outbox = source("./posting-effects.ts");
  assert.match(outbox, /status='terminal_failed'/);
  assert.match(outbox, /terminal_failure_reason/);
  assert.match(outbox, /terminal_failed_at/);
  assert.match(outbox, /terminal_failed_by/);
  assert.match(outbox, /logTerminalFailure/);
  assert.match(outbox, /recordOutboxAttempt\("posting_effects"/);
  assert.match(outbox, /listFailedPostingEffects/);
  assert.match(outbox, /replayTerminalPostingEffect/);
  assert.match(outbox, /posting_effects_terminal_failure/);
  assert.match(outbox, /posting_effects_replay_authorized/);

  const terminal = source("./terminal-failure.ts");
  assert.match(terminal, /POSTING_EFFECTS_WORKER_IDENTITY/);
  assert.match(terminal, /from posting_effects/);

  const cli = source("./posting-effects-cli.ts");
  assert.match(cli, /replay --org=<uuid> --id=<uuid>/);
  assert.match(cli, /--actor=<uuid>/);
  assert.match(cli, /--reason=/);
});
