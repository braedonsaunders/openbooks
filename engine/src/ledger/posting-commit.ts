import { and, eq, sql } from "drizzle-orm";
import { db, inDbTransaction, schema } from "../platform/db.ts";

import { assertGeneratedBillingPostable, BillingSourceIntegrityError } from "../projects/billing-source-integrity.ts";

import { type ContributedLineWithSource } from "../allocations/post.ts";

import { assertPeriodModulesOpen, closeModuleForDocument, CloseError } from "../close/close.ts";
import { applyBillInventoryReceipts, applyVendorCreditInventoryReturns } from "../inventory/inventory.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "../records/transaction-audit.ts";

import { allocateEntryNumber, nextFreeEntryNumber } from "../records/entry-number.ts";
import { assertPayrollRemittanceBillCurrent } from "../payroll/remittance.ts";
import { enqueuePostingEffects } from "./posting-effects.ts";
import { PostingError, assertFinalKernelBalance } from "./posting-rules.ts";
import { validateRequiredDimensions } from "./posting-accounts.ts";

import { applySubsidiaries } from "./posting-subsidiaries.ts";
import { resolvePostingPeriod, assertPayRunConsolidatedRateCoverage } from "./posting-period.ts";

import type { PostDocumentOptions } from "./posting-contracts.ts";
import type { prepareDocumentPosting } from "./posting-prepare.ts";

