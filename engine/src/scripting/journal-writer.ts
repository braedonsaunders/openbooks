import type {
  CreateScriptJournalOptions,
  ScriptJournalInput,
  ScriptJournalResult,
} from "../journal/script-journal-contract.ts";

/**
 * Installed script-journal writer.
 *
 * scripting sits below the ledger orchestrator, so it cannot import
 * createScriptJournal directly. The composition root installs the ledger's
 * writer at process boot via installEngineSeams(); the __journal_create
 * host call invokes it inline, so the write stays in the same ambient
 * transaction as the rest of the script run. A missing writer is a
 * fail-closed refusal naming installEngineSeams(), never a silent no-op.
 */
export type ScriptJournalWriter = (
  orgId: string,
  actorId: string | null,
  input: ScriptJournalInput,
  opts?: CreateScriptJournalOptions,
) => Promise<ScriptJournalResult>;

type HookRuntime = typeof globalThis & {
  __openbooksScriptJournalWriter?: ScriptJournalWriter;
};

const runtime = globalThis as HookRuntime;

/** Installed by installEngineSeams(); idempotent, last registration wins. */
export function registerScriptJournalWriter(fn: ScriptJournalWriter): void {
  runtime.__openbooksScriptJournalWriter = fn;
}

/** The installed writer, or undefined when installEngineSeams() never ran. */
export function installedScriptJournalWriter(): ScriptJournalWriter | undefined {
  return runtime.__openbooksScriptJournalWriter;
}
