import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "./transaction-audit.ts";

/**
 * Delete a transaction, with accounting-appropriate guards.
 *
 * Drafts / unposted documents have no GL and are removed freely. A POSTED
 * transaction is removed together with its journal entry — but only when it is
 * SAFE to do so:
 *   • its posting period must be open (you can't erase GL from a closed period);
 *   • nothing may have a payment applied AGAINST it (a bill/invoice that has been
 *     paid — unapply the payment first);
 *   • it must not have been converted into a downstream posted document.
 * The document's OWN outgoing applications (when it is itself a payment) are
 * removed first, re-opening the items it had settled.
 *
 * Removing a posted entry is normally blocked by the kernel's je_guard/jl_guard.
 * A guarded open-period delete is an explicit exception: the engine enables
 * openbooks.amend only after proving it safe and writes a complete immutable
 * transaction + GL tombstone to audit_log in the same transaction.
 */

export class DeleteError extends Error {}

export async function deleteDocument(
  documentId: string,
  userId: string,
  audit: { source?: string; reason?: string } = {},
): Promise<{ documentId: string }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId));
    if (!doc) throw new DeleteError("document not found");

    // Capture the complete business record + GL impact before any dependent
    // rows are removed. The audit row is inserted in this same transaction and
    // survives as the deleted transaction's immutable tombstone.
    const before = await captureTransactionAuditSnapshot(tx, documentId);
    if (!before) throw new DeleteError("document not found");

    const entryId = doc.status === "posted" ? doc.postedEntryId : null;

    if (entryId) {
      // 1. period open?
      const closed = (await tx.execute(sql`
        select 1 from journal_entries e
         where e.id = ${entryId}
           and (
             period_module_is_closed(e.org_id, e.period_id, e.book_id,
               nullif(to_jsonb(e)->>'subsidiary_id', '')::uuid, 'gl')
             or exists (
               select 1 from journal_lines l where l.entry_id = e.id
                 and period_module_is_closed(e.org_id, e.period_id, e.book_id,
                   nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl')
             )
           )`)) as unknown as { rows: unknown[] };
      if (closed.rows.length > 0) {
        throw new DeleteError(
          `${doc.documentNumber} is posted into a closed period — reopen the period to delete it`,
        );
      }

      // 2. does another transaction settle THIS document's open item?
      //    (a payment applied to this bill/invoice). Block — unapply it first.
      const settled = (await tx.execute(sql`
        select 1 from applications a
          join journal_lines jl on jl.id = a.to_line_id
         where jl.entry_id = ${entryId} and a.unapplied_at is null
         limit 1`)) as unknown as { rows: unknown[] };
      if (settled.rows.length > 0) {
        throw new DeleteError(
          `${doc.documentNumber} has payments applied to it — unapply them before deleting`,
        );
      }

      // 3. converted into a downstream posted document?
      const converted = (await tx.execute(sql`
        select 1 from document_links dl
          join documents d2 on d2.id = dl.to_document_id
         where dl.from_document_id = ${documentId} and d2.status = 'posted'
         limit 1`)) as unknown as { rows: unknown[] };
      if (converted.rows.length > 0) {
        throw new DeleteError(
          `${doc.documentNumber} was converted into a posted document — delete that first`,
        );
      }
    }

    // Allow removing a posted entry (kernel je_guard/jl_guard honor this flag).
    await tx.execute(sql`set local openbooks.amend = on`);

    if (entryId) {
      // Clear rows that FK to this entry's lines first (the GUC relaxes the
      // kernel guards, NOT foreign keys): this document's own applications
      // (it is the payment side — re-opening whatever it settled) and any
      // bank-reconciliation matches on its lines.
      await tx.execute(sql`
        delete from applications
         where from_line_id in (select id from journal_lines where entry_id = ${entryId})
            or to_line_id in (select id from journal_lines where entry_id = ${entryId})`);
      await tx.execute(sql`
        delete from reconciliation_matches
         where journal_line_id in (select id from journal_lines where entry_id = ${entryId})`);
      await tx.execute(
        sql`delete from journal_lines where entry_id = ${entryId}`,
      );
      // Drop the document's back-reference before removing the entry, else the
      // still-live documents.posted_entry_id FK blocks the entry delete.
      await tx.execute(
        sql`update documents set posted_entry_id = null where id = ${documentId}`,
      );
      await tx.execute(sql`delete from journal_entries where id = ${entryId}`);
    }

    await tx.execute(
      sql`delete from document_links where from_document_id = ${documentId} or to_document_id = ${documentId}`,
    );
    await tx.execute(
      sql`delete from document_lines where document_id = ${documentId}`,
    );
    await tx.execute(sql`delete from documents where id = ${documentId}`);

    await recordTransactionAudit(tx, {
      orgId: doc.orgId,
      documentId,
      action: "delete",
      actorId: userId,
      source: audit.source ?? "ui",
      reason: audit.reason ?? "user_requested",
      before,
      after: null,
    });

    return { documentId };
  });
}
