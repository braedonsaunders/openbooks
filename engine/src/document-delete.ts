import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "./transaction-audit.ts";
import { releaseBillingProvenance, releaseVendorBillProvenance } from "./billing-provenance.ts";

/**
 * Physical deletion is intentionally limited to drafts. Once a document has
 * entered approval, been issued, or affected the ledger it is part of the
 * books' evidence chain and must be cancelled/voided instead.
 */
export class DeleteError extends Error {}

export async function deleteDocument(
  documentId: string,
  userId: string | null,
  audit: { source?: string; reason?: string } = {},
): Promise<{ documentId: string }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId));
    if (!doc) throw new DeleteError("document not found");
    if (doc.status !== "draft") {
      throw new DeleteError(
        `${doc.documentNumber} is ${doc.status} and cannot be deleted — use the controlled void/cancel action`,
      );
    }

    // Drafts that already feed another record are still evidence in that
    // record's provenance chain. Delete the downstream draft first.
    const downstream = (await tx.execute<{ document_number: string }>(sql`
      select d2.document_number
        from document_links dl
        join documents d2 on d2.id = dl.to_document_id and d2.org_id = dl.org_id
       where dl.from_document_id = ${documentId}
         and dl.link_type <> 'reverses'
       limit 1
    `));
    if (downstream.rows[0]) {
      throw new DeleteError(
        `${doc.documentNumber} is the source of ${downstream.rows[0].document_number} — remove the downstream document first`,
      );
    }

    const before = await captureTransactionAuditSnapshot(tx, documentId);
    if (!before) throw new DeleteError("document not found");

    if (doc.kind === "customer_invoice") {
      await releaseBillingProvenance(tx, doc.orgId, documentId);
    }
    if (doc.kind === "vendor_bill") {
      await releaseVendorBillProvenance(tx, doc.orgId, documentId);
    }
    await tx.execute(
      sql`delete from document_links where from_document_id = ${documentId} or to_document_id = ${documentId}`,
    );
    await tx.execute(
      sql`delete from document_line_tax_components
           where document_line_id in (
             select id from document_lines where document_id = ${documentId}
           )`,
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
      reason: audit.reason?.trim() || "draft_discarded",
      before,
      after: null,
    });
    return { documentId };
  });
}
