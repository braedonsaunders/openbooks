import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { isUuid } from "../platform/uuid.ts";
import { PspSettlementError } from "./psp-settlement-core.ts";
import type { SettlementLineKind } from "./psp-settlement-core.ts";

/**
 * Payout-to-order reconciliation. A settlement line is matchable when its
 * kind can name a native document (a charge settles a receipt, a refund
 * reverses one, a dispute claims one); fees, adjustments, transfers and FX
 * legs are provider economics, never order evidence, so they stay out of the
 * unmatched queue by construction.
 */
export const MATCHABLE_SETTLEMENT_LINE_KINDS: ReadonlySet<SettlementLineKind> = new Set([
  "charge",
  "refund",
  "dispute",
  "dispute_reversal",
]);

export function isMatchableSettlementLineKind(kind: string): boolean {
  return (MATCHABLE_SETTLEMENT_LINE_KINDS as ReadonlySet<string>).has(kind);
}

/** Fail closed when the banking surface is off: hidden means refused. */
export async function requireBankingFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "banking"))) {
    throw new PspSettlementError(
      "Payout reconciliation is disabled; enable Banking in Company Settings → Features before matching payout lines",
    );
  }
}

export type SettlementLineLock = {
  id: string;
  kind: string;
  document_id: string | null;
  amount: string;
  currency: string | null;
};

export function auditSettlementLine(
  orgId: string,
  lineId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string | null,
): Promise<unknown> {
  return db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'psp_settlement_lines', ${lineId}, ${action},
            ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

/**
 * Legal-entity ownership for a settlement link. An absent subsidiary
 * resolves to the org root — the same contract payout posting applies to
 * every other document — so single-entity history links freely while a
 * receipt anchored to another entity never attaches to this payout. The
 * suggestion queue shares this predicate with the link writer, so approval
 * can only propose what the writer accepts.
 */
export async function settlementLineDocumentInEntity(
  orgId: string,
  batchSubsidiaryId: string | null,
  documentSubsidiaryId: string | null,
): Promise<boolean> {
  if (batchSubsidiaryId !== null && documentSubsidiaryId !== null) {
    return batchSubsidiaryId === documentSubsidiaryId;
  }
  const ctx = await loadSubsidiaryContext(db, orgId);
  return (batchSubsidiaryId ?? ctx.rootId) === (documentSubsidiaryId ?? ctx.rootId);
}

/**
 * Link one settlement line to its native document. The link is matching
 * evidence, never posted history: the journal stays untouched, and a later
 * reimport of the same provider reference converges onto the stored link
 * instead of conflicting. The document must be a posted record of this
 * organization in the payout's legal entity — linking an unposted, foreign
 * or another entity's record would pretend the payout settled something the
 * ledger never booked for this entity.
 */
export async function setSettlementLineDocument(
  orgId: string,
  batchId: string,
  lineId: string,
  documentId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{ lineId: string; documentId: string }> {
  if (!isUuid(documentId)) {
    throw new PspSettlementError(
      "a settlement line links only to a native document; choose the posted receipt, refund or payment this line settles",
    );
  }
  // An unknown scope writes nothing: the link is refused as missing, never
  // run as unrestricted.
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{ id: string; subsidiary_id: string | null; external_ref: string }>(
        sql`
      select id, subsidiary_id, external_ref from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    const line = (
      await db.execute<SettlementLineLock>(
        sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `,
        "objects",
      )
    )[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and link the line again`,
      );
    }
    // The candidate receipt is locked with the batch and line: a subsidiary
    // rehome committing between this read and the link update would otherwise
    // move the receipt under the scope and entity checks below.
    const doc = (
      await db.execute<{
        id: string;
        kind: string;
        status: string;
        document_number: string | null;
        subsidiary_id: string | null;
      }>(
        sql`
      select id, kind, status, document_number, subsidiary_id from documents
       where id = ${documentId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!doc) {
      throw new PspSettlementError(
        "the linked record does not belong to this organization; choose a posted sales document in this organization",
      );
    }
    // The receipt's entity is checked before its status or number can steer
    // anything: a caller outside its scope meets it as missing, and a
    // receipt outside the payout's entity is refused by name with the remedy.
    if (!subsidiaryScopeAllows(scope, doc.subsidiary_id)) throw new ScopeNotFoundError();
    if (!(await settlementLineDocumentInEntity(orgId, batch.subsidiary_id, doc.subsidiary_id))) {
      throw new PspSettlementError(
        `receipt ${doc.document_number ?? documentId} belongs to a different legal entity than payout ${batch.external_ref}; link a receipt posted in the payout's entity instead`,
      );
    }
    if (doc.status !== "posted") {
      throw new PspSettlementError(
        `document ${doc.document_number ?? documentId} is ${doc.status}, not posted; post it first, then link the settlement line`,
      );
    }
    const before = line.document_id;
    if (before === documentId) return { lineId, documentId };
    const updated = await db.execute<never>(sql`
      update psp_settlement_lines set document_id = ${documentId}, updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement line ${lineId} could not be linked; reload the payout and try again`,
      );
    }
    await auditSettlementLine(
      orgId,
      lineId,
      "link",
      { before: { documentId: before }, after: { documentId } },
      actorId,
    );
    return { lineId, documentId };
  });
}

