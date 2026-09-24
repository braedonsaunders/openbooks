import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { documentRevisionCounterSql, isDocumentRevisionToken } from "../records/revision.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { releaseCamBillingProvenance, releaseBillingProvenance, releaseConvertedOrderQuantities, releaseVendorBillProvenance, releaseVendorRetainageProvenance } from "./billing-provenance.ts";
import { releaseCaptureMaterialization } from "../payables/ap-capture-service.ts";

/**
 * Physical deletion is intentionally limited to drafts. Once a document has
 * entered approval, been issued, or affected the ledger it is part of the
 * books' evidence chain and must be cancelled/voided instead.
 */
export class DeleteError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export async function deleteDocument(
  documentId: string,
  userId: string | null,
  orgId: string,
  audit: {
    source?: string;
    reason?: string;
    expectedUpdatedAt?: string;
    /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<{ documentId: string }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ ...getTableColumns(schema.documents), revision: documentRevisionCounterSql(sql`revision_seq`) })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
      .for("update");
    if (!doc) throw new ScopeNotFoundError();
    // The scope verdict runs under the document lock: an unlocked route
    // precheck can authorize entity A while a concurrent A→B rehome lands
    // before this delete commits. Missing, cross-org, and out-of-scope
    // answer alike.
    if (!subsidiaryScopeAllows(audit.allowedSubsidiaryIds, doc.subsidiaryId)) throw new ScopeNotFoundError();
    if (audit.expectedUpdatedAt !== undefined &&
        (!isDocumentRevisionToken(audit.expectedUpdatedAt) || audit.expectedUpdatedAt !== doc.revision)) {
      throw new DeleteError("this document changed after you opened it; reload and review the latest revision", 409);
    }
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
       where dl.from_document_id = ${documentId} and dl.org_id = ${doc.orgId}
         and dl.link_type <> 'reverses'
       limit 1
    `));
    if (downstream.rows[0]) {
      throw new DeleteError(
        `${doc.documentNumber} is the source of ${downstream.rows[0].document_number} — remove the downstream document first`,
      );
    }

    const before = await captureTransactionAuditSnapshot(tx, documentId, orgId);
    if (!before) throw new DeleteError("document not found");

    if (doc.kind === "customer_invoice" || doc.kind === "customer_credit") {
      await releaseCamBillingProvenance(tx, doc.orgId, documentId, { actorId: userId, reason: audit.reason?.trim() || "draft_discarded" });
    }
    if (doc.kind === "customer_invoice") {
      await releaseBillingProvenance(tx, doc.orgId, documentId, { actorId: userId, reason: audit.reason?.trim() || "draft_discarded" });
    }
    if (doc.kind === "vendor_bill") {
      await releaseVendorBillProvenance(tx, doc.orgId, documentId, { actorId: userId, reason: audit.reason?.trim() || "draft_discarded" });
      // The retainage release reservation must go before the document row it
      // references; the FK would otherwise reject the delete with 23503.
      // Voided bills keep their row as posted-history provenance instead.
      await releaseVendorRetainageProvenance(tx, doc.orgId, documentId, { actorId: userId, reason: audit.reason?.trim() || "draft_discarded" });
    }
    if (doc.kind === "vendor_bill" || doc.kind === "vendor_credit") {
      // The capture item points at this draft (RESTRICT); without releasing it
      // first the row delete fails — and a discarded draft must return its
      // capture to the review queue for correction and re-materialization.
      await releaseCaptureMaterialization(tx, doc.orgId, documentId, {
        actorId: userId,
        reason: audit.reason?.trim() || "draft_discarded",
      });
    }
    // A discarded draft child returns its conversion/capture cover to the
    // source order lines before its own lines disappear, so the remainder is
    // convertible and billable again. Runs before the link/line deletes below.
    await releaseConvertedOrderQuantities(tx, doc.orgId, documentId, {
      actorId: userId,
      reason: audit.reason?.trim() || "draft_discarded",
      source: audit.source ?? "ui",
    });
    await tx.execute(
      sql`delete from document_links where org_id = ${doc.orgId} and (from_document_id = ${documentId} or to_document_id = ${documentId})`,
    );
    await tx.execute(
      sql`delete from document_line_tax_components
           where org_id = ${doc.orgId}
             and document_line_id in (
             select id from document_lines where document_id = ${documentId} and org_id = ${doc.orgId}
           )`,
    );
    await tx.execute(
      sql`delete from document_lines where document_id = ${documentId} and org_id = ${doc.orgId}`,
    );
    await tx.execute(sql`delete from documents where id = ${documentId} and org_id = ${doc.orgId}`);

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
