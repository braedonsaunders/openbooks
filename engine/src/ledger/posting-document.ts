import type { PostingDeps, PostDocumentOptions } from "./posting-contracts.ts";
import { prepareDocumentPosting } from "./posting-prepare.ts";
import { commitDocumentPosting } from "./posting-commit.ts";
import { runPostDocumentEffects } from "./posting-dispatch.ts";

/** Public posting coordinator: prepare, atomically commit, then dispatch durable effects. */
export async function postDocument(documentId: string, deps: PostingDeps, options: PostDocumentOptions = {}): Promise<string> {
  const prepared = await prepareDocumentPosting(documentId, deps, options);
  const { doc } = prepared;
  const entryId = await commitDocumentPosting(prepared, options);

  if (!options.deferEffects) {
    await runPostDocumentEffects(doc.id, doc.status, {
      suppressAutomation: options.suppressAutomation,
      actorId: options.audit?.actorId ?? null,
    });
  }
  return entryId;
}
