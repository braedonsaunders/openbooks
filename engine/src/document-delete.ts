import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";

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
 * Removing a posted entry is normally blocked by the kernel's je_guard/jl_guard
 * (posted = immutable). A `delete` is the one legitimate exception, so we run it
 * with `session_replication_role = replica` (transaction-local) to bypass the
 * triggers — after the guards above have proven it safe.
 */

export class DeleteError extends Error {}

export async function deleteDocument(documentId: string, userId: string): Promise<{ documentId: string }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    if (!doc) throw new DeleteError("document not found");

    const entryId = doc.status === "posted" ? doc.postedEntryId : null;

    if (entryId) {
      // 1. period open?
      const closed = (await tx.execute(sql`
        select 1 from journal_entries e
          join accounting_periods p on p.id = e.period_id
         where e.id = ${entryId} and p.gl_closed_at is not null`)) as unknown as { rows: unknown[] };
      if (closed.rows.length > 0) {
        throw new DeleteError(`${doc.documentNumber} is posted into a closed period — reopen the period to delete it`);
      }

      // 2. does another transaction settle THIS document's open item?
      //    (a payment applied to this bill/invoice). Block — unapply it first.
      const settled = (await tx.execute(sql`
        select 1 from applications a
          join journal_lines jl on jl.id = a.to_line_id
         where jl.entry_id = ${entryId} and a.unapplied_at is null
         limit 1`)) as unknown as { rows: unknown[] };
      if (settled.rows.length > 0) {
        throw new DeleteError(`${doc.documentNumber} has payments applied to it — unapply them before deleting`);
      }

      // 3. converted into a downstream posted document?
      const converted = (await tx.execute(sql`
        select 1 from document_links dl
          join documents d2 on d2.id = dl.to_document_id
         where dl.from_document_id = ${documentId} and d2.status = 'posted'
         limit 1`)) as unknown as { rows: unknown[] };
      if (converted.rows.length > 0) {
        throw new DeleteError(`${doc.documentNumber} was converted into a posted document — delete that first`);
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
      await tx.execute(sql`delete from journal_lines where entry_id = ${entryId}`);
      await tx.execute(sql`delete from journal_entries where id = ${entryId}`);
    }

    await tx.execute(sql`delete from document_links where from_document_id = ${documentId} or to_document_id = ${documentId}`);
    await tx.execute(sql`delete from document_lines where document_id = ${documentId}`);
    await tx.execute(sql`delete from documents where id = ${documentId}`);

    return { documentId };
  });
}
