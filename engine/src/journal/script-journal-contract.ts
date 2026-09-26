/**
 * Script-journal contract: the governed sandbox -> ledger write shapes.
 * Moved verbatim from ledger/journal-writes.ts so
 * scripting can type the installed journal writer without importing the
 * ledger orchestrator. Pure types: no runtime imports, no module edges.
 */
export interface ScriptJournalLine {
  /** Resolve the GL account by id or by account number/code (one required). */
  accountId?: string;
  accountCode?: string;
  /** Signed base amount: positive = debit, negative = credit. */
  amount: string;
  description?: string;
  departmentId?: string;
  projectId?: string;
}

export interface ScriptJournalInput {
  /** ISO date (YYYY-MM-DD); defaults to today. */
  documentDate?: string;
  memo?: string;
  referenceNumber?: string;
  /**
   * Explicit legal entity for the journal. Omitted = choose a default the
   * same way the HTTP draft route does: the root for an unrestricted actor,
   * the single allowed entity for a restricted one, otherwise refused.
   */
  subsidiaryId?: string | null;
  lines: ScriptJournalLine[];
}

/**
 * Scope refusal codes — the same vocabulary web/lib/journals.ts
 * DraftJournalScopeError uses for the HTTP draft route, so a sandbox caller is
 * refused exactly like a browser caller (an out-of-scope entity stays
 * indistinguishable from a nonexistent one).
 */
export type JournalScopeErrorCode =
  | "invalid_subsidiary"
  | "subsidiary_not_allowed"
  | "no_available_subsidiary"
  | "ambiguous_subsidiary_scope";

export interface CreateScriptJournalOptions {
  post?: boolean;
  /** Recheck the scripts feature inside the transaction that writes this journal. */
  requireScriptsFeature?: boolean;
  /**
   * The acting principal's subsidiary visibility: null = unrestricted, a Set
   * = the allowed entities. Omitted = resolved live from the actor's roles
   * (never assumed unrestricted); an actor-less system caller is unrestricted.
   */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
  /**
   * Dedupe identity for one script-run write: the run namespace plus the
   * journal.create call ordinal within that run. When present the draft
   * insert runs ON CONFLICT DO NOTHING on (org_id, idempotency_key) and a
   * conflicting retry reads back the first execution's document instead of
   * posting a second numbered journal. Omitted = no dedupe (non-script
   * callers, and script runs with no stable retry identity).
   */
  idempotencyKey?: string;
  /**
   * Wall-clock deadline (ms epoch) of the enclosing script run. The write
   * transaction is fenced to it: a run that already exceeded its deadline
   * refuses before starting, and a transaction this call owns carries
   * SET LOCAL statement_timeout = remaining budget, so PostgreSQL itself
   * aborts statements still running past the deadline instead of letting
   * them commit after the host reported a timeout. Omitted = unfenced
   * (non-script callers keep the pool's own bounds).
   */
  deadlineMs?: number;
}

export interface ScriptJournalResult {
  id: string;
  documentNumber: string;
  /** Present only when post=true succeeded. */
  entryId?: string;
  /** A configured flow accepted the request and is awaiting approval. */
  approvalPending?: boolean;
}
