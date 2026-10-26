import { and, eq, sql } from "drizzle-orm";
import { schema } from "../platform/db.ts";
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
import { releaseWithholdingDeposit } from "../contractor-withholding/deposits.ts";
import {
  voidPaymentWithholdings,
  releaseWithholdingRemittance,
} from "../contractor-withholding/service.ts";
import {
  releaseCamBillingProvenance,
  releaseBillingProvenance,
  releaseConvertedOrderQuantities,
  releaseVendorBillProvenance,
} from "./billing-provenance.ts";
import { voidRemedyHooks } from "../journal/void-remedy-contributors.ts";
import {
  DocumentVoidError,
  PAYMENT_KINDS,
  carriedCreditAllocations,
  releaseCarriedCreditAllocations,
  resolveVoidReversalPeriod,
  voidCloseModule,
} from "./document-void-shared.ts";
import { releaseVoidedPayRun } from "./document-void-remedies.ts";
import type { VoidDocumentRow, VoidTransaction } from "./document-void-guards.ts";

/** What a void reverses its posting with: the reversal date and its open period. */
export interface VoidReversal {
  orgId: string;
  documentId: string;
  doc: VoidDocumentRow;
  reversalDate: string;
  period: { id: string };
}

/**
 * Unwind a voided shipment or goods receipt — a drop-ship confirmation pair
 * reverses both sides — returning the pair's reversal entry and paired document.
 */
export async function unwindVoidedShipment(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
  doc: VoidDocumentRow,
): Promise<{ reversalEntryId: string | null; pairedDocumentId: string | null }> {
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
      : kind === "sales_fulfillment" && typeof confirmationRecord?.purchaseReceiptId === "string";
  const dropShipPair = isDropShipPair
    ? await voidRemedyHooks.require("inventory").reverseDropShipConfirmationPair(tx, {
        orgId,
        documentId,
        document: doc,
        actorId: String(doc.void_requested_by),
        reversalDate: String(doc.void_reversal_date),
        reason: String(doc.void_reason),
        reverseDocument: (voidDocumentId, voidKind) =>
          voidRemedyHooks.require("inventory").reverseOrderShipment(tx, {
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
  } else if (String(doc.kind) === "sales_fulfillment" || String(doc.kind) === "purchase_receipt") {
    // Voiding a shipment or goods receipt unwinds it completely in this
    // transaction: live stock movements are reversed through the
    // inventory kernel and the source order's fulfilled counters are
    // restored, so the quantities can ship again and no relieved stock
    // is stranded. A refused unwind names its real blocker.
    await voidRemedyHooks.require("inventory").reverseOrderShipment(tx, {
      orgId,
      voidDocumentId: documentId,
      voidKind: String(doc.kind),
      actorId: String(doc.void_requested_by),
      reversalDate: String(doc.void_reversal_date),
      reason: String(doc.void_reason),
    });
  }
  return { reversalEntryId, pairedDocumentId };
}

/**
 * Lock the posted source entry and resolve the open period its reversal lands
 * in, refusing an uncovered or closed reversal date by name.
 */
export async function lockVoidReversalPeriod(
  tx: VoidTransaction,
  args: { orgId: string; entryId: string; doc: VoidDocumentRow },
): Promise<{ id: string }> {
  const { orgId, entryId, doc } = args;
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
  // Reversals are ordinary corrections: the period resolves through the
  // shared covering-period resolver (the entry subsidiary's effective
  // calendar, regular periods only), so a date never lands a void in an
  // adjustment period. An adjustment-period reversal names its period
  // through the stored document override, revalidated here because the
  // period may have closed or changed while gates waited; the openness
  // fence below applies to it exactly as to a date-resolved period.
  const overridePeriodId = doc.void_reversal_period_id ? String(doc.void_reversal_period_id) : null;
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
  return period;
}

/**
 * Unapply the entry's outgoing applications and release the withholding and
 * carried-credit evidence they settled, returning the realized-FX entries to reverse.
 */
export async function releaseVoidedEntrySettlements(
  tx: VoidTransaction,
  args: { orgId: string; documentId: string; entryId: string; doc: VoidDocumentRow },
): Promise<{ id: string }[]> {
  const { orgId, documentId, entryId, doc } = args;
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
  return outgoingFx;
}

/**
 * Reverse one posted entry through the one ledger API and mark the source
 * reversed — never edited. Returns the reversal entry id.
 */
export async function reverseVoidedEntry(
  tx: VoidTransaction,
  reversal: VoidReversal,
  sourceEntryId: string,
  suffix: string,
): Promise<string> {
  const { orgId, documentId, doc, reversalDate, period } = reversal;
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
      and(eq(schema.journalLines.entryId, sourceEntryId), eq(schema.journalLines.orgId, orgId)),
    );
  // The reversal posts through the ONE ledger API; the source entry
  // is then marked reversed — never edited.
  const mirror = reversalJournalLines(lines, { entryId: "", orgId });
  const posted = await postEntry(tx, {
    orgId,
    bookId: String(source.book_id),
    subsidiaryId: String(source.subsidiary_id),
    entryNumber: await nextFreeEntryNumber(tx, orgId, `${String(source.entry_number)}-${suffix}`),
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
}

// Post-mode allocations in secondary books live in their own
// origin='allocation' entries on the same document. Voiding the
// document must mirror those too, or the secondary books would keep
// attributed balances the primary books reversed away.
export async function reverseLinkedAllocationEntries(
  tx: VoidTransaction,
  reversal: VoidReversal,
  reverseEntry: (sourceEntryId: string, suffix: string) => Promise<string>,
): Promise<void> {
  const { orgId, documentId, doc, reversalDate, period } = reversal;
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
}

/** Return the voided document's billing, conversion and payroll claims to their sources. */
export async function releaseVoidedProvenance(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
  doc: VoidDocumentRow,
): Promise<void> {
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
  // standalone bills) and for children converted without it.
  await releaseConvertedOrderQuantities(tx, orgId, documentId, {
    actorId: String(doc.void_requested_by),
    reason: String(doc.void_reason),
    source: "controlled_void",
  });
}
