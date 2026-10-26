import { isUuid } from "../platform/uuid.ts";
import { DocumentDefaultsError, resolveTermsDueDate } from "./document-defaults.ts";
import {
  captureDocumentPaymentTerms,
  PaymentTermsEvidenceError,
} from "./payment-terms-snapshot.ts";
import { assertEntityPostingDate } from "../organization/accounting-preferences.ts";
import { validateJournalInstructions } from "./journal-instructions.ts";
import {
  assertWithholdingRemittanceCurrent,
  ContractorWithholdingError,
} from "../contractor-withholding/service.ts";
import { assertWithholdingDepositCurrent } from "../contractor-withholding/deposits.ts";
import { PlaceOfSupplyError } from "../tax/place-of-supply.ts";
import { assertCanadianGoodsTaxEvidence } from "../tax/goods-selection.ts";
import { assertCrossBorderSupplyEvidence } from "../tax/cross-border-posting.ts";
import { CrossBorderTaxError } from "../tax/cross-border-place-of-supply.ts";
import { and, eq, sql } from "drizzle-orm";
import { inDbTransaction, schema } from "../platform/db.ts";

import {
  assertGeneratedBillingPostable,
  BillingSourceIntegrityError,
} from "../projects/billing-source-integrity.ts";

import { type ContributedLineWithSource } from "../allocations/post.ts";
import { parseMoney } from "../money/brands.ts";

import {
  assertPeriodModulesOpen,
  closeModuleForDocument,
  CloseError,
  periodClosedDetailsOf,
} from "../periods/period-policy.ts";
import { applyBillInventoryReceipts } from "../inventory/documents-purchasing.ts";
import { applyVendorCreditInventoryReturns } from "../inventory/documents-vendor-credits.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { consolidationSourceRefusal } from "../records/consolidation-source-policy.ts";

import { postingPreconditionHooks } from "../journal/posting-preconditions.ts";
import { enqueuePostingEffects } from "./posting-effects.ts";
import { redeemCashSaleTenders, TenderRefusal } from "../sales/document-tenders.ts";
import { enqueueProviderCommitTx, PROVIDER_COMMIT_KINDS } from "../tax/provider-commit.ts";
import { insertAuditRecord } from "../journal/kernel-audit.ts";
import { holdPeriodPostingFence } from "../journal/kernel-fences.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { assertFinalKernelBalance } from "../journal/posting-invariants.ts";
import { validateRequiredDimensions } from "./posting-accounts.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";

import { applySubsidiaries } from "./posting-subsidiaries.ts";
import { resolvePostingPeriod, assertPayRunConsolidatedRateCoverage } from "./posting-period.ts";
import {
  mapBookContributionAccounts,
  replicateDocumentEntry,
  resolveDocumentPostingBook,
} from "./book-posting.ts";
import {
  writePrimaryEntry,
  writeSecondaryBookEntry,
  type DocumentEntry,
  type PostingTx,
  type PreparedPosting,
} from "./posting-journal-entry.ts";

import type { PostDocumentOptions } from "../journal/posting-contracts.ts";

type PaymentTermsSnapshot = Awaited<ReturnType<typeof captureDocumentPaymentTerms>>;
type AuditSnapshot = NonNullable<Awaited<ReturnType<typeof captureTransactionAuditSnapshot>>>;
type LineageRow = typeof schema.allocationLineage.$inferInsert;
type LineageDraft = NonNullable<ContributedLineWithSource["lineage"]>;

