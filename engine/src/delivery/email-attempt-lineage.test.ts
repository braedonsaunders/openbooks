// Crash-gap email retry: a worker lost between the pre-transmission "started"
// mark and its outcome must reconcile to suppression, never to a blind re-send.
//
// The email worker appends {outcome:"started"} immediately BEFORE calling the
// provider, then appends the verdict (sent / notSent / uncertain) after. Each
// append is a separately committed UPDATE, so a crash, SIGKILL, or deploy
// restart in that window leaves a dangling "started" with no outcome — while
// the provider may already have accepted and delivered the message. These
// tests pin the full path: normalizeAttempts turns the dangling start into
// "uncertain", and reconcileDeliveryAttempts then suppresses the retry.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAttempts } from "./email-config.ts";
import { reconcileDeliveryAttempts } from "@openbooks/emails";

test("a dangling start (crash before any outcome) suppresses the retry", () => {
  const raw = [
    { at: "2026-09-01T00:00:00.000Z", attempt: 1, outcome: "started", detail: "sending via resend" },
  ];
  const lineage = normalizeAttempts(raw);
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0]?.outcome, "uncertain");
  const decision = reconcileDeliveryAttempts(lineage);
  assert.equal(decision.action, "suppress");
});

test("a start closed by a definitive failure still allows the retry", () => {
  const raw = [
    { at: "2026-09-01T00:00:00.000Z", attempt: 1, outcome: "started", detail: "sending via resend" },
    { at: "2026-09-01T00:00:01.000Z", attempt: 1, outcome: "notSent", detail: "connection refused" },
  ];
  const lineage = normalizeAttempts(raw);
  assert.deepEqual(lineage.map((r) => r.outcome), ["notSent"]);
  assert.deepEqual(reconcileDeliveryAttempts(lineage), { action: "send" });
});

test("a later dangling start suppresses even after an earlier clean failure", () => {
  const raw = [
    { attempt: 1, outcome: "started" },
    { attempt: 1, outcome: "notSent", detail: "connection refused" },
    { attempt: 2, outcome: "started", detail: "sending via resend" },
  ];
  const lineage = normalizeAttempts(raw);
  assert.deepEqual(lineage.map((r) => r.outcome), ["notSent", "uncertain"]);
  assert.equal(reconcileDeliveryAttempts(lineage).action, "suppress");
});

test("annotation events without a verdict never synthesize uncertainty", () => {
  const raw = [
    { attempt: 1, outcome: "blocked", detail: "not resent" },
    { outcome: "started", detail: "missing attempt number" },
    "garbage",
    null,
  ];
  assert.deepEqual(normalizeAttempts(raw), []);
  assert.deepEqual(reconcileDeliveryAttempts(normalizeAttempts(raw)), { action: "send" });
});
