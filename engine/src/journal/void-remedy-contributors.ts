/**
 * Void-remedy hooks: domain checks and reversals a void runs, inside the
 * void's own transaction unless stated otherwise. Ordering and installation:
 * see posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";
import type { DocumentScriptHooks } from "./posting-preconditions.ts";

export interface VoidRemedyContributors {
  scripting: DocumentScriptHooks;
  "stored-value": {
    /** Moves the card subledger with the journal reversal that moved the liability. */
    reverseForVoidedDocument(input: {
      orgId: string;
      documentId: string;
      documentNumber: string;
      reversalEntryId: string | null;
      actorId: string;
      reason: string;
    }): Promise<unknown>;
  };
  webhooks: {
    documentVoided(
      executor: SqlExecutor,
      orgId: string,
      documentId: string,
      input: { reversalEntryId: string | null; reason: string },
    ): Promise<unknown>;
  };
}

export const voidRemedyHooks = postingContributorRegistry<VoidRemedyContributors>("void remedy");
