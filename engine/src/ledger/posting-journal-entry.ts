import { sql } from "drizzle-orm";
import {
  flipEntryToPosted,
  insertDraftEntry,
  type DraftEntryHeader,
} from "../journal/kernel-entry.ts";
import { insertEntryLines, type JournalLineWrite } from "../journal/kernel-lines.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { db, withOrgContext, withTransactionSavepoint } from "../platform/db.ts";
import { allocateEntryNumber, nextFreeEntryNumber } from "../records/entry-number.ts";
import type { prepareDocumentPosting } from "./posting-prepare.ts";

/**
 * A document posting's journal entries, written through the journal kernel: the primary entry
 * under the document's own number and one allocation entry per secondary book. The caller owns
 * the transaction and has taken every lock and guard.
 */

export type PostingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PreparedPosting = Awaited<ReturnType<typeof prepareDocumentPosting>>;
/** A leg after subsidiary application: entity, currency and rate resolved. */
type AppliedLine = PreparedPosting["subApplied"]["lines"][number];

interface LineStamp {
  contributorKind?: string | null;
  contributorRef?: string | null;
  custom?: Record<string, unknown>;
}

/** An entry and its line ids in line-number order. */
export interface DocumentEntry {
  entryId: string;
  lineIds: string[];
}

/** One mapping from an applied leg to its journal line, for the primary and secondary books. */
function documentJournalLine(
  line: AppliedLine,
  lineNumber: number,
  stamp: LineStamp,
): JournalLineWrite {
  return {
    ...line,
    lineNumber,
    custom: stamp.custom ?? {},
    contributorKind: stamp.contributorKind ?? null,
    contributorRef: stamp.contributorRef ?? null,
  };
}

/** Script contributions post account, entity, money and dimensions only. */
function scriptContributionLine(line: AppliedLine): AppliedLine {
  return {
    ...line,
    partyId: null,
    equipmentUnitId: null,
    paymentCardId: null,
    taxCodeId: null,
    dueDate: null,
    isOpenItem: false,
    quantity: null,
    unit: null,
    eliminate: false,
    isCurrencyAdjustment: false,
  };
}

function primaryOrigin({ effectiveDoc, subApplied, scriptLines }: PreparedPosting): string {
  if (effectiveDoc.journalMode === "currency_adjustment") return "currency_adjustment";
  const spansEntities =
    subApplied.multi || scriptLines.some((line) => line.subsidiaryId !== subApplied.docSubId);
  return spansEntities ? "intercompany" : "document";
}

/**
 * Writes the primary entry: kernel lines 1..N with rule contributions after them in rule order,
 * then script contributions. The header is the transaction's first write, so a concurrent post of
 * the same document blocks on journal_entries_org_number and is diagnosed as already posted.
 */
export async function writePrimaryEntry(
  tx: PostingTx,
  prepared: PreparedPosting,
  scope: { bookId: string; periodId: string },
): Promise<DocumentEntry> {
  const { doc, effectiveDoc, subApplied, scriptLines, unionLines, postingDate } = prepared;
  // A number another document already holds is qualified by kind; the same document keeps its own.
  const entryNumber = await allocateEntryNumber(
    tx,
    doc.orgId,
    doc.id,
    `${effectiveDoc.documentNumber}`,
    doc.kind,
  );
  const entryId = await insertNumberedDraft(tx, prepared, {
    orgId: doc.orgId,
    bookId: scope.bookId,
    subsidiaryId: subApplied.docSubId,
    entryNumber,
    postingDate,
    periodId: scope.periodId,
    memo: effectiveDoc.memo,
    origin: primaryOrigin(prepared),
    sourceDocumentId: doc.id,
    custom: null,
    actorId: null,
  });
  const lines = [
    // Rule contributions ride at unionLines[kernelLines.length + j]; kernel lines carry none.
    ...subApplied.lines.map((line, i) => {
      const source = unionLines[i];
      return documentJournalLine(line, i + 1, {
        custom: source?.amortizationSourceLineId
          ? { amortizationSourceLineId: source.amortizationSourceLineId }
          : {},
        contributorKind: source?.contributorKind,
        contributorRef: source?.contributorRef,
      });
    }),
    ...scriptLines.map((line, i) =>
      documentJournalLine(scriptContributionLine(line), subApplied.lines.length + i + 1, {
        contributorKind: line.contributorKind,
        contributorRef: line.contributorRef,
      }),
    ),
  ];
  return await writeLinesAndPost(tx, doc.orgId, entryId, lines, {
    lines: "The journal did not retain every posting line; nothing may be reported posted.",
    flip: "The journal did not make its required draft-to-posted transition; nothing may be reported posted.",
  });
}

