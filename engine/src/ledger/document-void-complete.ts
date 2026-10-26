import { takeOpeningSourceYearFence } from "../organization/payroll-source-fence.ts";
import {
  accrueRebatesForDocument,
  rebateSettlementVoidContext,
  releaseVoidedRebateSettlement,
} from "../revenue/rebates.ts";
import {
  assertJournalVoidNotAutomaticallyReversed,
  cancelScheduledJournalReversal,
} from "./journal-reversals.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { emitStatusChange } from "../flows/run.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { reverseFieldTicketProgressInTransaction } from "../projects/progress.ts";
import { emitDocumentVoided } from "../webhooks/emit.ts";
import { reverseStoredValueForVoidedDocument } from "../stored-value/void-reversal.ts";
import { PROVIDER_COMMIT_KINDS, requestProviderVoidTx } from "../tax/provider-commit.ts";
import { AmortizationError } from "../amortization/errors.ts";
import { cancelAmortizationForVoidedSource } from "../amortization/source-void.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import {
  DocumentVoidError,
  assertPostingEffectsCompleteForVoid,
  refuseBilledCostSourceVoid,
} from "./document-void-shared.ts";
import { reverseBillInventoryReceipts } from "./document-void-inventory.ts";
import {
  assertRetainageDrawVoidable,
  refuseDrawReleaseBehindLaterDraws,
  refuseUnavailablePayRunVoid,
} from "./document-void-remedies.ts";
import {
  lockVoidApplicationEvidence,
  refuseCapitalizedEntryVoid,
  refuseChangedVoidEvidence,
  refuseDependentSubledgerVoid,
  refuseLiveDownstreamVoid,
  refuseRetainerWithPostedDrawdowns,
  refuseSettledEntryVoid,
} from "./document-void-guards.ts";
import {
  lockVoidReversalPeriod,
  releaseVoidedEntrySettlements,
  releaseVoidedProvenance,
  reverseLinkedAllocationEntries,
  reverseVoidedEntry,
  unwindVoidedShipment,
} from "./document-void-reversal.ts";

/**
 * Complete a previously stored request. Called directly when no gate exists,
 * or by the flow adapter after the final configured approval.
 */