/** Owns the accounting transaction; every journal, stock effect, audit and outbox write uses its executor. */
export async function commitDocumentPosting(
  prepared: PreparedPosting,
  options: PostDocumentOptions,
): Promise<string> {
  const { documentId, deps, doc, postingDate } = prepared;
  const actorId = options.audit?.actorId ?? null;
  return await inDbTransaction(async (tx) => {
    const consolidationRefusal = await consolidationSourceRefusal(tx, doc.orgId, documentId);
    if (consolidationRefusal) throw new PostingError(consolidationRefusal);
    // Setup writers exclude posting while independent documents post concurrently; the book and
    // period fences below stay narrower and protect their own state.
    await lockLedgerSetupFence(
      tx,
      doc.orgId,
      doc.journalMode === "currency_adjustment" ? "exclusive" : "shared",
    );
    await assertSourcesCurrent(tx, prepared);
    const { book, period } = await lockPostingScope(tx, prepared, actorId);
    try {
      await assertGeneratedBillingPostable(
        tx,
        doc.orgId,
        documentId,
        { document: prepared.effectiveDoc, lines: prepared.postingLines },
        true,
      );
    } catch (error) {
      if (error instanceof BillingSourceIntegrityError) throw new PostingError(error.message);
      throw error;
    }
    if (deps.migration) await tx.execute(sql`set local openbooks.migration = on`);
    const paymentTermsSnapshot = await retainPaymentTerms(tx, prepared);
    const auditBefore = options.audit
      ? await captureTransactionAuditSnapshot(tx, documentId, doc.orgId)
      : null;
    if (options.audit && !auditBefore)
      throw new PostingError(`document ${documentId} disappeared before posting`);

    const entry = await writePrimaryEntry(tx, prepared, { bookId: book.id, periodId: period.id });
    await flipDocumentToPosted(tx, prepared, entry.entryId, period.id, paymentTermsSnapshot);
    if (paymentTermsSnapshot && !options.audit)
      await auditRetainedPaymentTerms(tx, prepared, paymentTermsSnapshot);
    await redeemTenders(prepared, entry.entryId, actorId);
    await trackProviderCommit(tx, prepared, actorId);
    await recordAllocations(tx, prepared, entry, period.id);
    // Full books receive the primary posting in this transaction.
    await replicateDocumentEntry(tx, doc, book, entry.entryId, actorId);
    if (options.audit && auditBefore)
      await recordPostingAudit(tx, prepared, options.audit, auditBefore);
    await applyInventoryEffects(tx, prepared, entry.entryId, actorId);
    // Product subledgers drain after commit; this outbox row leaves a durable retry for
    // runPostDocumentEffects.
    await enqueuePostingEffects(tx, {
      orgId: doc.orgId,
      documentId: doc.id,
      kind: doc.kind,
      entryId: entry.entryId,
      postingDate,
      actorId,
    });
    return entry.entryId;
  });
}

/** The source evidence the posting relies on is still current under the setup fence. */
async function assertSourcesCurrent(tx: PostingTx, prepared: PreparedPosting): Promise<void> {
  const { documentId, deps, doc, effectiveDoc, postingLines, subApplied, postingDate } = prepared;
  if (doc.kind === "journal") await validateJournalInstructions(tx, doc.orgId, doc.id, true);
  if (!deps.migration) {
    for (const subsidiaryId of new Set(subApplied.lines.map((line) => line.subsidiaryId))) {
      await assertEntityPostingDate(tx, doc.orgId, subsidiaryId, postingDate);
    }
  }
  try {
    await assertCanadianGoodsTaxEvidence(tx, doc.orgId, documentId);
  } catch (error) {
    if (error instanceof PlaceOfSupplyError) throw new PostingError(error.message);
    throw error;
  }
  try {
    await assertCrossBorderSupplyEvidence(tx, doc.orgId, documentId, { persist: true });
  } catch (error) {
    if (error instanceof CrossBorderTaxError) throw new PostingError(error.message);
    throw error;
  }
  if (doc.kind === "vendor_bill" || doc.kind === "vendor_credit") {
    await postingPreconditionHooks.require("payroll").assertRemittanceBillCurrent(doc.orgId, documentId, tx);
  }
  try {
    await assertWithholdingRemittanceCurrent(tx, doc.orgId, documentId, {
      document: effectiveDoc,
      lines: postingLines,
    });
    await assertWithholdingDepositCurrent(tx, doc.orgId, documentId, {
      document: effectiveDoc,
      lines: postingLines,
    });
  } catch (error) {
    if (error instanceof ContractorWithholdingError)
      throw new PostingError(error.remedy ? `${error.message} ${error.remedy}` : error.message);
    throw error;
  }
}

