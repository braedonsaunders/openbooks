import {
  ambientBypassWithoutTransaction,
  ambientTenantOrgId,
  orgContext,
  withMaintenanceTransaction,
  withOrgTransaction,
} from "../platform/db.ts";
import type { PostingDeps, PostDocumentOptions } from "./posting-contracts.ts";
import { prepareDocumentPosting } from "./posting-prepare.ts";
import { commitDocumentPosting } from "./posting-commit.ts";
import { runPostDocumentEffects } from "./posting-dispatch.ts";

/**
 * Public posting coordinator: prepare, atomically commit, then dispatch durable effects.
 *
 * Prepare + commit are one atomic unit whatever the caller does. A caller that
 * already owns a transaction (the documents route's withOrgTransaction, a
 * payment unit, a script journal) is joined, so its wider unit stays intact.
 * Otherwise one is opened here: a tenant transaction for the ambient org
 * (request scope, withOrgContext), or a bypass maintenance transaction for
 * trusted callers that hold authority without a pinned unit. A caller with no
 * scope at all still fails closed on prepare's first read (deny-by-default),
 * exactly as before — that path can never reach a partial write.
 *
 * Everything the prepare phase touches runs on the same connection as the
 * commit, which is safe: the before_post script runner executes in-process
 * (QuickJS) and reads/writes through the shared handle, tenant script journal
 * writes join the ambient unit, the provider-tax step replays persisted quote
 * evidence with database reads only (no live HTTP at post time), and flows
 * participate in the ambient transaction. The only work held across the unit
 * before any row lock is taken is that evidence replay, so no lock is held
 * while it runs.
 *
 * Durable effects still run only after the unit commits, as before: when this
 * call opened the transaction that means after commit; when the caller owned
 * it they drain with the caller's unit exactly as they do today.
 */
export async function postDocument(documentId: string, deps: PostingDeps, options: PostDocumentOptions = {}): Promise<string> {
  const runPosting = async (): Promise<{
    prepared: Awaited<ReturnType<typeof prepareDocumentPosting>>;
    entryId: string;
  }> => {
    const prepared = await prepareDocumentPosting(documentId, deps, options);
    const entryId = await commitDocumentPosting(prepared, options);
    return { prepared, entryId };
  };

  let prepared: Awaited<ReturnType<typeof prepareDocumentPosting>>;
  let entryId: string;
  if (orgContext.getStore()?.txDb) {
    ({ prepared, entryId } = await runPosting());
  } else {
    const ambientOrg = ambientTenantOrgId();
    if (ambientOrg) {
      ({ prepared, entryId } = await withOrgTransaction(ambientOrg, runPosting));
    } else if (ambientBypassWithoutTransaction()) {
      ({ prepared, entryId } = await withMaintenanceTransaction(null, runPosting));
    } else {
      ({ prepared, entryId } = await runPosting());
    }
  }

  const { doc } = prepared;
  if (!options.deferEffects) {
    await runPostDocumentEffects(doc.id, doc.status, {
      suppressAutomation: options.suppressAutomation,
      actorId: options.audit?.actorId ?? null,
    });
  }
  return entryId;
}