export async function completeRequestedDocumentVoid(
  documentId: string,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<string | null> {
  return withOrgTransaction(orgId, async () => {
    // Serialize payroll release with retained opening-source replacement and filing snapshots.
    // The fence precedes document locks so all payroll lifecycle writers use the same order.
    const payrollYear = await db.execute<{ taxYear: number }>(
      sql`select r.tax_year as "taxYear" from pay_runs r
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      where r.org_id=${orgId} and r.document_id=${documentId} and d.kind='pay_run'`,
      "objects",
    );
    if (payrollYear.length > 1) throw new DocumentVoidError("The payroll source year is ambiguous");
    if (payrollYear[0]) await takeOpeningSourceYearFence(db, orgId, payrollYear[0].taxYear);
    await lockLedgerSetupFence(db, orgId, "shared");
    const result: {
      reversalEntryId: string | null;
      kind: string;
      previousStatus: string;
      pairedDocumentId: string | null;
    } = await db.transaction(async (tx) => {
      // Completion-time backstop for the request-path check above: a release
      // landing between request and completion is refused here instead.
      const reversalDocument = (
        await tx.execute<{ void_requested_by: string | null }>(
          sql`select void_requested_by from documents where org_id=${orgId} and id=${documentId} for update`,
          "objects",
        )
      )[0];
      await assertJournalVoidNotAutomaticallyReversed(tx, orgId, documentId);
      await cancelScheduledJournalReversal(
        tx,
        orgId,
        documentId,
        reversalDocument?.void_requested_by ?? null,
      );
      await refuseUnavailablePayRunVoid(tx, orgId, documentId);
      // The document stays posted while void approvals wait, so an invoice
      // may have billed its cost in the meantime.
      await refuseBilledCostSourceVoid(tx, orgId, documentId);

      const { doc, discoveredEntryId, lockedEvidence } = await lockVoidApplicationEvidence(
        tx,
        orgId,
        documentId,
        allowedSubsidiaryIds,
      );
      const rebateClaim = await rebateSettlementVoidContext(orgId, documentId);
      await refuseChangedVoidEvidence(tx, orgId, doc, discoveredEntryId, lockedEvidence);
      if (doc.status === "voided") {
        return {
          reversalEntryId: String(doc.reversal_entry_id ?? "") || null,
          kind: String(doc.kind),
          previousStatus: "voided",
          pairedDocumentId: null,
        };
      }
      if (!doc.void_requested_at || !doc.void_requested_by || !doc.void_reason) {
        throw new DocumentVoidError("the document has no pending void request");
      }
      if (!["approved", "posted"].includes(String(doc.status))) {
        throw new DocumentVoidError(`a ${String(doc.status)} document cannot be voided`);
      }

      await refuseLiveDownstreamVoid(tx, orgId, documentId);

      if (doc.status === "posted") await assertPostingEffectsCompleteForVoid(tx, orgId, documentId);

      // Draw-sequence fence: voiding this invoice/bill returns its draw to
      // approved, which later draws' cumulative basis forbids. Completion is
      // the race backstop for a later draw created after the request.
      await refuseDrawReleaseBehindLaterDraws(tx, orgId, documentId);

      // Retainage lifecycle fence. A draw invoice/bill whose holdback supports
      // live retainage releases cannot be voided out from under them: the void
      // would erase held funds the releases already consumed or reserved.
      // Reverse the dependent releases first, then void the draw.
      await assertRetainageDrawVoidable(tx, orgId, documentId, doc);

      const kind = String(doc.kind);
      const unwound = await unwindVoidedShipment(tx, orgId, documentId, doc);
      let reversalEntryId = unwound.reversalEntryId;
      const pairedDocumentId = unwound.pairedDocumentId;

      if (kind === "field_ticket") {
        // A voided ticket's approved production no longer evidences installed
        // work: append the exact reversal of each entry it recorded.
        await reverseFieldTicketProgressInTransaction(tx, {
          orgId,
          actorId: String(doc.void_requested_by),
          ticketId: documentId,
          entryDate: String(doc.void_reversal_date),
          reason: String(doc.void_reason),
        });
      }

      const before = await captureTransactionAuditSnapshot(tx, documentId, orgId);
      if (!before) throw new DocumentVoidError("document not found");
      const entryId = doc.posted_entry_id ? String(doc.posted_entry_id) : null;

      if (entryId) {
        await refuseRetainerWithPostedDrawdowns(tx, orgId, documentId);
        // lockApplicationEvidence already holds the source, all related
        // application documents and entries, and every active endpoint line
        // in the canonical order. Keep those locks through the checks below
        // and reversal writes so no new application can settle reversed
        // evidence.
        await refuseSettledEntryVoid(tx, orgId, entryId);
        if (String(doc.kind) === "vendor_bill") {
          // Voiding a bill unwinds the stock its lines received first, after
          // the reconciliation and payment fences above (their refusals keep
          // their documented order) and before the subledger gate below:
          // every live "Inventory receipt (bill)" movement reverses through
          // the inventory kernel with its journal, and every purchase price
          // variance entry the bill settled reverses with it, so a bill that
          // double-received voids clean instead of stranding phantom stock.
          // Consumed stock refuses naming its consumers; anything else the
          // kernel cannot unwind keeps the manual two-leg correction below.
          await reverseBillInventoryReceipts(tx, {
            orgId,
            billId: documentId,
            billNumber: String(doc.document_number),
            actorId: String(doc.void_requested_by),
            reversalDate: String(doc.void_reversal_date),
            reason: String(doc.void_reason),
          });
        }
        await refuseDependentSubledgerVoid(tx, orgId, documentId, doc);
        await refuseCapitalizedEntryVoid(tx, orgId, entryId);
        const period = await lockVoidReversalPeriod(tx, { orgId, entryId, doc });
        const reversalDate = String(doc.void_reversal_date);
        const outgoingFx = await releaseVoidedEntrySettlements(tx, {
          orgId,
          documentId,
          entryId,
          doc,
        });
        const reversal = { orgId, documentId, doc, reversalDate, period };
        const reverseEntry = (sourceEntryId: string, suffix: string): Promise<string> =>
          reverseVoidedEntry(tx, reversal, sourceEntryId, suffix);

        reversalEntryId = await reverseEntry(entryId, "VOID");
        // Amortization schedules sourced by this document cancel with it:
        // their posted amortization returns to the deferral account on the
        // reversal date, so expense and the deferral both net to zero.
        try {
          await cancelAmortizationForVoidedSource(tx, {
            orgId,
            documentId,
            reversalDate,
            actorId: String(doc.void_requested_by),
            reason: String(doc.void_reason),
          });
        } catch (error) {
          if (error instanceof AmortizationError)
            throw new DocumentVoidError(`${error.message} ${error.remedy}`, 422, "invalid");
          throw error;
        }
        for (const fx of outgoingFx) {
          await reverseEntry(fx.id, "VOID");
        }
        await reverseLinkedAllocationEntries(tx, reversal, reverseEntry);
        // A gift-card redemption priced at a different rate than the card's
        // carrying rate posted realized FX in its own entry on this document.
        const storedValueFx = await tx.execute<{ id: string }>(
          sql`
          select id
            from journal_entries
           where org_id = ${orgId} and source_document_id = ${documentId}
             -- Live entries only: one already reversed is not reversed again.
             and origin in ('stored_value','rebate_settlement') and status = 'posted'
           order by id
           for update
        `,
          "objects",
        );
        for (const fx of storedValueFx) {
          await reverseEntry(fx.id, "VOID");
        }
        // The journal reversal above moved the stored-value liability; the
        // card subledger moves with it in this same transaction.
        await reverseStoredValueForVoidedDocument({
          orgId,
          documentId,
          documentNumber: String(doc.document_number),
          reversalEntryId,
          actorId: String(doc.void_requested_by),
          reason: String(doc.void_reason),
        });
      }

      await releaseVoidedProvenance(tx, orgId, documentId, doc);
      // Completion clears the whole void-request group together. The
      // documents_void_request_evidence check forbids a voided row that keeps
      // request evidence; the completed void is durable through
      // reversal_entry_id (whose posting date is the honored reversal date),
      // void_reason, and the void_request audit entry below.
      await tx.execute(sql`
        update documents
           set status = 'voided',
               voided_at = now(),
               voided_by = ${String(doc.void_requested_by)},
               reversal_entry_id = ${reversalEntryId},
               open_balance = null,
               void_requested_at = null,
               void_requested_by = null,
               void_reversal_date = null,
               updated_at = now(),
               updated_by = ${String(doc.void_requested_by)}
         where id = ${documentId} and org_id = ${orgId}
      `);
      const after = await captureTransactionAuditSnapshot(tx, documentId, orgId);
      if (!after) throw new DocumentVoidError("document disappeared while voiding");
      await recordTransactionAudit(tx, {
        orgId,
        documentId,
        action: "void",
        actorId: String(doc.void_requested_by),
        source: "controlled_void",
        reason: String(doc.void_reason),
        before,
        after,
      });
      if (rebateClaim)
        await releaseVoidedRebateSettlement(
          orgId,
          String(doc.void_requested_by),
          rebateClaim,
          reversalEntryId,
          String(doc.void_reversal_date),
          String(doc.void_reason),
        );
      await accrueRebatesForDocument(
        orgId,
        documentId,
        String(doc.void_requested_by),
        String(doc.void_reversal_date),
      );
      // Subscriber event joins the void transaction: a rolled-back void announces nothing.
      await emitDocumentVoided(tx, orgId, documentId, {
        reversalEntryId,
        reason: String(doc.void_reason),
      });
      if (pairedDocumentId) {
        await emitDocumentVoided(tx, orgId, pairedDocumentId, {
          reversalEntryId,
          reason: String(doc.void_reason),
        });
      }
      // A voided sale must void its provider transaction too: mark the
      // commit rows here, inside the void transaction, so the void can
      // never commit while the provider still shows the sale as live. The
      // tax_provider_commit scan performs the provider void call.
      if (PROVIDER_COMMIT_KINDS[String(doc.kind)]) {
        await requestProviderVoidTx(tx, { orgId, documentId });
      }
      return {
        reversalEntryId,
        kind: String(doc.kind),
        previousStatus: String(doc.status),
        pairedDocumentId,
      };
    });
    await emitStatusChange(
      result.kind,
      documentId,
      { from: result.previousStatus, to: "voided" },
      { orgId },
    );
    if (result.pairedDocumentId) {
      const pairedKind =
        result.kind === "purchase_receipt" ? "sales_fulfillment" : "purchase_receipt";
      await emitStatusChange(
        pairedKind,
        result.pairedDocumentId,
        { from: "approved", to: "voided" },
        { orgId },
      );
    }
    return result.reversalEntryId;
  });
}