/**
 * Clear a line's document link. Matching evidence comes off; the journal
 * stays exactly as posted.
 */
export async function clearSettlementLineDocument(
  orgId: string,
  batchId: string,
  lineId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string }> {
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{ id: string; subsidiary_id: string | null }>(
        sql`
      select id, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id))
      throw new ScopeNotFoundError();
    const line = (
      await db.execute<SettlementLineLock>(
        sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `,
        "objects",
      )
    )[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and try again`,
      );
    }
    if (line.document_id === null) return { lineId };
    const updated = await db.execute<never>(sql`
      update psp_settlement_lines set document_id = null, updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement line ${lineId} could not be unlinked; reload the payout and try again`,
      );
    }
    await auditSettlementLine(
      orgId,
      lineId,
      "unlink",
      { before: { documentId: line.document_id }, after: { documentId: null } },
      actorId,
    );
    return { lineId };
  });
}

/**
 * Mark a matchable line as recognised by a posted journal entry — the
 * bookkeeper booked the sale by journal instead of syncing the order, so
 * there is no sales document to link. The marker is matching evidence like
 * the document link: the journal stays untouched, and the close gate treats
 * a marked line as evidenced. The entry must be a posted record of this
 * organization in the payout's legal entity.
 */
export async function markSettlementLineJournal(
  orgId: string,
  batchId: string,
  lineId: string,
  journalEntryId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{ lineId: string; journalEntryId: string; journalEntryNumber: string }> {
  if (!isUuid(journalEntryId)) {
    throw new PspSettlementError(
      "a settlement line is recognised only by a posted journal entry; choose the journal entry that books this line's sale",
    );
  }
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{ id: string; subsidiary_id: string | null; external_ref: string }>(
        sql`
      select id, subsidiary_id, external_ref from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    const line = (
      await db.execute<SettlementLineLock & { meta: unknown }>(
        sql`
      select id, kind, document_id, amount::text, currency, meta from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `,
        "objects",
      )
    )[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and mark the line again`,
      );
    }
    if (!isMatchableSettlementLineKind(line.kind)) {
      throw new PspSettlementError(
        `settlement line ${lineId} is a ${line.kind} leg, not order evidence; journal recognition applies to charge, refund and dispute lines`,
      );
    }
    const entry = (
      await db.execute<{
        id: string;
        entry_number: string;
        status: string;
        subsidiary_id: string | null;
      }>(
        sql`
      select id, entry_number, status, subsidiary_id from journal_entries
       where id = ${journalEntryId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!entry) {
      throw new PspSettlementError(
        "the journal entry does not belong to this organization; choose a posted journal entry in this organization",
      );
    }
    if (!subsidiaryScopeAllows(scope, entry.subsidiary_id)) throw new ScopeNotFoundError();
    if (!(await settlementLineDocumentInEntity(orgId, batch.subsidiary_id, entry.subsidiary_id))) {
      throw new PspSettlementError(
        `journal entry ${entry.entry_number} belongs to a different legal entity than payout ${batch.external_ref}; choose a journal entry posted in the payout's entity instead`,
      );
    }
    if (entry.status !== "posted") {
      throw new PspSettlementError(
        `journal entry ${entry.entry_number} is ${entry.status}, not posted; post it first, then mark the settlement line`,
      );
    }
    const before =
      (line.meta as Record<string, unknown> | null)?.["recognizedByJournalEntry"] ?? null;
    const after = {
      id: journalEntryId,
      number: entry.entry_number,
      by: actorId,
      at: new Date().toISOString(),
    };
    if (before !== null && (before as Record<string, unknown>)["id"] === journalEntryId) {
      return { lineId, journalEntryId, journalEntryNumber: entry.entry_number };
    }
    const updated = await db.execute<never>(sql`
      update psp_settlement_lines
         set meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ recognizedByJournalEntry: after })}::jsonb,
             updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement line ${lineId} could not be marked; reload the payout and try again`,
      );
    }
    await auditSettlementLine(
      orgId,
      lineId,
      "mark-journal",
      { before: { recognizedByJournalEntry: before }, after: { recognizedByJournalEntry: after } },
      actorId,
    );
    return { lineId, journalEntryId, journalEntryNumber: entry.entry_number };
  });
}

/**
 * Clear a line's journal-recognition marker. Matching evidence comes off;
 * the journal stays exactly as posted.
 */
