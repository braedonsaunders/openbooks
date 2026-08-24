import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { reversalJournalLines } from "../reversal-journal-lines.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../transaction-audit.ts";
import { assertPeriodModulesOpen, closeModuleForDocument } from "../close.ts";

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

// Reserved principal for deterministic connector automation. Human controller
// decisions always retain the actual user id instead.
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

function boundedVoidReason(value: string): string {
  return value.trim().slice(0, 500);
}

/**
 * Mirror a source deletion automatically. The source is the system of
 * record, but OpenBooks retains institutional-grade evidence: touching
 * applications are soft-unapplied, the imported entry is reversed in its
 * original open period, and the document is voided. The complete transaction,
 * application state, and GL before/after evidence are captured atomically.
 * A controller-closed period blocks the correction so verification fails
 * honestly instead of silently moving historical impact into a later period.
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
    return db.transaction(async (tx) => {
      const documentResult = (await tx.execute<{
          id: string;
          kind: string;
          status: string;
          posted_entry_id: string | null;
        }>(sql`
        select id, kind, status, posted_entry_id
          from documents
         where org_id = ${input.orgId} and custom->>${refKey} = ${input.sourceRef}
         limit 1 for update`));
      const document = documentResult.rows[0] ?? null;
      if (!document) return { documentId: null, deleted: false };
      if (document.status === "voided") {
        return { documentId: document.id, deleted: false };
      }
      const before = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
      if (!before) {
        throw new SourceDeletionResolutionError(
          "source-deleted document disappeared while being corrected",
        );
      }
      const voidReason = boundedVoidReason(
        `Source deleted: ${input.source}:${input.sourceRef}`,
      );
      if (!document.posted_entry_id) {
        await tx.execute(sql`
          update documents
             set status = 'voided', voided_at = now(), open_balance = null,
                 voided_by = ${SYSTEM_ACTOR_ID}, void_reason = ${voidReason},
                 updated_at = now(), updated_by = ${SYSTEM_ACTOR_ID}
           where id = ${document.id} and org_id = ${input.orgId}`);
        const after = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
        if (!after) {
          throw new SourceDeletionResolutionError(
            "source-deleted unposted document disappeared after correction",
          );
        }
        await recordTransactionAudit(tx, {
          orgId: input.orgId,
          documentId: document.id,
          action: "update",
          actorId: null,
          source: "mirror",
          reason: `source_deleted:${input.source}:${input.sourceRef}`,
          before,
          after,
        });
        return { documentId: document.id, deleted: true };
      }

      const [entry] = await tx
        .select()
        .from(schema.journalEntries)
        .where(and(eq(schema.journalEntries.id, document.posted_entry_id), eq(schema.journalEntries.orgId, input.orgId)));
      if (!entry || entry.status !== "posted") {
        throw new SourceDeletionResolutionError(
          "source-deleted document's posted journal is missing or not posted",
        );
      }
      const lines = await tx
        .select()
        .from(schema.journalLines)
        .where(and(eq(schema.journalLines.entryId, entry.id), eq(schema.journalLines.orgId, input.orgId)));
      if (lines.length === 0) {
        throw new SourceDeletionResolutionError(
          "source-deleted document's posted journal has no lines",
        );
      }
      await assertPeriodModulesOpen(tx, {
        orgId: input.orgId,
        periodId: entry.periodId,
        bookId: entry.bookId,
        subsidiaryIds: lines.map((line) => line.subsidiaryId),
        modules: [closeModuleForDocument(document.kind)],
      });

      // Application rows are immutable settlement evidence. A source deletion
      // releases them through their one permitted transition; it never erases
      // the evidence or its original endpoints/amounts.
      await tx.execute(sql`
        update applications a
           set unapplied_at = now(), updated_at = now()
         where a.org_id = ${input.orgId} and a.unapplied_at is null and (
           a.from_line_id in (
             select id from journal_lines where entry_id = ${entry.id} and org_id = ${input.orgId}
           )
           or a.to_line_id in (
             select id from journal_lines where entry_id = ${entry.id} and org_id = ${input.orgId}
           )
         )`);

      const reversal = (await tx
        .insert(schema.journalEntries)
        .values({
          orgId: input.orgId,
          bookId: entry.bookId,
          subsidiaryId: entry.subsidiaryId,
          entryNumber: `${entry.entryNumber}-SOURCE-DELETE`,
          postingDate: entry.postingDate,
          periodId: entry.periodId,
          memo: `Source deletion ${input.source}:${input.sourceRef}`,
          status: "draft",
          sourceDocumentId: document.id,
          origin: "migration",
          reversesEntryId: entry.id,
        })
        .returning({ id: schema.journalEntries.id }))[0]!;
      await tx.insert(schema.journalLines).values(
        reversalJournalLines(lines, { entryId: reversal.id, orgId: input.orgId }),
      );
      await tx
        .update(schema.journalEntries)
        .set({ status: "posted", postedAt: new Date() })
        .where(and(eq(schema.journalEntries.id, reversal.id), eq(schema.journalEntries.orgId, input.orgId)));
      await tx
        .update(schema.journalEntries)
        .set({ status: "reversed" })
        .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, input.orgId)));
      await tx.execute(sql`
        update documents
           set status = 'voided', voided_at = now(), open_balance = null,
               voided_by = ${SYSTEM_ACTOR_ID}, void_reason = ${voidReason},
               reversal_entry_id = ${reversal.id},
               updated_at = now(), updated_by = ${SYSTEM_ACTOR_ID}
         where id = ${document.id} and org_id = ${input.orgId}`);
      const after = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
      if (!after) {
        throw new SourceDeletionResolutionError(
          "source-deleted document disappeared after correction",
        );
      }
      await recordTransactionAudit(tx, {
        orgId: input.orgId,
        documentId: document.id,
        action: "update",
        actorId: null,
        source: "mirror",
        reason: `source_deleted:${input.source}:${input.sourceRef}`,
        before,
        after,
      });
      return { documentId: document.id, deleted: true };
    });
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
    const connection = (await db.execute<{ source: string; actor_valid: boolean }>(sql`
      select c.source,
             exists (
               select 1 from users u
                where u.id = ${input.actorId} and u.org_id = ${input.orgId}
                  and u.is_active
             ) as actor_valid
        from connections c
       where c.id = ${input.connectionId} and c.org_id = ${input.orgId}
      for update`));
    const source = connection.rows[0]?.source;
    if (!source)
      throw new SourceDeletionResolutionError("connection not found");
    if (!connection.rows[0]!.actor_valid) {
      throw new SourceDeletionResolutionError(
        "resolution actor is not an active organization user",
      );
    }
    const refKey = SOURCE_REF_KEYS[source];
    if (!refKey)
      throw new SourceDeletionResolutionError(
        `source deletion resolution is unsupported for ${source}`,
      );

    const documentResult = (await db.execute<{
        id: string;
        kind: string;
        status: string;
        posted_entry_id: string | null;
      }>(sql`
      select id, kind, status, posted_entry_id
        from documents
       where org_id = ${input.orgId} and custom->>${refKey} = ${input.sourceRef}
       limit 1 for update`));
    const document = documentResult.rows[0] ?? null;
    let reversalEntryId: string | null = null;

    if (input.action === "void") {
      if (!document)
        throw new SourceDeletionResolutionError(
          "the imported document no longer exists",
        );
      if (document.status !== "voided" && document.posted_entry_id) {
        const voidReason = boundedVoidReason(
          `${source}:${input.sourceRef} deleted at source${input.note ? ` — ${input.note}` : ""}`,
        );
        const applications = (await db.execute(sql`
          select 1
            from applications a
           where a.org_id = ${input.orgId} and a.unapplied_at is null and (
             exists (select 1 from journal_lines jl where jl.id = a.from_line_id and jl.org_id = a.org_id and jl.entry_id = ${document.posted_entry_id})
             or exists (select 1 from journal_lines jl where jl.id = a.to_line_id and jl.org_id = a.org_id and jl.entry_id = ${document.posted_entry_id})
           ) limit 1`));
        if (applications.rows.length > 0) {
          throw new SourceDeletionResolutionError(
            "the source-deleted document has active payment applications; reverse or unapply them before voiding",
          );
        }

        const [entry] = await db
          .select()
          .from(schema.journalEntries)
          .where(and(eq(schema.journalEntries.id, document.posted_entry_id), eq(schema.journalEntries.orgId, input.orgId)));
        if (!entry || entry.status !== "posted") {
          throw new SourceDeletionResolutionError(
            "the document's posted journal is missing or already reversed",
          );
        }
        const lines = await db
          .select()
          .from(schema.journalLines)
          .where(and(eq(schema.journalLines.entryId, entry.id), eq(schema.journalLines.orgId, input.orgId)));
        // Preserve the source transaction's accounting-period allocation.
        // If that period is controller-closed, the correction must stop for a
        // controlled reopen or explicit adjusting-entry decision; silently
        // moving it into today's period would make historical parity false.
        const postingDate = entry.postingDate;
        await assertPeriodModulesOpen(db, {
          orgId: input.orgId,
          periodId: entry.periodId,
          bookId: entry.bookId,
          subsidiaryIds: lines.map((line) => line.subsidiaryId),
          modules: [closeModuleForDocument(document.kind)],
        });

        const before = await captureTransactionAuditSnapshot(db, document.id, input.orgId);
        if (!before)
          throw new SourceDeletionResolutionError(
            "document disappeared while resolving deletion",
          );
        const reversal = (await db
          .insert(schema.journalEntries)
          .values({
            orgId: input.orgId,
            bookId: entry.bookId,
            subsidiaryId: entry.subsidiaryId,
            entryNumber: `${entry.entryNumber}-SOURCE-DELETE`,
            postingDate,
            periodId: entry.periodId,
            memo: `Source deletion ${source}:${input.sourceRef}${input.note ? ` — ${input.note}` : ""}`,
            status: "draft",
            sourceDocumentId: document.id,
            origin: "migration",
            reversesEntryId: entry.id,
            createdBy: input.actorId,
            updatedBy: input.actorId,
          })
          .returning({ id: schema.journalEntries.id }))[0]!;
        await db.insert(schema.journalLines).values(
          reversalJournalLines(lines, { entryId: reversal.id, orgId: input.orgId }),
        );
        await db
          .update(schema.journalEntries)
          .set({ status: "posted", postedAt: new Date() })
          .where(and(eq(schema.journalEntries.id, reversal.id), eq(schema.journalEntries.orgId, input.orgId)));
        await db
          .update(schema.journalEntries)
          .set({ status: "reversed" })
          .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, input.orgId)));
        await db.execute(sql`
          update documents
             set status = 'voided', voided_at = now(),
                 voided_by = ${input.actorId}, void_reason = ${voidReason},
                 reversal_entry_id = ${reversal.id},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id} and org_id = ${input.orgId}`);
        await db.execute(
          sql`select recompute_document_open_balance(${document.id})`,
        );
        const after = await captureTransactionAuditSnapshot(db, document.id, input.orgId);
        if (!after)
          throw new SourceDeletionResolutionError(
            "document disappeared after resolving deletion",
          );
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
        const voidReason = boundedVoidReason(
          `${source}:${input.sourceRef} deleted at source${input.note ? ` — ${input.note}` : ""}`,
        );
        const before = await captureTransactionAuditSnapshot(db, document.id, input.orgId);
        if (!before)
          throw new SourceDeletionResolutionError(
            "document disappeared while resolving deletion",
          );
        await db.execute(sql`
          update documents
             set status = 'voided', voided_at = now(), open_balance = null,
                 voided_by = ${input.actorId}, void_reason = ${voidReason},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id} and org_id = ${input.orgId}`);
        const after = await captureTransactionAuditSnapshot(db, document.id, input.orgId);
        if (!after)
          throw new SourceDeletionResolutionError(
            "document disappeared after resolving deletion",
          );
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
      }
    }

    const previousResolution = (await db.execute<{ row: Record<string, unknown> }>(sql`
      select to_jsonb(r) as row
        from source_deletion_resolutions r
       where r.org_id = ${input.orgId}
         and r.connection_id = ${input.connectionId}
         and r.source_ref = ${input.sourceRef}
       for update
    `));
    const resolution = (await db.execute<{ id: string }>(sql`
      insert into source_deletion_resolutions
        (org_id, connection_id, source_ref, document_id, action, note, resolved_by,
         created_by, updated_by, resolved_at)
      values (${input.orgId}, ${input.connectionId}, ${input.sourceRef}, ${document?.id ?? null},
              ${input.action}, ${input.note ?? null}, ${input.actorId}, ${input.actorId}, ${input.actorId}, now())
      on conflict (connection_id, source_ref) do update set
        document_id = excluded.document_id, action = excluded.action, note = excluded.note,
        resolved_by = excluded.resolved_by, resolved_at = now(), updated_by = excluded.updated_by,
        updated_at = now()
      where source_deletion_resolutions.org_id = ${input.orgId}
      returning id`));
    const resolutionId = resolution.rows[0]?.id;
    if (!resolutionId) {
      throw new SourceDeletionResolutionError(
        "source-deletion resolution was not persisted",
      );
    }
    const currentResolution = (await db.execute<{ row: Record<string, unknown> }>(sql`
      select to_jsonb(r) as row
        from source_deletion_resolutions r
       where r.id = ${resolutionId} and r.org_id = ${input.orgId}
    `));
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${input.orgId},
        'source_deletion_resolutions',
        ${resolutionId},
        ${previousResolution.rows[0] ? "update" : "insert"},
        ${JSON.stringify({
          source: "source-deletion-resolution",
          reason: `${source}:${input.sourceRef} deleted at source`,
          before: previousResolution.rows[0]?.row ?? null,
          after: currentResolution.rows[0]?.row ?? null,
        })}::jsonb,
        ${input.actorId},
        'source-deletion-resolution'
      )`);
    return {
      documentId: document?.id ?? null,
      action: input.action,
      reversalEntryId,
    };
  });
}