/** One origin='allocation' entry carrying a secondary book's contributed lines. */
export async function writeSecondaryBookEntry(
  tx: PostingTx,
  prepared: PreparedPosting,
  scope: { book: { id: string; code: string }; periodId: string },
  lines: readonly AppliedLine[],
  contributors: readonly { contributorKind?: string | null; contributorRef?: string | null }[],
): Promise<DocumentEntry> {
  const { doc, effectiveDoc, subApplied, postingDate } = prepared;
  const { book } = scope;
  const entryNumber = await nextFreeEntryNumber(
    tx,
    doc.orgId,
    `${effectiveDoc.documentNumber}-ALLOC-${book.code}`,
  );
  const entryId = await insertDraftEntry(
    tx,
    {
      orgId: doc.orgId,
      bookId: book.id,
      subsidiaryId: subApplied.docSubId,
      entryNumber,
      postingDate,
      periodId: scope.periodId,
      memo: `Allocations for ${effectiveDoc.documentNumber} (${book.code})`,
      origin: "allocation",
      sourceDocumentId: doc.id,
      custom: null,
      actorId: null,
    },
    () => new PostingError("The secondary-book journal was not created."),
  );
  const journalLines = lines.map((line, i) =>
    documentJournalLine(line, i + 1, {
      contributorKind: contributors[i]?.contributorKind,
      contributorRef: contributors[i]?.contributorRef,
    }),
  );
  return await writeLinesAndPost(tx, doc.orgId, entryId, journalLines, {
    lines: "The secondary-book journal did not retain every posting line.",
    flip: "The secondary-book journal did not make its required draft-to-posted transition.",
  });
}

async function writeLinesAndPost(
  tx: PostingTx,
  orgId: string,
  entryId: string,
  lines: readonly JournalLineWrite[],
  refusals: { lines: string; flip: string },
): Promise<DocumentEntry> {
  const inserted = await insertEntryLines(tx, { orgId, entryId }, lines, {
    refusal: () => new PostingError(refusals.lines),
  });
  await flipEntryToPosted(
    tx,
    { orgId, entryId, actorId: null },
    () => new PostingError(refusals.flip),
  );
  return { entryId, lineIds: inserted.map((row) => row.id) };
}

/**
 * Inserts the header in a savepoint so a unique violation on the entry number leaves the caller's
 * transaction usable for the claimant diagnosis, then refuses by name instead of a driver error.
 */
async function insertNumberedDraft(
  tx: PostingTx,
  { doc }: PreparedPosting,
  header: DraftEntryHeader,
): Promise<string> {
  try {
    return await withTransactionSavepoint(tx, () =>
      insertDraftEntry(
        tx,
        header,
        () =>
          new PostingError("The journal entry was not created; nothing may be reported posted."),
      ),
    );
  } catch (error) {
    const code =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code !== "23505") throw error;
    // The repeatable-read snapshot can predate the winner, so a separate tenant-scoped read
    // diagnoses the committed claimant: this document's own posting, or a different document.
    const claimant = await withOrgContext(doc.orgId, () =>
      db.execute<{ kind: string; document_number: string; source_document_id: string | null }>(
        sql`
          select d.kind, d.document_number, e.source_document_id
            from journal_entries e
            left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
           where e.org_id = ${doc.orgId}
             and e.entry_number = ${header.entryNumber}
           limit 1`,
        "objects",
      ),
    );
    const other = claimant[0];
    if (other && other.source_document_id !== doc.id) {
      throw new PostingError(
        `journal entry number "${header.entryNumber}" is already used by ${other.kind ?? "another document"} ${other.document_number ?? ""}`,
      );
    }
    throw new PostingError(`document ${doc.documentNumber} was already posted or voided`);
  }
}
