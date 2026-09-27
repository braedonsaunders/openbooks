import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "../records/transaction-audit.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class DropShipPairVoidRefusal extends PostingError {
  readonly status = 409;
  readonly code = "drop_ship_pair_void_refused";
}

/** Lock contention in the shared application-evidence protocol (55P03). */
function isLockNotAvailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: string }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

type DropShipPairDocument = {
  id: string;
  document_number: string;
  kind: string;
  status: string;
  subsidiary_id: string | null;
  void_requested_at: Date | string | null;
  custom: Record<string, unknown> | null;
};

function nestedString(value: unknown, parent: string, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[parent];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const result = (nested as Record<string, unknown>)[key];
  return typeof result === "string" && result ? result : null;
}

/**
 * A drop-ship receipt and its fulfilment are one commercial confirmation.
 * Voiding either reverses the shared no-layer entries through postEntry and
 * restores both order-line counters before either document becomes void.
 */
export async function reverseDropShipConfirmationPair(
  tx: Tx,
  input: {
    orgId: string;
    documentId: string;
    document: Record<string, unknown>;
    actorId: string;
    reversalDate: string;
    reason: string;
    reverseDocument: (documentId: string, kind: "purchase_receipt" | "sales_fulfillment") => Promise<void>;
  },
): Promise<{ pairedDocumentId: string; reversalEntryId: string | null } | null> {
  const kind = String(input.document.kind);
  const confirmation = input.document.custom && typeof input.document.custom === "object"
    ? (input.document.custom as Record<string, unknown>).dropShipConfirmation
    : null;
  const receiptId = kind === "purchase_receipt"
    ? input.documentId
    : nestedString(input.document.custom, "dropShipConfirmation", "purchaseReceiptId");
  if (!receiptId || !confirmation) return null;

  let pair: DropShipPairDocument | undefined;
  try {
    pair = (await tx.execute<DropShipPairDocument>(kind === "purchase_receipt" ? sql`
      select id, document_number, kind, status, subsidiary_id, void_requested_at, custom
        from documents
       where org_id = ${input.orgId} and kind = 'sales_fulfillment'
         and custom->'dropShipConfirmation'->>'purchaseReceiptId' = ${receiptId}
       order by id limit 1 for update nowait
    ` : sql`
      select id, document_number, kind, status, subsidiary_id, void_requested_at, custom
        from documents
       where org_id = ${input.orgId} and id = ${receiptId} and kind = 'purchase_receipt'
       for update nowait
    `)).rows[0];
  } catch (error) {
    if (isLockNotAvailable(error)) {
      throw new DropShipPairVoidRefusal(
        "The paired drop-ship document is being changed; retry after that operation completes",
      );
    }
    throw error;
  }
  if (!pair) throw new DropShipPairVoidRefusal("The paired drop-ship document is missing; restore the confirmation pair before voiding");
  if (pair.status === "voided") {
    throw new DropShipPairVoidRefusal(
      `Cannot void this drop-ship confirmation because paired document ${pair.document_number} is already voided`,
    );
  }
  if (pair.status !== "approved" || pair.void_requested_at) {
    throw new DropShipPairVoidRefusal(
      `Cannot void this drop-ship confirmation while paired document ${pair.document_number} is ${pair.status} or has a pending void request`,
    );
  }

  const receipt = kind === "purchase_receipt" ? input.document as DropShipPairDocument : pair;
  const fulfillment = kind === "sales_fulfillment" ? input.document as DropShipPairDocument : pair;
  const sourceEntries = (await tx.execute<{
    id: string;
    entry_number: string;
    status: string;
    book_id: string;
    subsidiary_id: string;
    origin: string;
  }>(sql`
    select id, entry_number, status, book_id, subsidiary_id, origin
      from journal_entries
     where org_id = ${input.orgId}
       and custom->'dropShipConfirmation'->>'receiptId' = ${receiptId}
     order by id
     for update
  `)).rows;
  if (sourceEntries.length === 0) {
    throw new DropShipPairVoidRefusal(
      `Drop-ship confirmation for ${receipt.document_number} has no posted cost entry; reconcile its accounting evidence before voiding`,
    );
  }
  if (sourceEntries.some((entry) => entry.status !== "posted")) {
    throw new DropShipPairVoidRefusal(
      `Drop-ship confirmation for ${receipt.document_number} has an entry that is already reversed; resolve the pair's accounting evidence before voiding`,
    );
  }
  for (const entry of sourceEntries) {
    const reconciliation = (await tx.execute(sql`
      select 1 from reconciliation_matches rm
       where rm.org_id = ${input.orgId}
         and rm.journal_line_id in (select id from journal_lines where org_id = ${input.orgId} and entry_id = ${entry.id})
       limit 1
    `)).rows[0];
    if (reconciliation) {
      throw new DropShipPairVoidRefusal(
        `Drop-ship confirmation entry ${entry.entry_number} is bank-reconciled; remove its reconciliation match before voiding ${receipt.document_number}`,
      );
    }
    const applications = (await tx.execute(sql`
      select 1 from applications a
       where a.org_id = ${input.orgId} and a.unapplied_at is null
         and (a.from_line_id in (select id from journal_lines where org_id = ${input.orgId} and entry_id = ${entry.id})
           or a.to_line_id in (select id from journal_lines where org_id = ${input.orgId} and entry_id = ${entry.id}))
       limit 1
    `)).rows[0];
    if (applications) {
      throw new DropShipPairVoidRefusal(
        `Drop-ship confirmation entry ${entry.entry_number} has a live application; unapply it before voiding ${receipt.document_number}`,
      );
    }
  }

  const reversalDate = input.reversalDate;
  const period = await resolveCoveringPeriod(tx, input.orgId, reversalDate);
  if (!period) {
    throw new DropShipPairVoidRefusal(
      `No open accounting period covers ${reversalDate} for drop-ship confirmation ${receipt.document_number} paired with ${pair.document_number}; generate the period, then request the void again`,
    );
  }
  for (const entry of sourceEntries) {
    try {
      await assertPeriodModulesOpen(tx, {
        orgId: input.orgId,
        periodId: period.id,
        bookId: entry.book_id,
        subsidiaryIds: [entry.subsidiary_id],
        modules: [],
      });
    } catch (error) {
      if (error instanceof CloseError) {
        throw new DropShipPairVoidRefusal(
          `The reversal period for drop-ship confirmation ${receipt.document_number} and paired document ${pair.document_number} is closed: ${error.message}; open a covering period, then request the void again`,
        );
      }
      throw error;
    }
  }

  await input.reverseDocument(receipt.id, "purchase_receipt");
  await input.reverseDocument(fulfillment.id, "sales_fulfillment");

  const reversalIds: string[] = [];
  for (const entry of sourceEntries) {
    const lines = await tx
      .select()
      .from(schema.journalLines)
      .where(and(eq(schema.journalLines.entryId, entry.id), eq(schema.journalLines.orgId, input.orgId)));
    const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
    const posted = await postEntry(tx, {
      orgId: input.orgId,
      bookId: entry.book_id,
      subsidiaryId: entry.subsidiary_id,
      entryNumber: await nextFreeEntryNumber(tx, input.orgId, `${entry.entry_number}-VOID`),
      postingDate: reversalDate,
      periodId: period.id,
      memo: `Reversal: ${input.reason}`,
      sourceDocumentId: input.documentId,
      origin: entry.origin,
      reversesEntryId: entry.id,
      actorId: input.actorId,
      closeModules: [],
      lines: mirror.map((line) => ({
        accountId: line.accountId,
        subsidiaryId: line.subsidiaryId,
        amount: line.amount,
        currency: line.currency,
        txnAmount: line.txnAmount,
        fxRate: line.fxRate,
        memo: line.memo,
        partyId: line.partyId,
        departmentId: line.departmentId,
        projectId: line.projectId,
        locationId: line.locationId,
        classId: line.classId,
        equipmentUnitId: line.equipmentUnitId,
        extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
        paymentCardId: line.paymentCardId,
        taxCodeId: line.taxCodeId,
        quantity: line.quantity,
        unit: line.unit,
        custom: (line.custom ?? {}) as Record<string, unknown>,
        contributorKind: line.contributorKind,
        contributorRef: line.contributorRef,
        lineNumber: line.lineNumber,
      })),
    });
    await markEntryReversed(tx, { orgId: input.orgId, entryId: entry.id, actorId: input.actorId });
    reversalIds.push(posted.entryId);
  }

  const before = await captureTransactionAuditSnapshot(tx, pair.id, input.orgId);
  if (!before) throw new DropShipPairVoidRefusal(`Paired document ${pair.document_number} disappeared while voiding`);
  const pairUpdate = await tx.execute<{ id: string }>(sql`
    update documents
       set status = 'voided', voided_at = now(), voided_by = ${input.actorId},
           void_reason = ${input.reason},
           reversal_entry_id = ${reversalIds[0] ?? null}, open_balance = null,
           void_requested_at = null, void_requested_by = null, void_reversal_date = null,
           updated_at = now(), updated_by = ${input.actorId}
     where org_id = ${input.orgId} and id = ${pair.id} and status = 'approved'
       and void_requested_at is null
    returning id
  `);
  if (pairUpdate.rows.length !== 1) {
    throw new DropShipPairVoidRefusal(`Paired document ${pair.document_number} changed while the confirmation was being voided`);
  }
  const after = await captureTransactionAuditSnapshot(tx, pair.id, input.orgId);
  await recordTransactionAudit(tx, {
    orgId: input.orgId,
    documentId: pair.id,
    action: "void",
    actorId: input.actorId,
    source: "controlled_void",
    reason: input.reason,
    before,
    after,
  });
  return { pairedDocumentId: pair.id, reversalEntryId: reversalIds[0] ?? null };
}