/**
 * Resolves the posting book and period and proves the period open behind the shared close/posting
 * fence. The primary book row is read only after the setup fence, so a demoted book is never
 * retained, and stays share-locked so its history guard cannot race the first posting.
 */
async function lockPostingScope(tx: PostingTx, prepared: PreparedPosting, actorId: string | null) {
  const { doc, effectiveDoc, subApplied, scriptLines, postingDate } = prepared;
  const books = await tx.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(
    sql`
      select id, is_active, posts_gl from accounting_books
       where org_id = ${doc.orgId} and is_primary order by id for share`,
    "objects",
  );
  const primary = books[0];
  if (books.length !== 1 || !primary || !primary.is_active || !primary.posts_gl)
    throw new PostingError("posting requires exactly one active primary posting book");
  // A book-specific journal posts to its target book only; every other document posts to the
  // primary book and replicates into full books.
  const book = await resolveDocumentPostingBook(tx, doc, primary, actorId);
  const period = await resolvePostingPeriod(tx, effectiveDoc, postingDate);
  // A foreign-subsidiary pay run needs the period's derived rates to be translatable at all; every
  // other kind keeps its own spot-rate precondition.
  if (effectiveDoc.kind === "pay_run") {
    await assertPayRunConsolidatedRateCoverage(tx, {
      orgId: effectiveDoc.orgId,
      docCurrency: effectiveDoc.currency,
      docSubsidiaryId: subApplied.docSubId,
      postingDate,
    });
  }
  // A module-only close takes the fence's exclusive side, so it cannot land between this check
  // and the journal insert.
  await holdPeriodPostingFence(tx, { orgId: doc.orgId, periodId: period.id, bookId: book.id });
  await assertDocumentPeriodOpen(tx, prepared, {
    periodId: period.id,
    bookId: book.id,
    subsidiaryIds: [...subApplied.lines, ...scriptLines].map((line) => line.subsidiaryId),
  });
  return { book, period };
}

async function assertDocumentPeriodOpen(
  tx: PostingTx,
  { doc, deps }: PreparedPosting,
  scope: { periodId: string; bookId: string; subsidiaryIds: string[] },
): Promise<void> {
  try {
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: scope.periodId,
      bookId: scope.bookId,
      subsidiaryIds: scope.subsidiaryIds,
      modules: [closeModuleForDocument(doc.kind)],
      allowImportedLocks: deps.migration,
    });
  } catch (error) {
    if (error instanceof CloseError)
      throw new PostingError(error.message, { details: periodClosedDetailsOf(error) });
    throw error;
  }
}

/**
 * Native posts retain their payment terms under lock in the same unit as the journal; a replay
 * cannot manufacture historical terms from current setup, so it retains none.
 */
async function retainPaymentTerms(
  tx: PostingTx,
  prepared: PreparedPosting,
): Promise<PaymentTermsSnapshot> {
  const { doc, deps, effectiveDoc, dueDateFromTerms } = prepared;
  let snapshot: PaymentTermsSnapshot;
  try {
    snapshot = deps.migration
      ? null
      : await captureDocumentPaymentTerms(tx, doc.orgId, effectiveDoc);
  } catch (error) {
    if (error instanceof PaymentTermsEvidenceError)
      throw Object.assign(new PostingError(error.message), { cause: error });
    throw error;
  }
  if (snapshot?.documentKind === "vendor_bill" && dueDateFromTerms) {
    // Capture holds the vendor, its role and the terms row through commit, so the header must
    // carry the due date those locked terms imply.
    let lockedTerms: Awaited<ReturnType<typeof resolveTermsDueDate>>;
    try {
      lockedTerms = await resolveTermsDueDate(tx, doc.orgId, effectiveDoc);
    } catch (error) {
      if (error instanceof DocumentDefaultsError)
        throw Object.assign(new PostingError(error.message), { cause: error });
      throw error;
    }
    if (dueDateFromTerms.dueDate !== (lockedTerms?.dueDate ?? effectiveDoc.documentDate)) {
      throw new PostingError(
        "The vendor's payment terms changed during posting. Reload the bill and post again so its due date and retained terms agree.",
      );
    }
  }
  return snapshot;
}

