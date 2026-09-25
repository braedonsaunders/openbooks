import { createScriptJournal } from "../ledger/journal-writes.ts";
import { registerScriptJournalWriter } from "../scripting/journal-writer.ts";

/**
 * Composition root (ARCH-MODULE-CYCLE C12): the one place that wires engine
 * modules across layering seams.
 *
 * scripting sits below the ledger orchestrator, so it cannot import
 * createScriptJournal; instead the process installs the ledger's writer
 * here and the __journal_create host call invokes it inline, in the same
 * ambient transaction. Later commits register the approval-release and
 * document-effects handlers on this same root (C13, C14).
 *
 * Idempotent: re-registering the same writer is a no-op. Call it from every
 * process that can post, run scripts or run flows — web/instrumentation,
 * scripts/worker-entry, and the engine CLIs — and explicitly in tests that
 * exercise those paths (never as a test-suite preload: loading payments
 * and ledger before per-test module mocks would break mocks governed by
 * check:test-mock-surface).
 */
export function installEngineSeams(): void {
  registerScriptJournalWriter(createScriptJournal);
}
