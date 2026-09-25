import assert from "node:assert/strict";
import test from "node:test";
import { installEngineSeams } from "../composition/install.ts";
import { runScript, type ScriptContext } from "./scripting.ts";
import {
  installedScriptJournalWriter,
  registerScriptJournalWriter,
} from "./journal-writer.ts";

// Unit tests for the installed script-journal writer seam (ARCH-MODULE-CYCLE
// C12). The production runner and real QuickJS realm, no database: the
// missing-writer refusal fires before any authorization I/O, and the fake
// writer below stands in for the ledger without touching it.

const context: ScriptContext = {
  trigger: "scheduled",
  document: { kind: "journal", documentDate: "2026-09-20" },
  org: { id: "not-a-database-tenant", name: "Seam only", baseCurrency: "USD" },
};

const CREATE_SOURCE = `function main() {
  return ob.journal.create({ memo: "m", lines: [{ accountCode: "5100", amount: "10" }] });
}`;

test("journal.create without an installed writer refuses by name, never no-ops", async () => {
  assert.equal(installedScriptJournalWriter(), undefined);
  const outcome = await runScript(CREATE_SOURCE, context, 2_000, {});
  assert.equal(outcome.status, "error");
  assert.match(outcome.abortReason ?? "", /journal writes are not installed/);
  assert.match(outcome.abortReason ?? "", /installEngineSeams/);
});

test("an installed writer is invoked inline and its journal returned", async () => {
  const calls: { orgId: unknown; actorId: unknown; input: unknown; post: unknown }[] = [];
  registerScriptJournalWriter(async (orgId, actorId, input, opts) => {
    calls.push({ orgId, actorId, input, post: opts?.post });
    return { id: "j1", documentNumber: "JE-0001" };
  });
  const outcome = await runScript(CREATE_SOURCE, context, 2_000, {});
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.returned, { id: "j1", documentNumber: "JE-0001" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.orgId, "not-a-database-tenant");
  assert.equal(calls[0]!.actorId, null);
  assert.equal(
    (calls[0]!.input as { memo?: unknown }).memo,
    "m",
  );
  assert.equal(calls[0]!.post, false);
});

test("installEngineSeams is idempotent", async () => {
  installEngineSeams();
  installEngineSeams();
  assert.equal(typeof installedScriptJournalWriter(), "function");
});