/**
 * Exactly once: the flip matches only an approved document, so a concurrent post blocks on the
 * row lock, re-reads it as posted and matches nothing, and this transaction rolls back with its
 * entry. The header facts the posting resolved are stamped in the same statement.
 */
async function flipDocumentToPosted(
  tx: PostingTx,
  prepared: PreparedPosting,
  entryId: string,
  periodId: string,
  paymentTermsSnapshot: PaymentTermsSnapshot,
): Promise<void> {
  const {
    doc,
    effectiveDoc,
    subApplied,
    postingDate,
    dueDateFromTerms,
    shipToSnapshot,
    controlAccountStamp,
  } = prepared;
  const flipped = await tx
    .update(schema.documents)
    .set({
      status: "posted",
      postedEntryId: entryId,
      postingDate,
      postingPeriodId: periodId,
      ...(paymentTermsSnapshot ? { paymentTermsSnapshot } : {}),
      // The due date the party's terms imply, so the open item and the header agree.
      ...(dueDateFromTerms ? { dueDate: dueDateFromTerms.dueDate } : {}),
      // The txn→functional rate applied to the origin legs; a document in its origin's base
      // currency keeps its stored rate.
      ...(subApplied.originBaseCurrency !== effectiveDoc.currency
        ? { fxRate: subApplied.originFxRate }
        : {}),
      // The destination the sale was taxed with; the nexus ledger attributes the sale to it, and
      // an uncaptured destination stays unattributed rather than re-homed to a live address.
      ...(shipToSnapshot
        ? {
            shipToCountry: shipToSnapshot.country,
            shipToRegion: shipToSnapshot.region,
          }
        : {}),
      // The open item's control account, which payments, applications and regeneration read.
      ...(controlAccountStamp
        ? {
            custom: sql`jsonb_set(coalesce(${schema.documents.custom}, '{}'::jsonb), '{controlAccountId}', to_jsonb(${controlAccountStamp}::text), true)`,
          }
        : {}),
    })
    .where(
      and(
        eq(schema.documents.id, doc.id),
        eq(schema.documents.orgId, doc.orgId),
        eq(schema.documents.status, "approved"),
      ),
    )
    .returning({ id: schema.documents.id });
  if (flipped.length !== 1) {
    throw new PostingError(`document ${doc.documentNumber} was already posted or voided`);
  }
}

async function auditRetainedPaymentTerms(
  tx: PostingTx,
  { doc }: PreparedPosting,
  snapshot: NonNullable<PaymentTermsSnapshot>,
): Promise<void> {
  await insertAuditRecord(
    tx,
    {
      orgId: doc.orgId,
      tableName: "documents",
      rowId: doc.id,
      action: "update",
      changes: {
        source: "document_posting",
        reason: "Retain payment terms with the original posting",
        before: { payment_terms_snapshot: null },
        after: { payment_terms_snapshot: snapshot },
      },
      actorId: null,
      requestId: "document_posting",
    },
    () => new PostingError("The posted payment terms audit was not retained."),
  );
}

/**
 * A cash sale's stored-value tenders redeem against the entry just posted; an overdrawn card rolls
 * the whole unit back. Historical replay replays the journal, never the subledger.
 */
async function redeemTenders(
  prepared: PreparedPosting,
  entryId: string,
  actorId: string | null,
): Promise<void> {
  const { doc, deps } = prepared;
  if (doc.kind !== "cash_sale" || deps.migration) return;
  try {
    await redeemCashSaleTenders(doc.orgId, doc.id, { journalEntryId: entryId, actorId });
  } catch (error) {
    if (error instanceof TenderRefusal) throw new PostingError(error.message);
    throw error;
  }
}

/** Provider commit tracking rides in the posting transaction; a replay never enqueues history. */
async function trackProviderCommit(
  tx: PostingTx,
  prepared: PreparedPosting,
  actorId: string | null,
): Promise<void> {
  const { doc, deps, effectiveDoc } = prepared;
  if (deps.migration || !PROVIDER_COMMIT_KINDS[doc.kind]) return;
  await enqueueProviderCommitTx(tx, {
    orgId: doc.orgId,
    documentId: doc.id,
    kind: doc.kind,
    documentNumber: effectiveDoc.documentNumber,
    actorId,
  });
}

