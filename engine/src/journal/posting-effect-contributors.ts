/**
 * Effect hooks: subledger, automation and event effects of a committed
 * posting. Every effect is idempotent by document or journal line, so the
 * post-commit drain may run it again. Ordering and installation: see
 * posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";
import type { DocumentScriptHooks } from "./posting-preconditions.ts";

export interface PostingEffectContributors {
  "stored-value": {
    issueForInvoice(documentId: string, orgId: string, actorId: string | null): Promise<unknown>;
    issueStoreCreditForCreditMemo(
      documentId: string,
      orgId: string,
      actorId: string | null,
    ): Promise<unknown>;
  };
  assets: {
    /** Asset proposals for the entry's capitalizable lines; a no-op unless proposals are switched on. */
    proposeForPostedEntry(orgId: string, entryId: string, actorId: string | null): Promise<unknown>;
  };
  scripting: DocumentScriptHooks;
  webhooks: {
    documentPosted(executor: SqlExecutor, orgId: string, documentId: string): Promise<unknown>;
    paymentReceived(executor: SqlExecutor, orgId: string, documentId: string): Promise<unknown>;
  };
}

export const postingEffectHooks = postingContributorRegistry<PostingEffectContributors>("effect");
