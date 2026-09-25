import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { assertPeriodModulesOpen, closeModuleForDocument } from "../periods/period-policy.ts";
import { resolveBillInventoryAccounts } from "../inventory/documents-purchasing.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { transferCorrectionApplications } from "./posting-replay-applications.ts";
import { type PostingDeps, PostingError } from "../journal/posting-contracts.ts";
import { assertFinalKernelBalance } from "../journal/posting-invariants.ts";
import { resolveDeferralAccounts, resolveTaxAccounts, resolveExpenseReceivableDeps, resolveOrgTaxAccounts, resolveTaxComponents, validateRequiredDimensions, resolveOpenItemAccounts } from "./posting-accounts.ts";
import { applySubsidiaries } from "./posting-subsidiaries.ts";
import { resolvePostingPeriod } from "./posting-period.ts";
import { glProjectionScopeUnchanged, buildProjection, glLineKey, glProjectionKey } from "./posting-projection.ts";
export interface SourceCorrectionAuthorization {
  /** Active organization user who explicitly authorized the bounded repair. */
  actorId: string;
  /** Immutable sync-run/request identity tying the ledger chain to its evidence. */
  requestId: string;
  /** Human-readable business reason retained with the correction chain. */
  reason: string;
  /**
   * A running connector mirror may need to reproduce an upstream historical
   * correction inside a period OpenBooks has since closed.  This mode is not a
   * caller-trusted close override: the database validates requestId + actorId
   * against the active sync run and the connection's controller-authorized
   * append-only policy before any closed-period ledger write can occur.
   */
  replayMode?: "authenticated_connector_historical_replay";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Re-materialize an imported POSTED document's GL projection during controlled
 * source replay. The caller MUST set `deps.migration` and must have run
 * `set local openbooks.amend = on`.
 *
 * Returns `{ changed: false }` when the projection is unchanged (a non-GL edit)
 * — no ledger write happens, so it is allowed even in a closed period. A
 * changed projection fails closed unless the caller supplies an explicit,
 * attributable `SourceCorrectionAuthorization`. That bounded repair retains
 * the original, appends an exact reversal and replacement, transfers live
 * application evidence, and refuses dependencies that require a dedicated
 * bank, inventory, revenue, or downstream-document workflow.
 */
export async function regenerateGlImpactTx(
  tx: Tx,
  documentId: string,
  deps: PostingDeps,
  _userId: string,
  correction?: SourceCorrectionAuthorization,
): Promise<{ entryId: string | null; changed: boolean }> {
  if (!deps.migration) {
    throw new PostingError(
      "posted GL replay is restricted to controlled historical migration",
    );
  }
  const [doc] = await tx
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  // Only posted documents have a materialized projection to regenerate.
  if (doc.status !== "posted" || !doc.postedEntryId)
    return { entryId: null, changed: false };

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await tx
      .select()
      .from(schema.paymentCards)
      .where(and(eq(schema.paymentCards.id, doc.paymentCardId), eq(schema.paymentCards.orgId, doc.orgId)));
    if (card)
      deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }
  if (
    (doc.kind === "journal" ||
      doc.kind === "deposit" ||
      doc.kind === "expense_report" ||
      doc.kind === "check") &&
    !deps.openItemAccountIds
  ) {
    deps = {
      ...deps,
      openItemAccountIds: await resolveOpenItemAccounts(tx, doc.orgId),
    };
  }
  deps = await resolveExpenseReceivableDeps(tx, doc, deps);
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(tx, doc.orgId);
    const fallback = await resolveOrgTaxAccounts(tx, doc.orgId);
    deps = {
      ...deps,
      control: {
        ...deps.control,
        taxCollected: deps.control.taxCollected ?? fallback.taxCollected,
        taxPaid: deps.control.taxPaid ?? fallback.taxPaid,
      },
      taxCollectedByCode: tax.collected,
      taxPaidByCode: tax.paid,
    };
  }
  if (
    doc.kind !== "journal" &&
    (!deps.control.taxCollected || !deps.control.taxPaid)
  ) {
    const fallback = await resolveOrgTaxAccounts(tx, doc.orgId);
    deps = {
      ...deps,
      control: {
        ...deps.control,
        taxCollected: deps.control.taxCollected ?? fallback.taxCollected,
        taxPaid: deps.control.taxPaid ?? fallback.taxPaid,
      },
    };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = {
      ...deps,
      taxComponentsByLine: await resolveTaxComponents(tx, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = {
      ...deps,
      deferralAccountByLine: await resolveDeferralAccounts(tx, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = {
      ...deps,
      inventoryAssetByLine: await resolveBillInventoryAccounts(
        tx,
        doc.orgId,
        doc.id,
      ),
    };
  }

  const lines = await tx
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
    .orderBy(asc(schema.documentLines.lineNumber));

  const projection = buildProjection(doc, lines, deps);
  const subApplied = await applySubsidiaries(
    tx,
    doc,
    projection,
  );
  const kernelLines = subApplied.lines;
  assertFinalKernelBalance(kernelLines);
  await validateRequiredDimensions(tx, doc.orgId, kernelLines);
  const postingDate = doc.postingDate ?? doc.documentDate;

  const period = await resolvePostingPeriod(tx, doc, postingDate);

  const [entry] = await tx
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.id, doc.postedEntryId), eq(schema.journalEntries.orgId, doc.orgId)));
  if (!entry || entry.status !== "posted") {
    throw new PostingError(
      "the imported document's current journal entry is missing or not posted",
    );
  }
  const existing = await tx
    .select()
    .from(schema.journalLines)
    .where(and(eq(schema.journalLines.entryId, entry.id), eq(schema.journalLines.orgId, doc.orgId)))
    .orderBy(asc(schema.journalLines.lineNumber));

  // Memo is business metadata, not accounting impact. A memo-only source edit
  // updates the audited document but never rewrites closed ledger evidence.
  // Same lines + posting scope means the GL projection is unchanged.
  const unchanged =
    glProjectionScopeUnchanged(
      { periodId: entry.periodId, postingDate: entry.postingDate },
      { periodId: period.id, postingDate },
    ) &&
    glProjectionKey(kernelLines) ===
      glProjectionKey(existing as unknown as Parameters<typeof glLineKey>[0][]);
  if (unchanged) return { entryId: entry.id, changed: false };

  if (!correction) {
    throw new PostingError(
      "posted GL projection changed; in-place regeneration is forbidden — use a controlled append-only reversal/replacement workflow",
    );
  }

  const reason = correction.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new PostingError(
      "a source correction reason between 10 and 500 characters is required",
    );
  }
  if (!isUuid(correction.actorId)) {
    throw new PostingError(
      "an attributable organization user is required for a source correction",
    );
  }
  if (!correction.requestId.trim()) {
    throw new PostingError("a source correction request identity is required");
  }

  const control = (await tx.execute<{
      actor_valid: boolean;
      already_reversed: boolean;
      reconciled: boolean;
      applied: boolean;
      inventory: boolean;
      revenue: boolean;
      downstream: boolean;
    }>(sql`
    select
      exists (
        select 1 from users
         where id = ${correction.actorId}
           and org_id = ${doc.orgId}
           and is_active
      ) as actor_valid,
      exists (
        select 1 from journal_entries reversal
         where reversal.org_id = ${doc.orgId}
           and reversal.reverses_entry_id = ${entry.id}
           and reversal.status in ('posted', 'reversed')
      ) as already_reversed,
      exists (
        select 1 from reconciliation_matches match
         where match.org_id = ${doc.orgId}
           and match.journal_line_id in (
             select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
           )
      ) as reconciled,
      exists (
        select 1 from applications application
         where application.org_id = ${doc.orgId}
           and application.unapplied_at is null
           and (
             application.from_line_id in (
               select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
             )
             or application.to_line_id in (
               select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
             )
           )
      ) as applied,
      exists (
        select 1 from inventory_movements movement
         where movement.org_id = ${doc.orgId}
           and movement.document_line_id in (
             select id from document_lines where document_id = ${doc.id} and org_id = ${doc.orgId}
           )
      ) as inventory,
      exists (
        select 1 from performance_obligations obligation
         where obligation.org_id = ${doc.orgId}
           and obligation.document_line_id in (
             select id from document_lines where document_id = ${doc.id} and org_id = ${doc.orgId}
           )
           and obligation.status <> 'cancelled'
      ) as revenue,
      exists (
        select 1 from document_links link
         join documents downstream
           on downstream.id = link.to_document_id
          and downstream.org_id = link.org_id
         where link.org_id = ${doc.orgId}
           and link.from_document_id = ${doc.id}
           and link.link_type <> 'pays'
           and downstream.status in ('approved', 'posted')
      ) as downstream
  `));
  const gates = control.rows[0];
  if (!gates?.actor_valid) {
    throw new PostingError(
      "the source correction actor is not an active organization user",
    );
  }
  if (gates.already_reversed) {
    throw new PostingError(
      "the current journal already has a reversal; resolve its existing correction lineage before retrying",
    );
  }
  const blockers = [
    gates.reconciled ? "bank reconciliation" : null,
    gates.inventory ? "inventory movements" : null,
    gates.revenue ? "revenue-recognition obligations" : null,
    gates.downstream ? "downstream documents" : null,
  ].filter((value): value is string => value !== null);
  if (blockers.length > 0) {
    throw new PostingError(
      `source correction is blocked by ${blockers.join(", ")}; reverse or transfer those dependent subledgers first`,
    );
  }

  // Applications are append-preserved settlement evidence. A correction may
  // move the document's open-item line, so retain each old application through
  // its one legal unapply transition and append an equivalent application to
  // the replacement endpoint. Bank reconciliation, inventory, revenue, and
  // downstream-document evidence remain hard blockers because their dedicated
  // transfer/cancellation workflows carry additional accounting semantics.
  let activeApplications = await tx
    .select()
    .from(schema.applications)
    .where(sql`
      ${schema.applications.orgId} = ${doc.orgId}
      and ${schema.applications.unappliedAt} is null
      and (
        ${schema.applications.fromLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
        or ${schema.applications.toLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
      )
    `);
  // Source correction transfers live applications after changing the source
  // document's posted entry. Acquire the shared document -> entry -> endpoint
  // line lock order before that document write; the application validation
  // trigger otherwise locks endpoint lines while the correction already owns
  // the document row, opposite ordinary payment posting's order.
  const endpointIds = [...new Set(activeApplications.flatMap((application) => [
    application.fromLineId,
    application.toLineId,
  ]))];
  const lockedApplicationEvidence = await lockApplicationEvidence(
    tx,
    doc.orgId,
    endpointIds,
    [doc.id],
    [entry.id],
  );
  activeApplications = await tx
    .select()
    .from(schema.applications)
    .where(sql`
      ${schema.applications.orgId} = ${doc.orgId}
      and ${schema.applications.unappliedAt} is null
      and (
        ${schema.applications.fromLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
        or ${schema.applications.toLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
      )
    `);
  const lockedEndpointIds = new Set(lockedApplicationEvidence.lineIds);
  if (activeApplications.some((application) =>
    !lockedEndpointIds.has(application.fromLineId) ||
    !lockedEndpointIds.has(application.toLineId)
  )) {
    throw new PostingError(
      "applications changed while source correction locks were acquired; retry the correction",
    );
  }

  let authenticatedHistoricalReplay = false;
  if (
    correction.replayMode === "authenticated_connector_historical_replay"
  ) {
    await tx.execute(sql`
      select
        set_config('openbooks.connector_replay', 'on', true),
        set_config('openbooks.connector_replay_request', ${correction.requestId}, true),
        set_config('openbooks.connector_replay_actor', ${correction.actorId}, true)
    `);
    const authorization = (await tx.execute<{ allowed: boolean }>(sql`
      select connector_historical_replay_authorized(${doc.orgId}) as allowed
    `));
    if (authorization.rows[0]?.allowed !== true) {
      throw new PostingError(
        "closed-period connector replay is not authorized by the active sync run and connection policy",
      );
    }
    authenticatedHistoricalReplay = true;
  }

  const module = closeModuleForDocument(doc.kind);
  if (!authenticatedHistoricalReplay) {
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: entry.periodId,
      bookId: entry.bookId,
      subsidiaryIds: existing.map((line) => line.subsidiaryId),
      modules: [module],
      allowImportedLocks: true,
    });
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: period.id,
      bookId: entry.bookId,
      subsidiaryIds: kernelLines.map((line) => line.subsidiaryId),
      modules: [module],
      allowImportedLocks: true,
    });
  }

  const evidence = {
    mode: "append_only_source_correction",
    reason,
    requestId: correction.requestId,
    documentId: doc.id,
    originalEntryId: entry.id,
    before: {
      postingDate: entry.postingDate,
      periodId: entry.periodId,
    },
    after: {
      postingDate,
      periodId: period.id,
    },
    historicalReplay: authenticatedHistoricalReplay
      ? {
          mode: "authenticated_connector_historical_replay",
          periodLocksPreserved: true,
        }
      : null,
  };
  // The reversal posts through the ONE ledger API; the corrected entry is
  // then marked reversed — never edited.
  const mirror = reversalJournalLines(existing, { entryId: "", orgId: doc.orgId });
  const postedReversal = await postEntry(tx, {
    orgId: doc.orgId,
    bookId: entry.bookId,
    subsidiaryId: entry.subsidiaryId,
    entryNumber: await nextFreeEntryNumber(
      tx,
      doc.orgId,
      `${entry.entryNumber}-SOURCE-REV`,
    ),
    postingDate: entry.postingDate,
    periodId: entry.periodId,
    memo: `Source correction reversal: ${reason}`,
    sourceDocumentId: doc.id,
    origin: "migration",
    reversesEntryId: entry.id,
    custom: evidence,
    actorId: correction.actorId,
    closeModules: [module],
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
    })),
  });
  const reversal = { id: postedReversal.entryId };
  await markEntryReversed(tx, {
    orgId: doc.orgId,
    entryId: entry.id,
    actorId: correction.actorId,
  });

  // Repeated corrections of one document reverse the prior replacement and
  // post a new one; number each generation past its predecessors so the
  // insert cannot collide under journal_entries_org_number.
  const priorCorrections = (await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
      from journal_entries
     where org_id = ${doc.orgId} and source_document_id = ${doc.id}
       and reverses_entry_id is null
       and custom->>'mode' = 'append_only_source_correction'`));
  const correctionGen = (priorCorrections.rows[0]?.n ?? 0) + 1;
  // The replacement posts through the ONE ledger API.
  const postedReplacement = await postEntry(tx, {
    orgId: doc.orgId,
    bookId: entry.bookId,
    subsidiaryId: subApplied.docSubId,
    entryNumber: await nextFreeEntryNumber(
      tx,
      doc.orgId,
      correctionGen === 1
        ? `${doc.documentNumber}-SOURCE-CORR`
        : `${doc.documentNumber}-SOURCE-CORR-${correctionGen}`,
    ),
    postingDate,
    periodId: period.id,
    memo: doc.memo,
    sourceDocumentId: doc.id,
    origin: subApplied.multi ? "intercompany" : "migration",
    custom: {
      ...evidence,
      reversalEntryId: reversal.id,
    },
    actorId: correction.actorId,
    closeModules: [module],
    allowImportedLocks: true,
    allowInactiveAccounts: true,
    lines: kernelLines.map((line) => ({
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
      extraDims: line.extraDims ?? {},
      paymentCardId: line.paymentCardId,
      taxCodeId: line.taxCodeId,
      dueDate: line.dueDate,
      isOpenItem: line.isOpenItem,
    })),
  });
  const replacement = { id: postedReplacement.entryId };
  // Application transfer below reads full line fields; the API returns ids
  // in line order, so rejoin them with the posted kernel lines.
  const replacementLines = kernelLines.map((line, index) => ({
    ...line,
    id: postedReplacement.lines[index]!.id,
  }));
  const updated = await tx
    .update(schema.documents)
    .set({
      postedEntryId: replacement.id,
      updatedAt: new Date(),
      updatedBy: correction.actorId,
    })
    .where(
      and(
        eq(schema.documents.id, doc.id),
        eq(schema.documents.orgId, doc.orgId),
        eq(schema.documents.postedEntryId, entry.id),
        eq(schema.documents.status, "posted"),
      ),
    )
    .returning({ id: schema.documents.id });
  if (updated.length !== 1) {
    throw new PostingError(
      "the imported document changed while its source correction was being posted",
    );
  }
  const transferredApplications = await transferCorrectionApplications(tx, {
    orgId: doc.orgId,
    documentId: doc.id,
    documentNumber: doc.documentNumber,
    existing,
    replacementLines,
    activeApplications,
    actorId: correction.actorId,
    requestId: correction.requestId,
    reason,
  });
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${doc.orgId}, 'documents', ${doc.id}, 'update',
      ${JSON.stringify({
        ...evidence,
        reversalEntryId: reversal.id,
        replacementEntryId: replacement.id,
        dependencyChecks: {
          bankReconciliation: false,
          transferredApplications,
          inventoryMovements: false,
          revenueRecognition: false,
          downstreamDocuments: false,
        },
      })}::jsonb,
      ${correction.actorId}, ${correction.requestId}
    )
  `);
  if (authenticatedHistoricalReplay) {
    await tx.execute(sql`
      select
        set_config('openbooks.connector_replay', 'off', true),
        set_config('openbooks.connector_replay_request', '', true),
        set_config('openbooks.connector_replay_actor', '', true)
    `);
  }
  return { entryId: replacement.id, changed: true };
}