/**
 * Allocation lineage for the primary entry plus one allocation entry per secondary book. The
 * primary's kernel lines come first and rule contributions follow in rule order; script lines
 * write no lineage, and every lineage source is a primary kernel line.
 */
async function recordAllocations(
  tx: PostingTx,
  prepared: PreparedPosting,
  entry: DocumentEntry,
  periodId: string,
): Promise<void> {
  const { doc, kernelLines, primaryContrib, postContrib } = prepared;
  const kernelLineIds = entry.lineIds.slice(0, kernelLines.length);
  const contribLineIds = entry.lineIds.slice(
    kernelLines.length,
    kernelLines.length + primaryContrib.length,
  );
  const lineageRow = (
    draft: LineageDraft,
    sourceKernelIndex: number,
    journalEntryId: string,
    journalLineId: string | null,
  ): LineageRow => {
    const sourceId = kernelLineIds[sourceKernelIndex];
    if (!sourceId)
      throw new PostingError("allocation contribution points at an unknown kernel line");
    return {
      orgId: doc.orgId,
      mode: "post",
      ruleId: draft.ruleId,
      versionId: draft.versionId,
      definitionHash: draft.definitionHash,
      runId: null,
      documentId: doc.id,
      journalEntryId,
      journalLineId,
      sourceJournalLineId: sourceId,
      sourceDocumentLineId: null,
      targetDocumentLineId: null,
      driverId: draft.driverId,
      driverValue: draft.driverValue,
      driverTotal: draft.driverTotal,
      share: draft.share,
      amount: draft.amount,
      residual: draft.residual ?? "0.0000",
    };
  };
  const contributionRow = (
    line: ContributedLineWithSource,
    journalEntryId: string,
    journalLineId: string,
  ): LineageRow => {
    if (!line.lineage)
      throw new PostingError("allocation contribution is missing its lineage draft");
    return lineageRow(line.lineage, line.sourceKernelIndex, journalEntryId, journalLineId);
  };

  const lineageRows: LineageRow[] = [];
  primaryContrib.forEach((line, j) => {
    const journalLineId = contribLineIds[j];
    if (!journalLineId) throw new PostingError("allocation contribution line was not inserted");
    lineageRows.push(contributionRow(line, entry.entryId, journalLineId));
  });
  for (const draft of postContrib.reportOnly) {
    lineageRows.push(lineageRow(draft, draft.sourceKernelIndex, entry.entryId, null));
  }
  const secondaryByBook = secondaryBookLines(postContrib.lines);
  if (secondaryByBook.size > 0) {
    // Revalidate under the setup fence: a book deactivated after contribution planning refuses
    // instead of receiving the entry.
    const bookRows = await tx.execute<{
      id: string;
      code: string;
      is_active: boolean;
      posts_gl: boolean;
    }>(
      sql`
        select id, code, is_active, posts_gl from accounting_books
         where org_id = ${doc.orgId} and id = any(${`{${[...secondaryByBook.keys()].join(",")}}`}::uuid[])`,
      "objects",
    );
    const bookById = new Map(bookRows.map((b) => [b.id, b]));
    for (const [bookId, bookLines] of secondaryByBook) {
      const target = bookById.get(bookId);
      if (!target || !target.is_active || !target.posts_gl) {
        throw new PostingError("allocation target book is not an active posting book");
      }
      const secondary = await postSecondaryBookEntry(
        tx,
        prepared,
        { id: bookId, code: target.code },
        periodId,
        bookLines,
      );
      bookLines.forEach((line, j) => {
        const journalLineId = secondary.lineIds[j];
        if (!journalLineId) throw new PostingError("allocation contribution line was not inserted");
        lineageRows.push(contributionRow(line, secondary.entryId, journalLineId));
      });
    }
  }
  if (lineageRows.length > 0) {
    await tx.insert(schema.allocationLineage).values(lineageRows);
  }
}

