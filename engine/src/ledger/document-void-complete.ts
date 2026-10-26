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
import { releaseWithholdingDeposit } from "../contractor-withholding/deposits.ts";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  periodClosedDetailsOf,
} from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { reversalPostEntryLine } from "../journal/reversal-posting-lines.ts";
import { emitStatusChange } from "../flows/run.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import {
  releaseCamBillingProvenance,
  releaseBillingProvenance,
  releaseConvertedOrderQuantities,
  releaseVendorBillProvenance,
} from "./billing-provenance.ts";
import { reverseFieldTicketProgressInTransaction } from "../projects/progress.ts";
import { releaseLeavePayrollInputs } from "../payroll/leave-payroll-inputs.ts";
import { releaseAllowancePayrollInputs } from "../payroll/allowance-payroll-inputs.ts";
import { reverseDropShipConfirmationPair } from "../inventory/drop-ship-reversal.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { emitDocumentVoided } from "../webhooks/emit.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { reverseStoredValueForVoidedDocument } from "../stored-value/void-reversal.ts";
import { PROVIDER_COMMIT_KINDS, requestProviderVoidTx } from "../tax/provider-commit.ts";
import {
  voidPaymentWithholdings,
  releaseWithholdingRemittance,
} from "../contractor-withholding/service.ts";
import { AmortizationError } from "../amortization/errors.ts";
import { cancelAmortizationForVoidedSource } from "../amortization/source-void.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import {
  DocumentVoidError,
  PAYMENT_KINDS,
  assertPostingEffectsCompleteForVoid,
  carriedCreditAllocations,
  isLockNotAvailable,
  refuseBilledCostSourceVoid,
  releaseCarriedCreditAllocations,
  resolveVoidReversalPeriod,
  voidCloseModule,
} from "./document-void-shared.ts";
import { reverseBillInventoryReceipts, reverseOrderShipment } from "./document-void-inventory.ts";
import {
  assertRetainageDrawVoidable,
  refuseDrawReleaseBehindLaterDraws,
  refuseUnavailablePayRunVoid,
} from "./document-void-remedies.ts";

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

      // Discover the source entry and all currently live application endpoints
      // before taking locks. lockApplicationEvidence then acquires the shared
      // document → entry → line protocol used by application writers. The
      // transaction remains open through all refusal checks and the reversal.
      const discovered = (
        await tx.execute<{ posted_entry_id: string | null; kind: string; custom: unknown }>(
          sql`
        select posted_entry_id, kind, custom
          from documents
         where id = ${documentId} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      const discoveredEntryId = discovered?.posted_entry_id ?? null;
      // A payment's carried credit allocations are released with it below, so
      // their credit and target lines join the same evidence lock.
      const carriedCreditEndpoints =
        discovered && PAYMENT_KINDS.has(discovered.kind)
          ? carriedCreditAllocations(discovered.custom).flatMap((allocation) => [
              allocation.fromLineId,
              allocation.toLineId,
            ])
          : [];
      const endpointIds = discoveredEntryId
        ? (
            await tx.execute<{ id: string }>(
              sql`
            with source_lines as (
              select id from journal_lines
               where org_id = ${orgId} and entry_id = ${discoveredEntryId}
            ), related_lines as (
              select a.from_line_id as id
                from applications a
               where a.org_id = ${orgId} and a.unapplied_at is null
                 and a.to_line_id in (select id from source_lines)
              union
              select a.to_line_id as id
                from applications a
               where a.org_id = ${orgId} and a.unapplied_at is null
                 and a.from_line_id in (select id from source_lines)
            )
            select id from source_lines
            union
            select id from related_lines
          `,
              "objects",
            )
          )
            .map((row) => row.id)
            .concat(carriedCreditEndpoints)
        : [];
      let lockedEvidence: Awaited<ReturnType<typeof lockApplicationEvidence>>;
      try {
        lockedEvidence = await lockApplicationEvidence(
          tx,
          orgId,
          endpointIds,
          [documentId],
          discoveredEntryId ? [discoveredEntryId] : [],
          { nowait: true },
        );
      } catch (error) {
        if (isLockNotAvailable(error)) {
          throw new DocumentVoidError(
            "another application or posting is in flight — retry the void once it completes",
            409,
          );
        }
        throw error;
      }
      const locked = await tx.execute<Record<string, unknown>>(
        sql`
        select *
          from documents
         where id = ${documentId} and org_id = ${orgId}
         for update
      `,
        "objects",
      );
      const doc = locked[0];
      if (!doc) throw new DocumentVoidError("document not found");
      if (
        allowedSubsidiaryIds !== undefined &&
        !subsidiaryScopeAllows(allowedSubsidiaryIds, doc.subsidiary_id as string | null)
      ) {
        throw new ScopeNotFoundError();
      }
      const rebateClaim = await rebateSettlementVoidContext(orgId, documentId);
      const currentEntryId = doc.posted_entry_id ? String(doc.posted_entry_id) : null;
      if (currentEntryId !== discoveredEntryId) {
        throw new DocumentVoidError(
          "the document posting changed while its void was being completed — retry",
          409,
        );
      }
      if (currentEntryId) {
        const liveEndpoints = (
          await tx.execute<{ id: string }>(
            sql`
          with source_lines as (
            select id from journal_lines
             where org_id = ${orgId} and entry_id = ${currentEntryId}
          ), related_lines as (
            select a.from_line_id as id
              from applications a
             where a.org_id = ${orgId} and a.unapplied_at is null
               and a.to_line_id in (select id from source_lines)
            union
            select a.to_line_id as id
              from applications a
             where a.org_id = ${orgId} and a.unapplied_at is null
               and a.from_line_id in (select id from source_lines)
          )
          select id from source_lines
          union
          select id from related_lines
        `,
            "objects",
          )
        ).map((row) => row.id);
        const lockedLineIds = new Set(lockedEvidence.lineIds);
        if (liveEndpoints.some((id) => !lockedLineIds.has(id))) {
          throw new DocumentVoidError(
            "an application was created while the void was being prepared — retry after it completes",
            409,
          );
        }
      }
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

      // Downstream fence for every kind. A document that feeds a live
      // downstream document cannot be voided out from under it. This guard
      // used to run only inside `if (entryId)` below, so non-posting order
      // documents (quotes, orders, shipments, receipts — never carrying a
      // posted entry) skipped it entirely.
      const downstream = await tx.execute<{ document_number: string }>(
        sql`
        select d2.document_number
          from document_links dl
          join documents d2 on d2.id = dl.to_document_id and d2.org_id = dl.org_id
         where dl.from_document_id = ${documentId} and dl.org_id = ${orgId}
           and d2.status in ('approved', 'posted')
           and dl.link_type <> 'pays'
         limit 1
      `,
        "objects",
      );
      if (downstream[0]) {
        throw new DocumentVoidError(
          `this transaction feeds ${downstream[0].document_number} — reverse the downstream transaction first`,
        );
      }

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

      let reversalEntryId: string | null = null;
      let pairedDocumentId: string | null = null;
      const kind = String(doc.kind);
      const custom =
        doc.custom && typeof doc.custom === "object" && !Array.isArray(doc.custom)
          ? (doc.custom as Record<string, unknown>)
          : null;
      const confirmation = custom?.dropShipConfirmation;
      const confirmationRecord =
        confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
          ? (confirmation as Record<string, unknown>)
          : null;
      const isDropShipPair =
        kind === "purchase_receipt"
          ? confirmationRecord !== null
          : kind === "sales_fulfillment" &&
            typeof confirmationRecord?.purchaseReceiptId === "string";
      const dropShipPair = isDropShipPair
        ? await reverseDropShipConfirmationPair(tx, {
            orgId,
            documentId,
            document: doc,
            actorId: String(doc.void_requested_by),
            reversalDate: String(doc.void_reversal_date),
            reason: String(doc.void_reason),
            reverseDocument: (voidDocumentId, voidKind) =>
              reverseOrderShipment(tx, {
                orgId,
                voidDocumentId,
                voidKind,
                actorId: String(doc.void_requested_by),
                reversalDate: String(doc.void_reversal_date),
                reason: String(doc.void_reason),
              }),
          })
        : null;
      if (dropShipPair) {
        pairedDocumentId = dropShipPair.pairedDocumentId;
        reversalEntryId = dropShipPair.reversalEntryId;
      } else if (
        String(doc.kind) === "sales_fulfillment" ||
        String(doc.kind) === "purchase_receipt"
      ) {
        // Voiding a shipment or goods receipt unwinds it completely in this
        // transaction: live stock movements are reversed through the
        // inventory kernel and the source order's fulfilled counters are
        // restored, so the quantities can ship again and no relieved stock
        // is stranded. A refused unwind names its real blocker.
        await reverseOrderShipment(tx, {
          orgId,
          voidDocumentId: documentId,
          voidKind: String(doc.kind),
          actorId: String(doc.void_requested_by),
          reversalDate: String(doc.void_reversal_date),
          reason: String(doc.void_reason),
        });
      }

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
        const linkedRetainer = (
          await tx.execute<{ id: string }>(
            sql`
          select id from res_retainers
           where org_id = ${orgId} and invoice_document_id = ${documentId}
           for update
        `,
            "objects",
          )
        )[0];
        if (linkedRetainer) {
          const postedDrawdown = (
            await tx.execute<{ id: string }>(
              sql`
            select id from res_retainer_drawdowns
             where org_id = ${orgId} and retainer_id = ${linkedRetainer.id} and state = 'posted'
             limit 1
          `,
              "objects",
            )
          )[0];
          if (postedDrawdown) {
            throw new DocumentVoidError(
              "this retainer invoice has posted drawdowns and cannot be voided without orphaning their recognition history — keep the invoice posted and correct the issue with an adjusting journal entry",
              409,
              "retainer-drawdowns-posted",
            );
          }
        }
        // lockApplicationEvidence already holds the source, all related
        // application documents and entries, and every active endpoint line
        // in the canonical order. Keep those locks through the checks below
        // and reversal writes so no new application can settle reversed
        // evidence.
        const reconciled = await tx.execute(
          sql`
          select 1
            from reconciliation_matches rm
           where rm.org_id = ${orgId}
             and rm.journal_line_id in (
             select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
           )
           limit 1
        `,
          "objects",
        );
        if (reconciled.length > 0) {
          throw new DocumentVoidError(
            "this transaction is bank-reconciled — remove the reconciliation match before voiding",
          );
        }
        const incoming = await tx.execute(
          sql`
          select 1
            from applications a
           where a.org_id = ${orgId} and a.unapplied_at is null
             and a.to_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
           limit 1
        `,
          "objects",
        );
        if (incoming.length > 0) {
          throw new DocumentVoidError(
            "this transaction has live payments or credits applied to it — unapply them before voiding",
          );
        }
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
        // A voided bill unwinds its own receipt movements above, so the
        // gate below must not trip on the unwound originals: movement rows
        // survive a kernel reversal, and only the reversal row proves the
        // stock went back. Other documents keep the existence rule.
        const billUnwindsInventory = String(doc.kind) === "vendor_bill";
        const dependentSubledger = await tx.execute<{ inventory: boolean; revenue: boolean }>(
          sql`
          select
            exists (
              select 1
                from inventory_movements movement
               where movement.org_id = ${orgId}
                 and movement.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
                 and (${billUnwindsInventory}::boolean = false or not exists (
                   select 1 from inventory_movements reversal
                    where reversal.org_id = movement.org_id
                      and reversal.reverses_movement_id = movement.id
                 ))
            ) as inventory,
            exists (
              select 1
                from performance_obligations obligation
               where obligation.org_id = ${orgId}
                 and obligation.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
                 and obligation.status <> 'cancelled'
            ) as revenue
        `,
          "objects",
        );
        const hasInventoryActivity = dependentSubledger[0]?.inventory ?? false;
        const hasRevenueActivity = dependentSubledger[0]?.revenue ?? false;
        if (hasInventoryActivity || hasRevenueActivity) {
          // The queries above are existence-based: movement and obligation
          // rows survive a kernel reversal, so reversing the stock does not
          // unblock the void — the document stays posted. Branch the refusal
          // by the subledger actually present: the old combined text pointed
          // every inventory case at the revenue cancellation screen, which
          // cannot relieve stock. Every remedy named below exists today; no
          // receipt-selection workflow is claimed.
          const revenueRemedy =
            "revenue contracts cancel from Revenue → contract → Cancel recognition (POST /api/revenue/cancel-recognition)";
          if (!hasInventoryActivity) {
            throw new DocumentVoidError(
              `this transaction has inventory or revenue-recognition subledger activity — use the dedicated return/cancellation workflow: ${revenueRemedy}`,
            );
          }
          const revenueClause = hasRevenueActivity
            ? ` Cancel open revenue recognition from Revenue → contract → Cancel recognition (POST /api/revenue/cancel-recognition).`
            : "";
          if (String(doc.kind) === "vendor_bill") {
            // Only actions that exist today are named, and the financial
            // and stock legs are kept distinct: an account-only vendor
            // credit (no stock lines) posts without inventory evidence and,
            // where cash is still due, applies toward the bill through a
            // vendor payment; Inventory Adjust removes the units at carried
            // cost. Both legs use the item's own inventory adjustment
            // account, so any difference between the credit and the carried
            // cost remains there as the residual. No receipt-selection
            // workflow and no reverse action are claimed.
            throw new DocumentVoidError(
              `this transaction has posted inventory receipt movements — the bill remains posted and cannot be voided. Correct the finances separately from the stock: post an account-only vendor credit (no stock lines) to the item's inventory adjustment account, and where cash is still due apply the credit toward the bill through a vendor payment; correct the stock separately with Inventory Adjust, which removes the units at carried cost against the same adjustment account. Any difference between the credit and the carried cost remains there as the residual.${revenueClause}`,
            );
          }
          throw new DocumentVoidError(
            `this transaction has posted inventory movements — it remains posted even after its stock movements are reversed; voiding cannot unwind the stock ledger.${revenueClause}`,
          );
        }

        // Capitalized cost depends on this posting: an accepted asset proposal
        // or a construction-in-progress link must be reversed first. Pending
        // proposals need nothing here; the reversal voids them.
        const capitalized = (
          await tx.execute<{ accepted: boolean; linked: boolean }>(
            sql`
          select exists (select 1 from asset_proposals p
                          where p.org_id = ${orgId} and p.source_entry_id = ${entryId} and p.status = 'accepted') as accepted,
                 exists (select 1 from asset_cip_costs c
                          where c.org_id = ${orgId} and c.source_entry_id = ${entryId} and c.status = 'linked') as linked
        `,
            "objects",
          )
        )[0];
        if (capitalized?.accepted) {
          throw new DocumentVoidError(
            "this transaction was capitalized through an accepted fixed-asset proposal — reverse the acceptance from Fixed Assets → Proposals (Reverse acceptance), then void the transaction",
          );
        }
        if (capitalized?.linked) {
          throw new DocumentVoidError(
            "this transaction carries a cost linked to construction in progress — unlink the cost from Fixed Assets → Construction in progress, then void the transaction",
          );
        }

        const entryResult = await tx.execute<Record<string, unknown>>(
          sql`
          select * from journal_entries
           where id = ${entryId} and org_id = ${orgId}
           for update
        `,
          "objects",
        );
        const entry = entryResult[0];
        if (!entry || entry.status !== "posted") {
          throw new DocumentVoidError("the source journal entry is not posted");
        }
        const reversalDate = String(doc.void_reversal_date);
        // Reversals are ordinary corrections, so the reversal period resolves
        // through the shared covering-period resolver (the entry subsidiary's
        // effective calendar, regular periods only): a void can no longer
        // land in an adjustment period by date. An adjustment-period reversal
        // names its period explicitly through the stored document override, revalidated here —
        // the validation at request time fails fast, but this one is
        // authoritative: the period may have closed or changed while gates
        // waited. The openness fence below then applies to the override
        // period exactly as it does to a date-resolved one.
        const overridePeriodId = doc.void_reversal_period_id
          ? String(doc.void_reversal_period_id)
          : null;
        const period = overridePeriodId
          ? {
              id: await resolveVoidReversalPeriod(
                tx,
                orgId,
                overridePeriodId,
                reversalDate,
                String(entry.subsidiary_id),
              ),
            }
          : await resolveCoveringPeriod(tx, orgId, reversalDate, String(entry.subsidiary_id));
        if (!period) {
          throw new DocumentVoidError(
            `no accounting period covers ${reversalDate} — generate the period covering that date, then void again`,
            422,
            "reversal-period-uncovered",
          );
        }
        const subsidiaries = await tx.execute<{ subsidiary_id: string }>(
          sql`
          select distinct subsidiary_id
            from journal_lines
           where entry_id = ${entryId} and org_id = ${orgId}
        `,
          "objects",
        );
        try {
          await assertPeriodModulesOpen(tx, {
            orgId,
            periodId: period.id,
            bookId: String(entry.book_id),
            subsidiaryIds: subsidiaries.map((row) => row.subsidiary_id),
            modules: [voidCloseModule(String(doc.kind))],
          });
        } catch (error) {
          if (error instanceof CloseError) {
            throw new DocumentVoidError(
              `the reversal period for ${reversalDate} is closed: ${error.message}`,
              422,
              "reversal-period-closed",
              periodClosedDetailsOf(error),
            );
          }
          throw error;
        }

        const outgoingFx = await tx.execute<{ id: string }>(
          sql`
          select distinct a.fx_gain_loss_entry_id as id
            from applications a
           where a.org_id = ${orgId} and a.unapplied_at is null
             and a.fx_gain_loss_entry_id is not null
             and a.from_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
        `,
          "objects",
        );
        await tx.execute(sql`
          update applications
             set unapplied_at = now(), updated_at = now(),
                 updated_by = ${String(doc.void_requested_by)}
           where org_id = ${orgId} and unapplied_at is null
             and from_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
        `);
        await releaseWithholdingRemittance(tx, orgId, documentId, String(doc.void_requested_by));
        await releaseWithholdingDeposit(tx, orgId, documentId, String(doc.void_requested_by));
        if (PAYMENT_KINDS.has(String(doc.kind))) {
          await releaseCarriedCreditAllocations(tx, {
            orgId,
            paymentDocumentId: documentId,
            entryId,
            allocations: carriedCreditAllocations(doc.custom),
            actorId: String(doc.void_requested_by),
            reason: String(doc.void_reason),
          });
          // The reversal below unwinds the withholding liability leg; the
          // deductions stay as evidence, voided with their payment, so the
          // period's return and any filed revision reflect the change.
          await voidPaymentWithholdings(tx, {
            orgId,
            paymentDocumentId: documentId,
            actorId: String(doc.void_requested_by),
          });
        }

        const reverseEntry = async (sourceEntryId: string, suffix: string): Promise<string> => {
          const sourceResult = await tx.execute<Record<string, unknown>>(
            sql`
            select * from journal_entries
             where id = ${sourceEntryId} and org_id = ${orgId}
             for update
          `,
            "objects",
          );
          const source = sourceResult[0];
          if (!source || source.status !== "posted") {
            throw new DocumentVoidError("linked posted entry is missing or already reversed");
          }
          const lines = await tx
            .select()
            .from(schema.journalLines)
            .where(
              and(
                eq(schema.journalLines.entryId, sourceEntryId),
                eq(schema.journalLines.orgId, orgId),
              ),
            );
          // The reversal posts through the ONE ledger API; the source entry
          // is then marked reversed — never edited.
          const mirror = reversalJournalLines(lines, { entryId: "", orgId });
          const posted = await postEntry(tx, {
            orgId,
            bookId: String(source.book_id),
            subsidiaryId: String(source.subsidiary_id),
            entryNumber: await nextFreeEntryNumber(
              tx,
              orgId,
              `${String(source.entry_number)}-${suffix}`,
            ),
            postingDate: reversalDate,
            periodId: period.id,
            memo: `Reversal: ${String(doc.void_reason)}`,
            sourceDocumentId: documentId,
            origin: String(source.origin),
            reversesEntryId: sourceEntryId,
            actorId: String(doc.void_requested_by),
            closeModules: [voidCloseModule(String(doc.kind))],
            lines: mirror.map(reversalPostEntryLine),
          });
          await markEntryReversed(tx, {
            orgId,
            entryId: sourceEntryId,
            actorId: String(doc.void_requested_by),
          });
          return posted.entryId;
        };

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
        // Post-mode allocations in secondary books live in their own
        // origin='allocation' entries on the same document. Voiding the
        // document must mirror those too, or the secondary books would keep
        // attributed balances the primary books reversed away.
        const linkedAllocations = await tx.execute<{ id: string; book_id: string }>(
          sql`
          select id, book_id
            from journal_entries
           where org_id = ${orgId} and source_document_id = ${documentId}
             -- Live entries only: an allocation entry already reversed must not be mirrored again.
             and origin = 'allocation' and status = 'posted'
           order by id
           for update
        `,
          "objects",
        );
        for (const linked of linkedAllocations) {
          const linkedSubs = await tx.execute<{ subsidiary_id: string }>(
            sql`
            select distinct subsidiary_id
              from journal_lines
             where entry_id = ${linked.id} and org_id = ${orgId}
          `,
            "objects",
          );
          try {
            await assertPeriodModulesOpen(tx, {
              orgId,
              periodId: period.id,
              bookId: linked.book_id,
              subsidiaryIds: linkedSubs.map((row) => row.subsidiary_id),
              modules: [voidCloseModule(String(doc.kind))],
            });
          } catch (error) {
            if (error instanceof CloseError) {
              throw new DocumentVoidError(
                `the reversal period for ${reversalDate} is closed: ${error.message}`,
                422,
                "invalid",
                periodClosedDetailsOf(error),
              );
            }
            throw error;
          }
          await reverseEntry(linked.id, "VOID");
        }
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

      if (String(doc.kind) === "customer_invoice" || String(doc.kind) === "customer_credit") {
        await releaseCamBillingProvenance(tx, orgId, documentId, {
          actorId: String(doc.void_requested_by),
          reason: String(doc.void_reason),
        });
      }
      if (String(doc.kind) === "customer_invoice") {
        await releaseBillingProvenance(tx, orgId, documentId, {
          actorId: String(doc.void_requested_by),
          reason: String(doc.void_reason),
        });
      }
      if (String(doc.kind) === "vendor_bill") {
        await releaseVendorBillProvenance(tx, orgId, documentId, {
          actorId: String(doc.void_requested_by),
          reason: String(doc.void_reason),
        });
      }
      if (String(doc.kind) === "pay_run") {
        await releaseVoidedPayRun(tx, orgId, documentId, String(doc.void_requested_by));
      }
      // A voided child returns its conversion/capture cover to the source
      // order lines, so the remainder is convertible and billable again. A
      // no-op for documents without that provenance (fulfillments, payments,
      // standalone bills) and for legacy children converted before it existed.
      await releaseConvertedOrderQuantities(tx, orgId, documentId, {
        actorId: String(doc.void_requested_by),
        reason: String(doc.void_reason),
        source: "controlled_void",
      });
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

