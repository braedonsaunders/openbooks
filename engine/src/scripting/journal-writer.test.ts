import assert from "node:assert/strict";
import test from "node:test";
import { installEngineSeams } from "../composition/install.ts";
import { runScript, type ScriptContext } from "./scripting.ts";
import {
  installedScriptJournalWriter,
  registerScriptJournalWriter,
} from "./journal-writer.ts";

// Unit tests for the installed script-journal writer seam. The production
// runner and real QuickJS realm, no database: the
// missing-writer refusal fires before any authorization I/O, and a run with
// no accountable user is refused before the fake writer is ever reached.

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

test("an unattended run with no accountable user never reaches the installed writer", async () => {
  const calls: unknown[] = [];
  registerScriptJournalWriter(async (orgId) => {
    calls.push(orgId);
    return { id: "j1", documentNumber: "JE-0001" };
  });
  const outcome = await runScript(CREATE_SOURCE, context, 2_000, {});
  assert.equal(outcome.status, "error");
  assert.match(outcome.abortReason ?? "", /no signed-in user and the script has no run-as user; save the script again as a user who holds gl\.post/);
  assert.deepEqual(calls, []);
});

test("installEngineSeams is idempotent", async () => {
  installEngineSeams();
  installEngineSeams();
  assert.equal(typeof installedScriptJournalWriter(), "function");
});
