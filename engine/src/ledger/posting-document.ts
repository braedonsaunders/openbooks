import { sql } from "drizzle-orm";
import {
  ambientBypassWithoutTransaction,
  ambientTenantOrgId,
  db,
  orgContext,
  schema,
  withMaintenanceTransaction,
  withOrgContext,
  withOrgTransaction,
} from "../platform/db.ts";
import { PostingError, type PostingDeps, type PostDocumentOptions } from "./posting-contracts.ts";
import { assertCustomerInvoiceCredit } from "./posting-invoice-credit.ts";
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
 *
 * One exception to the rollback: custom_gl_lines script_runs evidence. The
 * runner's rows are written in the unit and roll back with a refused post,
 * so the refusal carries their in-memory twin and this coordinator
 * re-records them out-of-band — but only when this call opened the unit. A
 * caller-owned unit keeps its evidence atomic with its wider write set, and
 * successful posts keep their single in-unit rows with no double-writing.
 */
/**
 * Re-record the custom_gl_lines script_runs evidence carried by a refused
 * post, on fresh connections in each evidence row's own tenant context —
 * outside the rolled-back posting transaction. Best-effort by design: a
 * re-record failure is logged and the ORIGINAL refusal still propagates, so
 * evidence persistence can never mask or convert a posting refusal.
 */
async function reRecordCustomGlLineEvidence(error: unknown): Promise<void> {
  const runs = error instanceof PostingError ? error.customGlLineRuns : undefined;
  if (!runs || runs.length === 0) return;
  for (const run of runs) {
    await withOrgContext(run.orgId, async () => {
      await db.insert(schema.scriptRuns).values({
        orgId: run.orgId,
        scriptId: run.scriptId,
        targetKind: run.targetKind,
        targetId: run.targetId,
        status: run.status,
        logs: run.logs,
        errorMessage: run.errorMessage,
        durationMs: run.durationMs,
        createdBy: run.createdBy,
      });
      await db.execute(
        sql`update user_scripts set last_run_at = now() where id = ${run.scriptId} and org_id = ${run.orgId}`,
      );
    });
  }
}

/**
 * Run the re-record above without ever disturbing the in-flight refusal:
 * the posting transaction has already rolled back on this path, and a
 * failed evidence write must not replace the refusal the caller handles.
 */
async function restoreScriptEvidenceAfterRollback(error: unknown): Promise<void> {
  try {
    await reRecordCustomGlLineEvidence(error);
  } catch (evidenceError) {
    console.error(
      `[posting] custom_gl_lines evidence re-record failed after a refused post; the refusal still stands: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
    );
  }
}

export async function postDocument(documentId: string, deps: PostingDeps, options: PostDocumentOptions = {}): Promise<string> {
  const runPosting = async (): Promise<{
    prepared: Awaited<ReturnType<typeof prepareDocumentPosting>>;
    entryId: string;
  }> => {
    const prepared = await prepareDocumentPosting(documentId, deps, options);
    if (prepared.doc.kind === "customer_invoice" && !deps.migration) {
      // The receivable appears here, not at order issue: direct invoices and
      // partial billing can exceed the approved commitment, so the credit
      // gate re-evaluates in the same unit, before the balance commits. The
      // customer_roles row lock serializes concurrent posts per customer.
      await assertCustomerInvoiceCredit(db, prepared.doc);
    }
    const entryId = await commitDocumentPosting(prepared, options);
    return { prepared, entryId };
  };

  let prepared: Awaited<ReturnType<typeof prepareDocumentPosting>>;
  let entryId: string;
  if (orgContext.getStore()?.txDb) {
    // The caller owns the atomic unit (the documents route's
    // withOrgTransaction, a payment unit, a script journal): the refusal —
    // and the rolled-back script evidence with it — belongs to that unit,
    // exactly as before PA1. No out-of-band write here.
    ({ prepared, entryId } = await runPosting());
  } else {
    const ambientOrg = ambientTenantOrgId();
    if (ambientOrg) {
      try {
        ({ prepared, entryId } = await withOrgTransaction(ambientOrg, runPosting));
      } catch (error) {
        // This call opened the transaction, which has now rolled back: the
        // in-transaction script_runs rows are gone, so re-record the carried
        // evidence before the refusal propagates. Document/ledger mutations
        // stay rolled back; only the diagnostic run rows are restored.
        await restoreScriptEvidenceAfterRollback(error);
        throw error;
      }
    } else if (ambientBypassWithoutTransaction()) {
      try {
        ({ prepared, entryId } = await withMaintenanceTransaction(null, runPosting));
      } catch (error) {
        await restoreScriptEvidenceAfterRollback(error);
        throw error;
      }
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