/**
 * Un-count a voided pay run.
 *
 * Reversing the GL is not enough for payroll: the payroll subledger is
 * `pay_runs` + `pay_stubs`, and EVERY consumer of it selects on
 * `pay_runs.run_status = 'committed'` with no predicate on the document's
 * status. Leaving a voided run committed therefore keeps it counted in
 * statutory year-to-date (CPP/CPP2/EI room, US wage bases), WCB annual room,
 * the EHT exemption, T4/T4 Summary/W-2/941 and the remittance summary — so the
 * next run under-deducts against consumed room and the CRA is billed for
 * withholdings that no longer exist. One status write retires the run from all
 * of them at once.
 *
 * The two other claims a commit made must also be released:
 *
 * - `time_entries.payroll_batch_ref` — commit stamps the period's approved
 *   hours with the run id so they are never paid twice. If the void left the
 *   stamp, those hours could never be paid at all.
 * - `entitlement_ledger` movements keyed to the run (vacation/banked-hours
 *   accruals and payouts). Balances are SUM(ledger) with no run-status
 *   predicate, so a voided accrual would stay in the employee's bank. These are
 *   REVERSED, not deleted, dated on the same reversal date as the GL entry so
 *   the entitlement liability and its GL account move together.
 *
 * A run that has been PAID needs no special handling here: the payment applies
 * to the run's open net-pay items, so the generic "live payments or credits
 * applied" guard above already refuses the void.
 */