/** Contributed lines addressed to a secondary book, grouped by book. */
function secondaryBookLines(
  lines: readonly ContributedLineWithSource[],
): Map<string, ContributedLineWithSource[]> {
  const byBook = new Map<string, ContributedLineWithSource[]>();
  for (const line of lines) {
    if (line.bookId === undefined) continue;
    const list = byBook.get(line.bookId) ?? [];
    list.push(line);
    byBook.set(line.bookId, list);
  }
  if ([...byBook.keys()].some((bookId) => !isUuid(bookId))) {
    throw new PostingError("allocation target book must be a UUID, not a code or name");
  }
  return byBook;
}

/** A secondary book's allocation entry is balanced and period-checked like the primary entry. */
async function postSecondaryBookEntry(
  tx: PostingTx,
  prepared: PreparedPosting,
  book: { id: string; code: string },
  periodId: string,
  bookLines: ContributedLineWithSource[],
): Promise<DocumentEntry> {
  const { doc, deps, effectiveDoc, subApplied, postingDate } = prepared;
  // Same cross-module intake as prepare: parse contributor amounts once.
  const secApplied = await applySubsidiaries(
    tx,
    effectiveDoc,
    await mapBookContributionAccounts(
      tx,
      effectiveDoc,
      book,
      postingDate,
      bookLines.map((l) => ({ ...l, amount: parseMoney(l.amount) })),
      subApplied.docSubId,
    ),
    { bookId: book.id, regeneration: false, withholdingCarrying: false },
  );
  assertFinalKernelBalance(secApplied.lines);
  await validateRequiredDimensions(tx, doc.orgId, secApplied.lines);
  const subsidiaryIds = [
    ...new Set([subApplied.docSubId, ...secApplied.lines.map((line) => line.subsidiaryId)]),
  ];
  await holdPeriodPostingFence(tx, { orgId: doc.orgId, periodId, bookId: book.id });
  if (!deps.migration) {
    for (const subsidiaryId of subsidiaryIds) {
      await assertEntityPostingDate(tx, doc.orgId, subsidiaryId, postingDate);
    }
  }
  await assertDocumentPeriodOpen(tx, prepared, { periodId, bookId: book.id, subsidiaryIds });
  return await writeSecondaryBookEntry(
    tx,
    prepared,
    { book, periodId },
    secApplied.lines,
    bookLines,
  );
}

async function recordPostingAudit(
  tx: PostingTx,
  { doc, documentId }: PreparedPosting,
  audit: NonNullable<PostDocumentOptions["audit"]>,
  before: AuditSnapshot,
): Promise<void> {
  const after = await captureTransactionAuditSnapshot(tx, documentId, doc.orgId);
  if (!after) throw new PostingError(`document ${documentId} disappeared during posting`);
  await recordTransactionAudit(tx, {
    orgId: doc.orgId,
    documentId,
    action: "post",
    actorId: audit.actorId,
    source: audit.source,
    before,
    after,
  });
}

/** AP, the bill GL and every inventory receipt commit as one accounting unit or not at all. */
async function applyInventoryEffects(
  tx: PostingTx,
  prepared: PreparedPosting,
  entryId: string,
  actorId: string | null,
): Promise<void> {
  const { doc, deps, postingDate, subApplied } = prepared;
  if (deps.migration) return;
  if (doc.kind === "vendor_bill") {
    await asPostingRefusal(() =>
      applyBillInventoryReceipts(
        tx,
        doc.orgId,
        actorId,
        doc.id,
        entryId,
        postingDate,
        subApplied.docSubId,
      ),
    );
  }
  if (doc.kind === "vendor_credit") {
    await asPostingRefusal(() =>
      applyVendorCreditInventoryReturns(
        tx,
        doc.orgId,
        actorId,
        doc.id,
        postingDate,
        subApplied.docSubId,
      ),
    );
  }
}

async function asPostingRefusal(effect: () => Promise<unknown>): Promise<void> {
  try {
    await effect();
  } catch (error) {
    if (error instanceof PostingError) throw error;
    throw new PostingError(error instanceof Error ? error.message : String(error));
  }
}
