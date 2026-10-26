import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrg, type SqlExecutor } from "../platform/db.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import {
  reversalJournalLines,
  type ReversalSourceJournalLine,
} from "../records/reversal-journal-lines.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { assertPeriodModulesOpen, closeModuleForDocument } from "../periods/period-policy.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";

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

type ImportedSourceDocument = {
  id: string;
  kind: string;
  status: string;
  posted_entry_id: string | null;
};

/**
 * A document belongs to the connection that stamped it. A document with no
 * stamp (imported before connections recorded provenance) or with the stamp
 * of a connection that no longer exists belongs to the organization's one
 * live connection for the source, exactly as the sync run adopts it. While a
 * second live connection of the same source exists, such a document belongs
 * to neither, so one connection can never correct another's import.
 */
function ownedByConnection(input: { orgId: string; connectionId: string }) {
  return sql`(
    documents.custom->>'connectionId' = ${input.connectionId}
    or (
      not exists (
        select 1 from connections stamped
         where stamped.org_id = ${input.orgId}
           and stamped.id::text = documents.custom->>'connectionId'
      )
      and not exists (
        select 1
          from connections self
          join connections sibling
            on sibling.org_id = self.org_id
           and sibling.source = self.source
           and sibling.id <> self.id
         where self.id = ${input.connectionId} and self.org_id = ${input.orgId}
      )
    )
  )`;
}

async function lockImportedSourceDocument(
  tx: SqlExecutor,
  input: {
    orgId: string;
    connectionId: string;
    refKey: string;
    sourceRef: string;
  },
): Promise<ImportedSourceDocument | null> {
  const documentResult = await tx.execute<ImportedSourceDocument>(
    sql`
    select id, kind, status, posted_entry_id
      from documents
     where org_id = ${input.orgId}
       and custom->>${input.refKey} = ${input.sourceRef}
       and ${ownedByConnection(input)}
     limit 2
     for update`,
    "objects",
  );
  if (documentResult.length > 1) {
    throw new SourceDeletionResolutionError(
      "multiple documents owned by this connection share the source reference",
    );
  }
  return documentResult[0] ?? null;
}

async function findImportedSourceDocument(
  tx: SqlExecutor,
  input: {
    orgId: string;
    connectionId: string;
    refKey: string;
    sourceRef: string;
  },
): Promise<ImportedSourceDocument | null> {
  const documentResult = await tx.execute<ImportedSourceDocument>(
    sql`
    select id, kind, status, posted_entry_id
      from documents
     where org_id = ${input.orgId}
       and custom->>${input.refKey} = ${input.sourceRef}
       and ${ownedByConnection(input)}
     limit 2`,
    "objects",
  );
  if (documentResult.length > 1) {
    throw new SourceDeletionResolutionError(
      "multiple documents owned by this connection share the source reference",
    );
  }
  return documentResult[0] ?? null;
}