export async function clearSettlementLineJournal(
  orgId: string,
  batchId: string,
  lineId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string }> {
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{ id: string; subsidiary_id: string | null }>(
        sql`
      select id, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id))
      throw new ScopeNotFoundError();
    const line = (
      await db.execute<SettlementLineLock & { meta: unknown }>(
        sql`
      select id, kind, document_id, amount::text, currency, meta from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `,
        "objects",
      )
    )[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and try again`,
      );
    }
    const before =
      (line.meta as Record<string, unknown> | null)?.["recognizedByJournalEntry"] ?? null;
    if (before === null) return { lineId };
    const updated = await db.execute<never>(sql`
      update psp_settlement_lines
         set meta = coalesce(meta, '{}'::jsonb) - 'recognizedByJournalEntry',
             updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        `settlement line ${lineId} could not be unmarked; reload the payout and try again`,
      );
    }
    await auditSettlementLine(
      orgId,
      lineId,
      "unmark-journal",
      { before: { recognizedByJournalEntry: before }, after: { recognizedByJournalEntry: null } },
      actorId,
    );
    return { lineId };
  });
}

/**
 * Recognise a settlement batch's sales with one journal entry: every
 * matchable line without evidence is stamped with the same
 * recognizedByJournalEntry marker the per-line action writes, so a December
 * of 420 charge lines is evidenced in one audited operator action instead of
 * 420. Lines already carrying a document link or a marker are left alone and
 * reported, never overwritten — the batch action adopts nothing silently. A
 * void batch refuses: voided history is closed. The marker carries
 * `"via": "batch"` so the batch reversal below can lift exactly what the
 * batch action set, never a line the bookkeeper marked by hand.
 */
export async function markSettlementBatchJournal(
  orgId: string,
  batchId: string,
  journalEntryId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{
  batchId: string;
  journalEntryId: string;
  journalEntryNumber: string;
  marked: number;
  skippedLinked: number;
  skippedMarked: number;
}> {
  if (!isUuid(journalEntryId)) {
    throw new PspSettlementError(
      "a settlement batch is recognised only by a posted journal entry; choose the journal entry that books this payout's sales",
    );
  }
  const scope = allowedSubsidiaryIds;
  if (scope === undefined) throw new ScopeNotFoundError();
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (
      await db.execute<{
        id: string;
        status: string;
        subsidiary_id: string | null;
        external_ref: string;
      }>(
        sql`
      select id, status, subsidiary_id, external_ref from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(scope, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status === "void") {
      throw new PspSettlementError(
        `payout ${batch.external_ref} is void; voided history is closed — reverse the void instead of recognising it`,
      );
    }
    const entry = (
      await db.execute<{
        id: string;
        entry_number: string;
        status: string;
        subsidiary_id: string | null;
      }>(
        sql`
      select id, entry_number, status, subsidiary_id from journal_entries
       where id = ${journalEntryId} and org_id = ${orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!entry) {
      throw new PspSettlementError(
        "the journal entry does not belong to this organization; choose a posted journal entry in this organization",
      );
    }
    if (!subsidiaryScopeAllows(scope, entry.subsidiary_id)) throw new ScopeNotFoundError();
    if (!(await settlementLineDocumentInEntity(orgId, batch.subsidiary_id, entry.subsidiary_id))) {
      throw new PspSettlementError(
        `journal entry ${entry.entry_number} belongs to a different legal entity than payout ${batch.external_ref}; choose a journal entry posted in the payout's entity instead`,
      );
    }
    if (entry.status !== "posted") {
      throw new PspSettlementError(
        `journal entry ${entry.entry_number} is ${entry.status}, not posted; post it first, then recognise the settlement batch`,
      );
    }
    const matchableList = `{"${[...MATCHABLE_SETTLEMENT_LINE_KINDS].join('","')}"}`;
    const lines = await db.execute<{ id: string; document_id: string | null; meta: unknown }>(
      sql`
      select id, document_id, meta from psp_settlement_lines
       where org_id = ${orgId} and batch_id = ${batchId}
         and kind = any(${matchableList}::text[])
       order by line_number for update
    `,
      "objects",
    );
    const after = {
      id: journalEntryId,
      number: entry.entry_number,
      by: actorId,
      at: new Date().toISOString(),
      via: "batch",
    };
    let marked = 0;
    let skippedLinked = 0;
    let skippedMarked = 0;
    for (const line of lines) {
      if (line.document_id !== null) {
        skippedLinked += 1;
        continue;
      }
      if ((line.meta as Record<string, unknown> | null)?.["recognizedByJournalEntry"] != null) {
        skippedMarked += 1;
        continue;
      }
      const updated = await db.execute<never>(sql`
        update psp_settlement_lines
           set meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ recognizedByJournalEntry: after })}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId} and batch_id = ${batchId}
      `);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new PspSettlementError(
          `settlement line ${line.id} could not be marked; reload the payout and try again`,
        );
      }
      await auditSettlementLine(
        orgId,
        line.id,
        "mark-journal",
        { before: { recognizedByJournalEntry: null }, after: { recognizedByJournalEntry: after } },
        actorId,
      );
      marked += 1;
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_settlement_batches', ${batchId}, 'mark-batch-journal',
              ${JSON.stringify({
                journalEntryId,
                journalEntryNumber: entry.entry_number,
                marked,
                skippedLinked,
                skippedMarked,
              })}::jsonb, ${actorId})
    `);
    return {
      batchId,
      journalEntryId,
      journalEntryNumber: entry.entry_number,
      marked,
      skippedLinked,
      skippedMarked,
    };
  });
}