/** Owns the accounting transaction; every journal, stock effect, audit and outbox write uses its executor. */
export async function commitDocumentPosting(prepared: Awaited<ReturnType<typeof prepareDocumentPosting>>, options: PostDocumentOptions): Promise<string> {
  const { documentId, deps, doc, postingLines, effectiveDoc, kernelLines, postContrib, primaryContrib, unionLines, subApplied, scriptLines, postingDate } = prepared;
  return await inDbTransaction(async (tx) => {
    // Setup wizard mutations and posting both serialize on the organization
    // aggregate root. This makes the wizard's accounting-foundation probe and
    // its subsequent COA/currency/calendar writes one decision against the
    // same lock: whichever operation acquires the row first wins, and the
    // other re-checks after it commits.
    await tx.execute(sql`select id from orgs where id = ${doc.orgId} for update`);
    if (doc.kind === "vendor_bill") {
      await assertPayrollRemittanceBillCurrent(doc.orgId, documentId, tx);
    }
    // Resolve the authority only after the organization fence. Reading it
    // before the transaction can retain a demoted book while setup commits.
    // Hold the book row through the first journal insert so its history guard
    // cannot pass concurrently with this organization's first posting.
    const books = (await tx.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(sql`
      select id, is_active, posts_gl from accounting_books
       where org_id = ${doc.orgId} and is_primary order by id for share
    `)).rows;
    if (books.length !== 1 || !books[0]!.is_active || !books[0]!.posts_gl)
      throw new PostingError("posting requires exactly one active primary posting book");
    const book = books[0]!;
    const period = await resolvePostingPeriod(tx, effectiveDoc, postingDate);
    // A foreign-subsidiary pay run posts face amounts no statement can
    // translate without the period's derived rates — refuse with the trial
    // balance's own message rather than posting anyway. Every other kind
    // (an AP bill in particular) keeps its own spot-rate precondition.
    if (effectiveDoc.kind === "pay_run") {
      await assertPayRunConsolidatedRateCoverage(tx, {
        orgId: effectiveDoc.orgId,
        docCurrency: effectiveDoc.currency,
        docSubsidiaryId: subApplied.docSubId,
        postingDate,
      });
    }
    // Hold the shared period fence BEFORE the authoritative module check and
    // keep it through commit: a module-only close takes the exclusive side,
    // so it either waits for this posting or this check re-reads its commit.
    // Without this, a close could land between the check below and the
    // journal insert while the storage guard rechecked GL only (0168
    // rechecks the source module in storage as the second half of this fix).
    await tx.execute(sql`select period_posting_fence(${doc.orgId}, ${period.id}, ${book.id})`);
    try {
      await assertPeriodModulesOpen(tx, {
        orgId: doc.orgId,
        periodId: period.id,
        bookId: book.id,
        subsidiaryIds: [...subApplied.lines, ...scriptLines].map(
          (line) => line.subsidiaryId,
        ),
        modules: [closeModuleForDocument(doc.kind)],
        allowImportedLocks: deps.migration,
      });
    } catch (error) {
      if (error instanceof CloseError) throw new PostingError(error.message);
      throw error;
    }

    try {
      await assertGeneratedBillingPostable(tx, doc.orgId, documentId, { document: effectiveDoc, lines: postingLines }, true);
    } catch (error) {
      if (error instanceof BillingSourceIntegrityError) throw new PostingError(error.message);
      throw error;
    }
    if (deps.migration)
      await tx.execute(sql`set local openbooks.migration = on`);
    const auditBefore = options.audit
      ? await captureTransactionAuditSnapshot(tx, documentId, doc.orgId)
      : null;
    if (options.audit && !auditBefore) {
      throw new PostingError(
        `document ${documentId} disappeared before posting`,
      );
    }
    // The entry insert is the first write in the transaction, so under a
    // concurrent post of the SAME approved document the racer blocks here on
    // journal_entries_org_number (entry_number = the document number) until
    // the winner commits, then fails with a unique violation. Translate that
    // into the same PostingError the flip guard below produces: the racing
    // caller must see "already posted", never a raw driver error.
    // Source systems number per TRANSACTION TYPE, so a vendor bill and an
    // expense report can both legitimately be "1000" -- that is the source's
    // model, not a data error, and an importer cannot ask a human to renumber
    // it. journal_entries_org_number spans every kind, so the second document
    // to post could not obtain an entry number at all and simply failed; a
    // production migration lost documents to exactly this.
    //
    // Numbers stay unique. A collision with a DIFFERENT document is instead
    // resolved automatically by qualifying with the document's kind, in the
    // same hyphen-suffix style the source-correction path already mints
    // (-SOURCE-CORR / -SOURCE-REV). Document numbers are unique WITHIN a kind,
    // so the qualified form cannot collide in turn.
    //
    // A concurrent post of the SAME document still resolves to the same
    // preferred number and still collides on the index, which is what the
    // 23505 branch below and the flip guard rely on. That is safe to keep:
    // this transaction already holds `for update` on the org row, so postings
    // in an organization are serialized and this read cannot race an insert.
    const entryNumber = await allocateEntryNumber(
      tx,
      doc.orgId,
      doc.id,
      `${effectiveDoc.documentNumber}`,
      doc.kind,
    );
    let entry: { id: string };
    try {
      entry = (await tx
        .insert(schema.journalEntries)
        .values({
          orgId: doc.orgId,
          bookId: book.id,
          subsidiaryId: subApplied.docSubId,
          entryNumber,
          postingDate,
          periodId: period.id,
          memo: effectiveDoc.memo,
          status: "draft",
          sourceDocumentId: doc.id,
          origin:
            subApplied.multi ||
            scriptLines.some((l) => l.subsidiaryId !== subApplied.docSubId)
              ? "intercompany"
              : "document",
        })
        .returning({ id: schema.journalEntries.id }))[0]!;
    } catch (error) {
      const code = (error as { code?: string }).code ??
        (error as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") {
        // The (org, entry_number) index spans every document kind, so the
        // collision is either this document's own earlier posting or a
        // DIFFERENT document that already claimed the number. Diagnose which,
        // because "already posted" is false for a valid approved document
        // that has no journal yet. The violated index aborted this
        // transaction, so the read runs on the pool against the committed
        // claimant row before this unit rolls back.
        const claimant = await db.execute<{
          kind: string;
          document_number: string;
          source_document_id: string | null;
        }>(sql`
          select d.kind, d.document_number, e.source_document_id
            from journal_entries e
            left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
           where e.org_id = ${doc.orgId}
             and e.entry_number = ${entryNumber}
           limit 1`);
        const other = claimant.rows[0];
        if (other && other.source_document_id !== doc.id) {
          throw new PostingError(
            `journal entry number "${entryNumber}" is already used by ${other.kind ?? "another document"} ${other.document_number ?? ""}`,
          );
        }
        throw new PostingError(
          `document ${doc.documentNumber} was already posted or voided`,
        );
      }
      throw error;
    }

    const insertedLines = await tx.insert(schema.journalLines).values([
      ...subApplied.lines.map((l, i) => ({
        orgId: doc.orgId,
        entryId: entry.id,
        lineNumber: i + 1,
        accountId: l.accountId,
        subsidiaryId: l.subsidiaryId,
        amount: l.amount,
        currency: l.currency,
        txnAmount: l.txnAmount,
        fxRate: l.fxRate,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        equipmentUnitId: l.equipmentUnitId ?? null,
        extraDims: l.extraDims ?? {},
        paymentCardId: l.paymentCardId ?? null,
        taxCodeId: l.taxCodeId ?? null,
        memo: l.memo ?? null,
        dueDate: l.dueDate ?? null,
        isOpenItem: l.isOpenItem ?? false,
        // Kernel lines carry no contributor (null); rule contributions ride
        // at unionLines[kernelLines.length + j] by the order contract above.
        contributorKind: unionLines[i]?.contributorKind ?? null,
        contributorRef: unionLines[i]?.contributorRef ?? null,
      })),
      // Allocation-kernel script contributions (A6): same entry, stamped so
      // the GL impact view can lock standard lines and show these separately.
      // No lineage rows — lineage is not required for scripts.
      ...scriptLines.map((l, i) => ({
        orgId: doc.orgId,
        entryId: entry.id,
        lineNumber: subApplied.lines.length + i + 1,
        accountId: l.accountId,
        subsidiaryId: l.subsidiaryId,
        amount: l.amount,
        currency: l.currency,
        txnAmount: l.txnAmount,
        fxRate: l.fxRate,
        partyId: null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        equipmentUnitId: null,
        extraDims: l.extraDims ?? {},
        paymentCardId: null,
        taxCodeId: null,
        memo: l.memo ?? null,
        dueDate: null,
        isOpenItem: false,
        contributorKind: l.contributorKind,
        contributorRef: l.contributorRef,
      })),
    ])
      .returning({ id: schema.journalLines.id });

    await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, doc.orgId)));

    // Exactly-once posting, serialized at the aggregate root: the flip only
    // lands while the document is still unposted. Postgres row-locks the
    // document during this UPDATE, so a concurrent post blocks here, then
    // re-evaluates the predicate against the now-'posted' row and matches 0
    // rows. Zero rows → throw → THIS transaction rolls back, discarding the
    // entry + lines just inserted. A document can never produce two entries.
    //
    // The flip also stamps documents.fx_rate with the SAME rate the kernel
    // applied to the origin-subsidiary legs, in the same transaction as the
    // entry, so the header and the posted lines agree by construction:
    // documents.fx_rate is the txn→functional rate as of posting, maintained
    // by the posting kernel. Native creation paths never set it (the column
    // defaults to '1'; only source sync wrote real values before), so every
    // downstream reader — dunning's base-currency threshold, payment-run
    // conversions — now reads the rate the ledger actually posted at. A
    // document already in its origin's base currency keeps the stored value
    // (1 by definition). The posted-document financial guard is not in play
    // here: this UPDATE matches only 'approved' rows and that guard fires
    // solely for posted/reversed ones.
    const flipped = await tx
      .update(schema.documents)
      .set({
        status: "posted",
        postedEntryId: entry.id,
        postingDate,
        postingPeriodId: period.id,
        ...(subApplied.originBaseCurrency !== effectiveDoc.currency
          ? { fxRate: subApplied.originFxRate }
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
    if (flipped.length === 0) {
      throw new PostingError(
        `document ${doc.documentNumber} was already posted or voided`,
      );
    }

    // -- allocation lineage + secondary-book entries (same transaction) ----
    // Kernel lines keep numbers 1..N with rule contributions following in
    // rule order; script lines come last and write no lineage (A6).
    const kernelLineIds = insertedLines
      .slice(0, kernelLines.length)
      .map((r) => r.id);
    const contribLineIds = insertedLines
      .slice(kernelLines.length, kernelLines.length + primaryContrib.length)
      .map((r) => r.id);
    const lineageOf = (
      line: ContributedLineWithSource,
      journalEntryId: string,
      journalLineId: string | null,
    ): typeof schema.allocationLineage.$inferInsert => {
      const draft = line.lineage;
      if (!draft) throw new PostingError("allocation contribution is missing its lineage draft");
      const sourceId = kernelLineIds[line.sourceKernelIndex];
      if (!sourceId) throw new PostingError("allocation contribution points at an unknown kernel line");
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
    const lineageRows: (typeof schema.allocationLineage.$inferInsert)[] = [];
    primaryContrib.forEach((line, j) => {
      const journalLineId = contribLineIds[j];
      if (!journalLineId) throw new PostingError("allocation contribution line was not inserted");
      lineageRows.push(lineageOf(line, entry.id, journalLineId));
    });
    for (const draft of postContrib.reportOnly) {
      const sourceId = kernelLineIds[draft.sourceKernelIndex];
      if (!sourceId) throw new PostingError("allocation contribution points at an unknown kernel line");
      lineageRows.push({
        orgId: doc.orgId,
        mode: "post",
        ruleId: draft.ruleId,
        versionId: draft.versionId,
        definitionHash: draft.definitionHash,
        runId: null,
        documentId: doc.id,
        journalEntryId: entry.id,
        journalLineId: null,
        sourceJournalLineId: sourceId,
        sourceDocumentLineId: null,
        targetDocumentLineId: null,
        driverId: draft.driverId,
        driverValue: draft.driverValue,
        driverTotal: draft.driverTotal,
        share: draft.share,
        amount: draft.amount,
        residual: draft.residual ?? "0.0000",
      });
    }
    // Secondary books: one origin='allocation' entry per book with that
    // book's contributed lines, balanced and period-checked like the main
    // entry. Lineage sources still point at the primary entry's kernel line.
    const secondaryByBook = new Map<string, ContributedLineWithSource[]>();
    for (const line of postContrib.lines) {
      if (line.bookId === undefined) continue;
      const list = secondaryByBook.get(line.bookId) ?? [];
      list.push(line);
      secondaryByBook.set(line.bookId, list);
    }
    if (secondaryByBook.size > 0) {
      // Revalidate under the org lock: a book deactivated after contribution
      // planning refuses instead of posting into a dead book.
      const bookRows = (await tx.execute<{ id: string; code: string; is_active: boolean; posts_gl: boolean }>(sql`
        select id, code, is_active, posts_gl from accounting_books
         where org_id = ${doc.orgId} and id = any(${`{${[...secondaryByBook.keys()].join(",")}}`}::uuid[])`)).rows;
      const bookById = new Map(bookRows.map((b) => [b.id, b]));
      for (const [bookId, bookLines] of secondaryByBook) {
        const book = bookById.get(bookId);
        if (!book || !book.is_active || !book.posts_gl) {
          throw new PostingError("allocation target book is not an active posting book");
        }
        const secApplied = await applySubsidiaries(tx, effectiveDoc, bookLines);
        assertFinalKernelBalance(secApplied.lines);
        await validateRequiredDimensions(tx, doc.orgId, secApplied.lines);
        try {
          await assertPeriodModulesOpen(tx, {
            orgId: doc.orgId,
            periodId: period.id,
            bookId,
            subsidiaryIds: secApplied.lines.map((line) => line.subsidiaryId),
            modules: [closeModuleForDocument(doc.kind)],
            allowImportedLocks: deps.migration,
          });
        } catch (error) {
          if (error instanceof CloseError) throw new PostingError(error.message);
          throw error;
        }
        const secEntry = (await tx
          .insert(schema.journalEntries)
          .values({
            orgId: doc.orgId,
            bookId,
            subsidiaryId: subApplied.docSubId,
            entryNumber: await nextFreeEntryNumber(
              tx,
              doc.orgId,
              `${effectiveDoc.documentNumber}-ALLOC-${book.code}`,
            ),
            postingDate,
            periodId: period.id,
            memo: `Allocations for ${effectiveDoc.documentNumber} (${book.code})`,
            status: "draft",
            sourceDocumentId: doc.id,
            origin: "allocation",
          })
          .returning({ id: schema.journalEntries.id }))[0]!;
        const secInserted = await tx
          .insert(schema.journalLines)
          .values(
            secApplied.lines.map((l, i) => ({
              orgId: doc.orgId,
              entryId: secEntry.id,
              lineNumber: i + 1,
              accountId: l.accountId,
              subsidiaryId: l.subsidiaryId,
              amount: l.amount,
              currency: l.currency,
              txnAmount: l.txnAmount,
              fxRate: l.fxRate,
              partyId: l.partyId ?? null,
              departmentId: l.departmentId ?? null,
              projectId: l.projectId ?? null,
              locationId: l.locationId ?? null,
              classId: l.classId ?? null,
              equipmentUnitId: l.equipmentUnitId ?? null,
              extraDims: l.extraDims ?? {},
              paymentCardId: l.paymentCardId ?? null,
              taxCodeId: l.taxCodeId ?? null,
              memo: l.memo ?? null,
              dueDate: l.dueDate ?? null,
              isOpenItem: l.isOpenItem ?? false,
              contributorKind: bookLines[i]?.contributorKind ?? null,
              contributorRef: bookLines[i]?.contributorRef ?? null,
            })),
          )
          .returning({ id: schema.journalLines.id });
        await tx
          .update(schema.journalEntries)
          .set({ status: "posted", postedAt: new Date() })
          .where(and(eq(schema.journalEntries.id, secEntry.id), eq(schema.journalEntries.orgId, doc.orgId)));
        bookLines.forEach((line, j) => {
          const journalLineId = secInserted[j]?.id;
          if (!journalLineId) throw new PostingError("allocation contribution line was not inserted");
          lineageRows.push(lineageOf(line, secEntry.id, journalLineId));
        });
      }
    }
    if (lineageRows.length > 0) {
      await tx.insert(schema.allocationLineage).values(lineageRows);
    }

    if (options.audit && auditBefore) {
      const auditAfter = await captureTransactionAuditSnapshot(tx, documentId, doc.orgId);
      if (!auditAfter)
        throw new PostingError(
          `document ${documentId} disappeared during posting`,
        );
      await recordTransactionAudit(tx, {
        orgId: doc.orgId,
        documentId,
        action: "post",
        actorId: options.audit.actorId,
        source: options.audit.source,
        before: auditBefore,
        after: auditAfter,
      });
    }

    // AP, the bill GL, and every inventory receipt are one accounting unit.
    // A later receipt failure rolls back the document and all earlier stock.
    if (doc.kind === "vendor_bill" && !deps.migration) {
      try {
        await applyBillInventoryReceipts(
          tx,
          doc.orgId,
          options.audit?.actorId ?? null,
          doc.id,
          entry.id,
          postingDate,
          subApplied.docSubId,
        );
      } catch (error) {
        if (error instanceof PostingError) throw error;
        throw new PostingError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (doc.kind === "vendor_credit" && !deps.migration) {
      try {
        await applyVendorCreditInventoryReturns(
          tx,
          doc.orgId,
          options.audit?.actorId ?? null,
          doc.id,
          postingDate,
          subApplied.docSubId,
        );
      } catch (error) {
        if (error instanceof PostingError) throw error;
        throw new PostingError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Product subledgers drain after commit. Write the outbox row in this
    // transaction so a crash leaves a durable retry for runPostDocumentEffects.
    await enqueuePostingEffects(tx, {
      orgId: doc.orgId,
      documentId: doc.id,
      kind: doc.kind,
      entryId: entry.id,
      postingDate,
      actorId: options.audit?.actorId ?? null,
    });

    return entry.id;
  });
}