async function releaseVoidedPayRun(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  actorId: string,
): Promise<void> {
  // A posted remittance bill is an AP payment obligation backed by this
  // run's accrued liabilities. Refuse the source void until that bill is
  // itself reversed; otherwise the bill would remain payable after the
  // payroll subledger has been removed from statutory YTD and the next
  // remittance could pay the same money twice. Locking the bill rows gives
  // this check the same ordering as posting's remittance freshness guard.
  const covered = (
    await tx.execute<{ document_number: string }>(
      sql`
    select bill.document_number
      from pay_runs r
      join documents bill
        on bill.org_id = r.org_id and bill.kind = 'vendor_bill' and bill.status = 'posted'
       and bill.custom ? 'payrollRemittance'
       and bill.custom->'payrollRemittance'->>'from' <= r.pay_date::text
       and bill.custom->'payrollRemittance'->>'to' >= r.pay_date::text
     where r.org_id = ${orgId} and r.document_id = ${documentId}
     order by bill.created_at, bill.id
     limit 1
     for update of bill
  `,
      "objects",
    )
  )[0];
  if (covered) {
    throw new DocumentVoidError(
      `this pay run is covered by posted payroll remittance bill ${covered.document_number}; void the remittance bill first`,
    );
  }

  // A voided source with a committed retro top-up double-pays on reissue:
  // refuse while any non-voided dependent retro run is committed. All such
  // rows are locked first in document order; commitPayRun holds this same
  // row to its flip and never locks the source, so either order serializes.
  const dependents = await tx.execute<{
    document_number: string;
    run_status: string;
    doc_status: string;
  }>(
    sql`
    select retro_doc.document_number, rr.run_status, retro_doc.status as doc_status
      from payroll_retro_settlements st
      join pay_runs rr
        on rr.org_id = st.org_id and rr.document_id = st.retro_pay_run_document_id
      join documents retro_doc
        on retro_doc.id = rr.document_id and retro_doc.org_id = rr.org_id
     where st.org_id = ${orgId} and st.source_pay_run_document_id = ${documentId}
       and rr.run_status <> 'voided'
     order by rr.document_id
     for update of rr
  `,
    "objects",
  );
  const blocking = dependents.find(
    (row) => row.run_status === "committed" && row.doc_status !== "voided",
  );
  if (blocking) {
    throw new DocumentVoidError(
      `this pay run is settled by committed retro pay run ${blocking.document_number}; void the retro run first`,
    );
  }

  await releaseLeavePayrollInputs(tx, { orgId, runDocumentId: documentId });
  await releaseAllowancePayrollInputs(tx, { orgId, runDocumentId: documentId });

  const run = await tx.execute<{ document_id: string }>(
    sql`
    update pay_runs
       set run_status = 'voided', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${documentId}
       and run_status <> 'voided'
     returning document_id
  `,
    "objects",
  );
  if (run.length === 0) return; // already released (idempotent replay)

  await tx.execute(sql`
    update time_entries
       set payroll_batch_ref = null, updated_at = now()
     where org_id = ${orgId} and payroll_batch_ref = ${documentId}
  `);

  // One reversal movement per (run, plan, employee): the unique index
  // entitlement_ledger_run_movement keeps void replay idempotent, and the CAS
  // above already refuses a second void of this run — so a conflict here
  // means some OTHER writer recorded adjustment movements for it, and
  // silently dropping the reversal would leave entitlement balances wrong
  // forever behind a run marked voided. Count the groups the reversal owes
  // and refuse the void (this whole transaction rolls back) if the insert
  // could not write every one of them.
  const owed = (
    await tx.execute<{ n: string }>(
      sql`
    select count(*)::text as n
      from (
        select l.plan_id, l.employee_party_id
          from entitlement_ledger l
         where l.org_id = ${orgId} and l.pay_run_document_id = ${documentId}
           and l.kind <> 'adjustment'
         group by l.org_id, l.plan_id, l.employee_party_id
        having sum(l.amount) <> 0
      ) owed_groups
  `,
      "objects",
    )
  )[0];
  const reversed = await tx.execute<{ id: string }>(
    sql`
    insert into entitlement_ledger
      (org_id, plan_id, employee_party_id, movement_date, amount, hours, kind,
       pay_run_document_id, note, created_by, updated_by)
    select l.org_id, l.plan_id, l.employee_party_id,
           max(l.movement_date),
           -sum(l.amount), -sum(l.hours), 'adjustment', ${documentId},
           'Reversal: voided pay run',
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId}),
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId})
      from entitlement_ledger l
     where l.org_id = ${orgId} and l.pay_run_document_id = ${documentId}
       and l.kind <> 'adjustment'
     group by l.org_id, l.plan_id, l.employee_party_id
    having sum(l.amount) <> 0
    -- A prior adjustment returns no row and the required reversal count refuses the void below.
    on conflict do nothing
    returning id
  `,
    "objects",
  );
  if (Number(owed?.n ?? 0) !== reversed.length) {
    throw new DocumentVoidError(
      "entitlement adjustments already exist for this pay run, so the void cannot reverse its entitlements once; reload the run and review its entitlement adjustments before voiding",
    );
  }
}