async function sourceApplicationLineIds(
  tx: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<string[]> {
  const endpoints = await tx.execute<{ id: string }>(
    sql`
    select endpoint.id
      from journal_lines endpoint
     where endpoint.org_id = ${orgId}
       and (
         endpoint.entry_id = ${entryId}
         or endpoint.id in (
           select application.from_line_id
             from applications application
            where application.org_id = ${orgId}
              and application.unapplied_at is null
              and application.to_line_id in (
                select id from journal_lines where org_id = ${orgId} and entry_id = ${entryId}
              )
           union
           select application.to_line_id
             from applications application
            where application.org_id = ${orgId}
              and application.unapplied_at is null
              and application.from_line_id in (
                select id from journal_lines where org_id = ${orgId} and entry_id = ${entryId}
              )
         )
       )`,
    "objects",
  );
  return endpoints.map((row) => row.id);
}

async function sourceApplicationFxEntryIds(
  tx: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(
    sql`
    select distinct application.fx_gain_loss_entry_id as id
      from applications application
      join journal_lines endpoint
        on endpoint.org_id = application.org_id
       and endpoint.id in (application.from_line_id, application.to_line_id)
     where application.org_id = ${orgId}
       and application.unapplied_at is null
       and application.fx_gain_loss_entry_id is not null
       and endpoint.entry_id = ${entryId}
     order by application.fx_gain_loss_entry_id`,
    "objects",
  );
  return result.map((row) => row.id);
}

/** Lock the complete application graph before the source document is changed.
 * The shared order is documents, journal entries, then lines, each by id.
 * Loading ids is only discovery; all lifecycle/application decisions happen
 * after the returned rows are held by this transaction. */
async function lockImportedSourceApplicationEvidence(
  tx: SqlExecutor,
  input: {
    orgId: string;
    connectionId: string;
    refKey: string;
    sourceRef: string;
  },
): Promise<ImportedSourceDocument | null> {
  const candidate = await findImportedSourceDocument(tx, input);
  if (!candidate) return null;

  const lineIds: string[] = [];
  if (candidate.posted_entry_id) {
    lineIds.push(...(await sourceApplicationLineIds(tx, input.orgId, candidate.posted_entry_id)));
  }
  const fxEntryIds = candidate.posted_entry_id
    ? await sourceApplicationFxEntryIds(tx, input.orgId, candidate.posted_entry_id)
    : [];
  const locks = await lockApplicationEvidence(
    tx,
    input.orgId,
    lineIds,
    [candidate.id],
    [...(candidate.posted_entry_id ? [candidate.posted_entry_id] : []), ...fxEntryIds],
  );

  if (candidate.posted_entry_id) {
    const currentLineIds = await sourceApplicationLineIds(
      tx,
      input.orgId,
      candidate.posted_entry_id,
    );
    const currentFxEntryIds = await sourceApplicationFxEntryIds(
      tx,
      input.orgId,
      candidate.posted_entry_id,
    );
    if (
      currentLineIds.some((id) => !locks.lineIds.includes(id)) ||
      currentFxEntryIds.some((id) => !locks.entryIds.includes(id))
    ) {
      throw new SourceDeletionResolutionError(
        "application endpoints changed while preparing the correction; retry the source deletion",
      );
    }
  }

  const locked = await lockImportedSourceDocument(tx, input);
  if (
    !locked ||
    locked.id !== candidate.id ||
    locked.posted_entry_id !== candidate.posted_entry_id
  ) {
    throw new SourceDeletionResolutionError(
      "the imported document's application endpoints changed while preparing the correction; retry",
    );
  }
  return locked;
}

async function reverseSourceApplicationFxEntries(
  tx: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    sourceEntryId: string;
    sourceKind: string;
    sourceRef: string;
    actorId: string | null;
  },
): Promise<void> {
  const applications = await tx.execute<{ id: string; fx_entry_id: string }>(
    sql`
    select application.id, application.fx_gain_loss_entry_id as fx_entry_id
      from applications application
     where application.org_id = ${input.orgId}
       and application.unapplied_at is null
       and application.fx_gain_loss_entry_id is not null
       and (
         application.from_line_id in (
           select id from journal_lines where org_id = ${input.orgId} and entry_id = ${input.sourceEntryId}
         )
         or application.to_line_id in (
           select id from journal_lines where org_id = ${input.orgId} and entry_id = ${input.sourceEntryId}
         )
       )`,
    "objects",
  );
  const fxEntryIds = [...new Set(applications.map((row) => row.fx_entry_id))].sort();
  for (const fxEntryId of fxEntryIds) {
    const shared = await tx.execute(
      sql`
      select id from applications
       where org_id = ${input.orgId} and unapplied_at is null
         and fx_gain_loss_entry_id = ${fxEntryId}
         and id not in (${sql.join(
           applications.filter((row) => row.fx_entry_id === fxEntryId).map((row) => sql`${row.id}`),
           sql`, `,
         )})
       limit 1`,
      "objects",
    );
    if (shared.length) {
      throw new SourceDeletionResolutionError(
        "the source settlement's foreign-exchange journal is shared with another active application; reconcile that allocation before deleting the source",
      );
    }
    const fxEntry = (
      await tx.execute<{
        id: string;
        status: string;
        origin: string;
        periodId: string;
        bookId: string;
        subsidiaryId: string;
        entryNumber: string;
        postingDate: string;
      }>(
        sql`
      select id, status, origin, period_id as "periodId", book_id as "bookId",
             subsidiary_id as "subsidiaryId", entry_number as "entryNumber",
             posting_date::text as "postingDate"
        from journal_entries
       where id = ${fxEntryId} and org_id = ${input.orgId}
       for update`,
        "objects",
      )
    )[0];
    if (!fxEntry || fxEntry.status !== "posted" || fxEntry.origin !== "fx_settlement") {
      throw new SourceDeletionResolutionError(
        "the source settlement's foreign-exchange journal is missing or no longer posted",
      );
    }
    const lines = await tx.execute<ReversalSourceJournalLine>(
      sql`
      select line_number as "lineNumber", account_id as "accountId", subsidiary_id as "subsidiaryId",
             amount::text as amount, currency, txn_amount::text as "txnAmount", fx_rate::text as "fxRate",
             party_id as "partyId", department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId", equipment_unit_id as "equipmentUnitId",
             extra_dims as "extraDims", payment_card_id as "paymentCardId", tax_code_id as "taxCodeId",
             memo, quantity::text as quantity, unit, custom, eliminate,
             is_currency_adjustment as "isCurrencyAdjustment",
             contributor_kind as "contributorKind", contributor_ref as "contributorRef"
        from journal_lines
       where org_id = ${input.orgId} and entry_id = ${fxEntry.id}
       order by line_number`,
      "objects",
    );
    if (lines.length === 0) {
      throw new SourceDeletionResolutionError(
        "the source settlement's foreign-exchange journal has no lines",
      );
    }
    await assertPeriodModulesOpen(tx, {
      orgId: input.orgId,
      periodId: fxEntry.periodId,
      bookId: fxEntry.bookId,
      subsidiaryIds: lines.map((line) => line.subsidiaryId),
      modules: [closeModuleForDocument(input.sourceKind)],
    });
    const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
    const reversal = await postEntry(tx, {
      orgId: input.orgId,
      bookId: fxEntry.bookId,
      subsidiaryId: fxEntry.subsidiaryId,
      entryNumber: await nextFreeEntryNumber(
        tx,
        input.orgId,
        `${fxEntry.entryNumber}-SOURCE-DELETE`,
      ),
      postingDate: fxEntry.postingDate,
      periodId: fxEntry.periodId,
      memo: `Source deletion ${input.sourceRef} settlement FX reversal`,
      sourceDocumentId: input.documentId,
      origin: fxEntry.origin,
      reversesEntryId: fxEntry.id,
      actorId: input.actorId,
      closeModules: [closeModuleForDocument(input.sourceKind)],
      allowImportedLocks: true,
      allowInactiveAccounts: true,
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
        eliminate: line.eliminate,
        isCurrencyAdjustment: line.isCurrencyAdjustment,
      })),
    });
    await markEntryReversed(tx, {
      orgId: input.orgId,
      entryId: fxEntry.id,
      actorId: input.actorId,
    });
    if (!reversal.entryId)
      throw new SourceDeletionResolutionError("the source settlement FX reversal was not posted");
  }
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
  connectionId: string;
}): Promise<{ documentId: string | null; deleted: boolean }> {
  return withOrg(input.orgId, async () => {
    const refKey = SOURCE_REF_KEYS[input.source];
    if (!refKey)
      throw new SourceDeletionResolutionError(
        `source deletion mirroring is unsupported for ${input.source}`,
      );
    return db.transaction(async (tx) => {
      const document = await lockImportedSourceApplicationEvidence(tx, {
        orgId: input.orgId,
        connectionId: input.connectionId,
        refKey,
        sourceRef: input.sourceRef,
      });
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
      const voidReason = boundedVoidReason(`Source deleted: ${input.source}:${input.sourceRef}`);
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
        .where(
          and(
            eq(schema.journalEntries.id, document.posted_entry_id),
            eq(schema.journalEntries.orgId, input.orgId),
          ),
        );
      if (!entry || entry.status !== "posted") {
        throw new SourceDeletionResolutionError(
          "source-deleted document's posted journal is missing or not posted",
        );
      }
      const lines = await tx
        .select()
        .from(schema.journalLines)
        .where(
          and(
            eq(schema.journalLines.entryId, entry.id),
            eq(schema.journalLines.orgId, input.orgId),
          ),
        );
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
      await reverseSourceApplicationFxEntries(tx, {
        orgId: input.orgId,
        documentId: document.id,
        sourceEntryId: entry.id,
        sourceKind: document.kind,
        sourceRef: `${input.source}:${input.sourceRef}`,
        actorId: null,
      });
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

      // The reversal posts through the ONE ledger API; the deleted entry is
      // then marked reversed — never edited or removed.
      const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
      const postedReversal = await postEntry(tx, {
        orgId: input.orgId,
        bookId: entry.bookId,
        subsidiaryId: entry.subsidiaryId,
        entryNumber: await nextFreeEntryNumber(
          tx,
          input.orgId,
          `${entry.entryNumber}-SOURCE-DELETE`,
        ),
        postingDate: entry.postingDate,
        periodId: entry.periodId,
        memo: `Source deletion ${input.source}:${input.sourceRef}`,
        sourceDocumentId: document.id,
        origin: entry.origin,
        reversesEntryId: entry.id,
        actorId: null,
        closeModules: [closeModuleForDocument(document.kind)],
        allowImportedLocks: true,
        allowInactiveAccounts: true,
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
          eliminate: line.eliminate,
          isCurrencyAdjustment: line.isCurrencyAdjustment,
        })),
      });
      const reversal = { id: postedReversal.entryId };
      await markEntryReversed(tx, { orgId: input.orgId, entryId: entry.id, actorId: null });
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
  return withOrg(input.orgId, async () =>
    db.transaction(async (tx) => {
      const connection = await tx.execute<{ source: string; actor_valid: boolean }>(
        sql`
      select c.source,
             exists (
               select 1 from users u
                where u.id = ${input.actorId} and u.org_id = ${input.orgId}
                  and u.is_active
             ) as actor_valid
        from connections c
       where c.id = ${input.connectionId} and c.org_id = ${input.orgId}
      for update`,
        "objects",
      );
      const source = connection[0]?.source;
      if (!source) throw new SourceDeletionResolutionError("connection not found");
      if (!connection[0]!.actor_valid) {
        throw new SourceDeletionResolutionError(
          "resolution actor is not an active organization user",
        );
      }
      const refKey = SOURCE_REF_KEYS[source];
      if (!refKey)
        throw new SourceDeletionResolutionError(
          `source deletion resolution is unsupported for ${source}`,
        );

      const document = await lockImportedSourceApplicationEvidence(tx, {
        orgId: input.orgId,
        connectionId: input.connectionId,
        refKey,
        sourceRef: input.sourceRef,
      });
      let reversalEntryId: string | null = null;

      if (input.action === "void") {
        if (!document)
          throw new SourceDeletionResolutionError("the imported document no longer exists");
        if (document.status !== "voided" && document.posted_entry_id) {
          const voidReason = boundedVoidReason(
            `${source}:${input.sourceRef} deleted at source${input.note ? ` — ${input.note}` : ""}`,
          );
          const applications = await tx.execute(
            sql`
          select 1
            from applications a
           where a.org_id = ${input.orgId} and a.unapplied_at is null and (
             exists (select 1 from journal_lines jl where jl.id = a.from_line_id and jl.org_id = a.org_id and jl.entry_id = ${document.posted_entry_id})
             or exists (select 1 from journal_lines jl where jl.id = a.to_line_id and jl.org_id = a.org_id and jl.entry_id = ${document.posted_entry_id})
           ) limit 1`,
            "objects",
          );
          if (applications.length > 0) {
            throw new SourceDeletionResolutionError(
              "the source-deleted document has active payment applications; reverse or unapply them before voiding",
            );
          }

          const [entry] = await tx
            .select()
            .from(schema.journalEntries)
            .where(
              and(
                eq(schema.journalEntries.id, document.posted_entry_id),
                eq(schema.journalEntries.orgId, input.orgId),
              ),
            );
          if (!entry || entry.status !== "posted") {
            throw new SourceDeletionResolutionError(
              "the document's posted journal is missing or already reversed",
            );
          }
          const lines = await tx
            .select()
            .from(schema.journalLines)
            .where(
              and(
                eq(schema.journalLines.entryId, entry.id),
                eq(schema.journalLines.orgId, input.orgId),
              ),
            );
          // Preserve the source transaction's accounting-period allocation.
          // If that period is controller-closed, the correction must stop for a
          // controlled reopen or explicit adjusting-entry decision; silently
          // moving it into today's period would make historical parity false.
          const postingDate = entry.postingDate;
          await assertPeriodModulesOpen(tx, {
            orgId: input.orgId,
            periodId: entry.periodId,
            bookId: entry.bookId,
            subsidiaryIds: lines.map((line) => line.subsidiaryId),
            modules: [closeModuleForDocument(document.kind)],
          });

          const before = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
          if (!before)
            throw new SourceDeletionResolutionError(
              "document disappeared while resolving deletion",
            );
          // The reversal posts through the ONE ledger API; the deleted entry
          // is then marked reversed — never edited or removed.
          const mirror = reversalJournalLines(lines, { entryId: "", orgId: input.orgId });
          const postedReversal = await postEntry(tx, {
            orgId: input.orgId,
            bookId: entry.bookId,
            subsidiaryId: entry.subsidiaryId,
            entryNumber: await nextFreeEntryNumber(
              tx,
              input.orgId,
              `${entry.entryNumber}-SOURCE-DELETE`,
            ),
            postingDate,
            periodId: entry.periodId,
            memo: `Source deletion ${source}:${input.sourceRef}${input.note ? ` — ${input.note}` : ""}`,
            sourceDocumentId: document.id,
            origin: entry.origin,
            reversesEntryId: entry.id,
            actorId: input.actorId,
            closeModules: [closeModuleForDocument(document.kind)],
            allowImportedLocks: true,
            allowInactiveAccounts: true,
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
              eliminate: line.eliminate,
              isCurrencyAdjustment: line.isCurrencyAdjustment,
            })),
          });
          const reversal = { id: postedReversal.entryId };
          await markEntryReversed(tx, {
            orgId: input.orgId,
            entryId: entry.id,
            actorId: input.actorId,
          });
          await tx.execute(sql`
          update documents
             set status = 'voided', voided_at = now(),
                 voided_by = ${input.actorId}, void_reason = ${voidReason},
                 reversal_entry_id = ${reversal.id},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id} and org_id = ${input.orgId}`);
          await tx.execute(sql`select recompute_document_open_balance(${document.id})`);
          const after = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
          if (!after)
            throw new SourceDeletionResolutionError(
              "document disappeared after resolving deletion",
            );
          await recordTransactionAudit(tx, {
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
          const before = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
          if (!before)
            throw new SourceDeletionResolutionError(
              "document disappeared while resolving deletion",
            );
          await tx.execute(sql`
          update documents
             set status = 'voided', voided_at = now(), open_balance = null,
                 voided_by = ${input.actorId}, void_reason = ${voidReason},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${document.id} and org_id = ${input.orgId}`);
          const after = await captureTransactionAuditSnapshot(tx, document.id, input.orgId);
          if (!after)
            throw new SourceDeletionResolutionError(
              "document disappeared after resolving deletion",
            );
          await recordTransactionAudit(tx, {
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

      const previousResolution = await tx.execute<{ row: Record<string, unknown> }>(
        sql`
      select to_jsonb(r) as row
        from source_deletion_resolutions r
       where r.org_id = ${input.orgId}
         and r.connection_id = ${input.connectionId}
         and r.source_ref = ${input.sourceRef}
       for update
    `,
        "objects",
      );
      const resolution = await tx.execute<{ id: string }>(
        sql`
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
      returning id`,
        "objects",
      );
      const resolutionId = resolution[0]?.id;
      if (!resolutionId) {
        throw new SourceDeletionResolutionError("source-deletion resolution was not persisted");
      }
      const currentResolution = await tx.execute<{ row: Record<string, unknown> }>(
        sql`
      select to_jsonb(r) as row
        from source_deletion_resolutions r
       where r.id = ${resolutionId} and r.org_id = ${input.orgId}
    `,
        "objects",
      );
      await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${input.orgId},
        'source_deletion_resolutions',
        ${resolutionId},
        ${previousResolution[0] ? "update" : "insert"},
        ${JSON.stringify({
          source: "source-deletion-resolution",
          reason: `${source}:${input.sourceRef} deleted at source`,
          before: previousResolution[0]?.row ?? null,
          after: currentResolution[0]?.row ?? null,
        })}::jsonb,
        ${input.actorId},
        'source-deletion-resolution'
      )`);
      return {
        documentId: document?.id ?? null,
        action: input.action,
        reversalEntryId,
      };
    }),
  );
}
