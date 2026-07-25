import { eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { neg } from "../money.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../transaction-audit.ts";
import { assertPeriodModulesOpen, closeModuleForDocument } from "../close.ts";
import { deleteDocument } from "../document-delete.ts";

export type SourceDeletionAction = "retain" | "void";

const SOURCE_REF_KEYS: Record<string, string> = {
  netsuite: "nsId",
  qbo: "qboId",
  qbd: "qbdId",
  xero: "xeroId",
  odoo: "odooId",
  erpnext: "erpId",
  dynamics: "bcId",
};

export class SourceDeletionResolutionError extends Error {
  readonly name = "SourceDeletionResolutionError";
}

/**
 * Mirror a source deletion automatically. The source is the system of
 * record: a transaction deleted (or cancelled) upstream must vanish here
 * too — never linger as a report-only divergence. Settlements touching the
 * document's entry are released first (the source's applications vanished
 * with the transaction, so the items it settled re-open exactly like the
 * source's), then the document is removed through the engine's guarded
 * delete — the same atomic audit tombstone as a controller-initiated
 * delete. A document that cannot be removed (controller-closed GL period,
 * downstream posted conversion) throws, so the caller keeps the ref flagged
 * and verification fails honestly instead of forcing the books.
 */
export async function mirrorSourceDeletion(input: {
  orgId: string;
  source: string;
  sourceRef: string;
}): Promise<{ documentId: string | null; deleted: boolean }> {
  return withOrg(input.orgId, async () => {
    const refKey = SOURCE_REF_KEYS[input.source];
    if (!refKey)
      throw new SourceDeletionResolutionError(
        `source deletion mirroring is unsupported for ${input.source}`,
      );
    const documentResult = (await db.execute(sql`
      select id, kind, status, posted_entry_id
        from documents
       where org_id = ${input.orgId} and custom->>${refKey} = ${input.sourceRef}
       limit 1 for update`)) as unknown as {
      rows: {
        id: string;
        kind: string;
        status: string;
        posted_entry_id: string | null;
      }[];
    };
    const document = documentResult.rows[0] ?? null;
    if (!document) return { documentId: null, deleted: false };
    if (document.posted_entry_id) {
      // Release every settlement touching the entry, both directions. The
      // guarded delete below does this too, but only after its open-item
      // guard BLOCKS on incoming applications — the mirror releases them
      // deliberately, so clear the guard's evidence first.
      await db.execute(sql`
        delete from applications
         where from_line_id in (select id from journal_lines where entry_id = ${document.posted_entry_id})
            or to_line_id in (select id from journal_lines where entry_id = ${document.posted_entry_id})`);
    }
    await deleteDocument(document.id, null, {
      source: "mirror",
      reason: `source_deleted:${input.source}:${input.sourceRef}`,
    });
    return { documentId: document.id, deleted: true };
  });
}

/**
 * Record the controller's disposition of an upstream deletion. Retain is an
 * evidence-only acknowledgement. Void reverses an unapplied posted document
 * (or voids an unposted one) and records the decision atomically.
 */
export async function resolveSourceDeletion(input: {
  orgId: string;
  connectionId: string;
  sourceRef: string;
  action: SourceDeletionAction;
  actorId: string;
  note?: string | null;
}): Promise<{
  documentId: string | null;
  action: SourceDeletionAction;
  reversalEntryId: string | null;
}> {
  return withOrg(input.orgId, async () => {
    const connection = (await db.execute(sql`
      select source from connections where id = ${input.connectionId} and org_id = ${input.orgId}
      for update`)) as unknown as { rows: { source: string }[] };
    const source = connection.rows[0]?.source;
    if (!source)
      throw new SourceDeletionResolutionError("connection not found");
    const refKey = SOURCE_REF_KEYS[source];
    if (!refKey)
      throw new SourceDeletionResolutionError(
        `source deletion resolution is unsupported for ${source}`,
      );

    const documentResult = (await db.execute(sql`
      select id, kind, status, posted_entry_id
        from documents
       where org_id = ${input.orgId} and custom->>${refKey} = ${input.sourceRef}
       limit 1 for update`)) as unknown as {
      rows: {
        id: string;
        kind: string;
        status: string;
        posted_entry_id: string | null;
      }[];
    };
    const document = documentResult.rows[0] ?? null;
    let reversalEntryId: string | null = null;

    if (input.action === "void") {
      if (!document)
        throw new SourceDeletionResolutionError(
          "the imported document no longer exists",
        );
      if (document.status !== "voided" && document.posted_entry_id) {
        const applications = (await db.execute(sql`
          select 1
            from applications a
           where a.unapplied_at is null and (
             exists (select 1 from journal_lines jl where jl.id = a.from_line_id and jl.entry_id = ${document.posted_entry_id})
             or exists (select 1 from journal_lines jl where jl.id = a.to_line_id and jl.entry_id = ${document.posted_entry_id})
           ) limit 1`)) as unknown as { rows: unknown[] };
        if (applications.rows.length > 0) {
          throw new SourceDeletionResolutionError(
            "the source-deleted document has active payment applications; reverse or unapply them before voiding",
          );
        }

        const [entry] = await db
          .select()
          .from(schema.journalEntries)
          .where(eq(schema.journalEntries.id, document.posted_entry_id));
        if (!entry || entry.status !== "posted") {
          throw new SourceDeletionResolutionError(
            "the document's posted journal is missing or already reversed",
          );
        }
        const lines = await db
          .select()
          .from(schema.journalLines)
          .where(eq(schema.journalLines.entryId, entry.id));
        const postingDate = new Date().toISOString().slice(0, 10);
        const period = (await db.execute(sql`
          select id from accounting_periods
           where org_id = ${input.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
             and is_adjustment = false
           limit 1`)) as unknown as { rows: { id: string }[] };
        if (!period.rows[0]) {
          throw new SourceDeletionResolutionError(
            "no open accounting period covers the source-deletion resolution date",
          );
        }
        await assertPeriodModulesOpen(db, {
          orgId: input.orgId,
          periodId: period.rows[0].id,
          bookId: entry.bookId,
          subsidiaryIds: lines.map((line) => line.subsidiaryId),
          modules: [closeModuleForDocument(document.kind)],
        });

        const before = await captureTransactionAuditSnapshot(db, document.id);
        if (!before)
          throw new SourceDeletionResolutionError(
            "document disappeared while resolving deletion",
          );
        const [reversal] = await db
          .insert(schema.journalEntries)
          .values({
            orgId: input.orgId,
            bookId: entry.bookId,
            subsidiaryId: entry.subsidiaryId,
            entryNumber: `${entry.entryNumber}-SOURCE-DELETE`,
            postingDate,
            periodId: period.rows[0].id,
            memo: `Source deletion ${source}:${input.sourceRef}${input.note ? ` — ${input.note}` : ""}`,
            status: "draft",
            sourceDocumentId: document.id,
            origin: "migration",
            reversesEntryId: entry.id,
            createdBy: input.actorId,
            updatedBy: input.actorId,
          })
          .returning({ id: schema.journalEntries.id });
        await db.insert(schema.journalLines).values(
          lines.map((line) => ({
            orgId: input.orgId,
            entryId: reversal.id,
            lineNumber: line.lineNumber,
            accountId: line.accountId,
            subsidiaryId: line.subsidiaryId,
            amount: neg(line.amount),
            currency: line.currency,
            txnAmount: neg(line.txnAmount),
            fxRate: line.fxRate,
            partyId: line.partyId,
            departmentId: line.departmentId,
            projectId: line.projectId,
            locationId: line.locationId,
            classId: line.classId,
            equipmentUnitId: line.equipmentUnitId,
            extraDims: line.extraDims,
            paymentCardId: line.paymentCardId,
            taxCodeId: line.taxCodeId,
            memo: line.memo,
            dueDate: null,
            isOpenItem: false,
          })),
        );
        await db
          .update(schema.journalEntries)
          .set({ status: "posted", postedAt: new Date() })
          .where(eq(schema.journalEntries.id, reversal.id));
        await db
          .update(schema.journalEntries)
          .set({ status: "reversed" })
          .where(eq(schema.journalEntries.id, entry.id));
        await db.execute(sql`
          update documents set status = 'voided', voided_at = now(), updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id}`);
        await db.execute(
          sql`select recompute_document_open_balance(${document.id})`,
        );
        const after = await captureTransactionAuditSnapshot(db, document.id);
        await recordTransactionAudit(db, {
          orgId: input.orgId,
          documentId: document.id,
          action: "update",
          actorId: input.actorId,
          source: "source-deletion-resolution",
          reason: `${source}:${input.sourceRef} deleted at source`,
          before,
          after,
        });
        reversalEntryId = reversal.id;
      } else if (document.status !== "voided") {
        await db.execute(sql`
          update documents set status = 'voided', voided_at = now(), updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id}`);
      }
    }

    await db.execute(sql`
      insert into source_deletion_resolutions
        (org_id, connection_id, source_ref, document_id, action, note, resolved_by,
         created_by, updated_by, resolved_at)
      values (${input.orgId}, ${input.connectionId}, ${input.sourceRef}, ${document?.id ?? null},
              ${input.action}, ${input.note ?? null}, ${input.actorId}, ${input.actorId}, ${input.actorId}, now())
      on conflict (connection_id, source_ref) do update set
        document_id = excluded.document_id, action = excluded.action, note = excluded.note,
        resolved_by = excluded.resolved_by, resolved_at = now(), updated_by = excluded.updated_by,
        updated_at = now()`);
    return {
      documentId: document?.id ?? null,
      action: input.action,
      reversalEntryId,
    };
  });
}
