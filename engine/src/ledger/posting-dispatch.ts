import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { resolveScriptUser, runTriggerScripts, type ScriptContext } from "../scripting/scripting.ts";
import { emitStatusChange, runRecordFlows } from "../flows/run.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { applyInventoryReturnsForVendorCredit } from "../inventory/documents-vendor-credits.ts";
import { applyInventoryReturnsForCustomerCredit } from "../inventory/documents-customer-credits.ts";
import { applyInventoryIssuesForInvoice } from "../inventory/documents-sales.ts";
import { applyInventoryReceiptsForBill } from "../inventory/documents-purchasing.ts";
import { createObligationsFromInvoice } from "../revenue/recognition.ts";
import { claimPostingEffectsForDocument, markPostingEffectsFailed, markPostingEffectsSucceeded, PostingEffectsLeaseFencedError, PostingEffectsTerminalFailureError, type PostingEffectsRow } from "./posting-effects.ts";
/**
 * Emit post-commit effects for a caller that used `deferEffects` so a larger
 * accounting unit (for example payment + applications + realized FX) could
 * commit atomically before any automation observes it.
 *
 * Obligations and inventory also run here. `postDocument` writes a
 * `posting_effects` row in the posting transaction; this function drains it.
 * A crash after commit leaves the row for `processDuePostingEffects`.
 */
/**
 * Resolve the legal entity whose subledger a post-commit inventory effect
 * touches. documents.subsidiary_id null *means* the org's root subsidiary —
 * the same entity the posting kernel stamped on every journal line (see
 * applySubsidiaries, which substitutes ctx.rootId for the null header) — so
 * the meaning-bearing null must never gate an effect by truthiness or reach
 * the subledger as something distinct from "root".
 */
export async function postingEffectSubsidiaryId(
  orgId: string,
  subsidiaryId: string | null,
): Promise<string> {
  if (subsidiaryId) return subsidiaryId;
  const ctx = await loadSubsidiaryContext(db, orgId);
  return ctx.rootId;
}

export async function runPostDocumentEffects(
  documentId: string,
  previousStatus = "draft",
  options: {
    suppressAutomation?: boolean;
    actorId?: string | null;
    alreadyClaimed?: PostingEffectsRow;
  } = {},
): Promise<void> {
  let claimed: PostingEffectsRow | null = options.alreadyClaimed ?? null;
  if (!options.alreadyClaimed) {
    const claim = await claimPostingEffectsForDocument(documentId);
    if (claim === "succeeded" || claim === "running") return;
    if (claim === "terminal_failed") {
      throw new PostingEffectsTerminalFailureError(documentId);
    }
    claimed = claim;
  }

  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc || doc.status !== "posted") {
    const error = new Error("document is not posted");
    if (claimed && !options.alreadyClaimed) {
      await markPostingEffectsFailed(claimed, error);
      return;
    }
    if (options.alreadyClaimed) throw error;
    return;
  }

  try {
    // Product subledgers are part of posting semantics regardless of whether
    // posting was initiated by the UI, API, a flow action, or a scheduler.
    // Each service is idempotent by document line, so a retry repairs a
    // post-commit interruption without duplicating inventory or obligations.
    const effectActorId = options.actorId ?? claimed?.actor_id ?? null;
    const postingDate = doc.postingDate ?? claimed?.posting_date ?? doc.documentDate;
    const entryId = doc.postedEntryId ?? claimed?.entry_id ?? null;
    if (doc.kind === "customer_invoice") {
      await createObligationsFromInvoice(doc.id, doc.orgId, effectActorId);
      await applyInventoryIssuesForInvoice(
        doc.orgId,
        effectActorId,
        doc.id,
        postingDate,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    } else if (doc.kind === "vendor_bill") {
      // A posted vendor_bill carries its entry id by construction — the
      // kernel flips status and stamps posted_entry_id in one statement — so
      // a missing id means the row is corrupt. Fail loudly into the retry/
      // terminal lifecycle rather than skip the receipts and record success.
      if (!entryId) {
        throw new Error(
          `posted vendor bill ${doc.documentNumber} has no posted journal entry; inventory receipts cannot run`,
        );
      }
      await applyInventoryReceiptsForBill(
        doc.orgId,
        effectActorId,
        doc.id,
        entryId,
        postingDate,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    } else if (doc.kind === "vendor_credit") {
      await applyInventoryReturnsForVendorCredit(
        doc.orgId,
        effectActorId,
        doc.id,
        postingDate,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    } else if (doc.kind === "customer_credit") {
      // The sell-side mirror of vendor_credit. Without it a sales return was
      // a purely commercial credit: revenue reversed, the goods never came
      // back into stock, and COGS kept the cost of units the customer had
      // returned.
      await applyInventoryReturnsForCustomerCredit(
        doc.orgId,
        effectActorId,
        doc.id,
        postingDate,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    }

    const lines = await db
      .select()
      .from(schema.documentLines)
      .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
      .orderBy(asc(schema.documentLines.lineNumber));
    const [org] = await db
      .select()
      .from(schema.orgs)
      .where(eq(schema.orgs.id, doc.orgId));
    if (!org) {
      const error = new Error("organization not found");
      if (claimed && !options.alreadyClaimed) {
        await markPostingEffectsFailed(claimed, error);
        return;
      }
      if (options.alreadyClaimed) throw error;
      return;
    }
    const scriptUser = await resolveScriptUser(doc.orgId, effectActorId, { required: false });
    const ctx: ScriptContext = {
      trigger: "after_post",
      document: doc as unknown as Record<string, unknown>,
      lines: lines as unknown as Record<string, unknown>[],
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
      ...(scriptUser ? { user: scriptUser } : {}),
    };
    if (!options.suppressAutomation) {
      await runTriggerScripts("after_post", ctx, doc.id);
      await runRecordFlows({ kind: "after_post" }, doc.kind, doc.id, {
        orgId: doc.orgId,
      });
      await emitStatusChange(
        doc.kind,
        doc.id,
        { from: previousStatus, to: "posted" },
        { orgId: doc.orgId },
      );
    }
    if (doc.kind === "customer_payment") {
      const { finalizePaymentAcceptanceForDocument } =
        await import("../payments/acceptance.ts");
      await finalizePaymentAcceptanceForDocument(doc.id);
    }
    if (claimed && !options.alreadyClaimed) {
      await markPostingEffectsSucceeded(claimed);
    }
  } catch (error) {
    if (error instanceof PostingEffectsLeaseFencedError) throw error;
    if (claimed && !options.alreadyClaimed) {
      await markPostingEffectsFailed(claimed, error);
    }
    throw error;
  }
}
