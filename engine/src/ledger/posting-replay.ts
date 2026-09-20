import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { assertPeriodModulesOpen, closeModuleForDocument } from "../close/period-policy.ts";
import { resolveBillInventoryAccounts } from "../inventory/documents-purchasing.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { type PostingDeps, PostingError } from "./posting-contracts.ts";
import { assertFinalKernelBalance } from "./posting-invariants.ts";
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
  if (!/^[0-9a-f-]{36}$/i.test(correction.actorId)) {
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
  const activeApplications = await tx
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
  const reversal = (await tx
    .insert(schema.journalEntries)
    .values({
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
      status: "draft",
      sourceDocumentId: doc.id,
      origin: "migration",
      reversesEntryId: entry.id,
      custom: evidence,
      createdBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .returning({ id: schema.journalEntries.id }))[0]!;
  await tx.insert(schema.journalLines).values(
    reversalJournalLines(existing, { entryId: reversal.id, orgId: doc.orgId }),
  );
  await tx
    .update(schema.journalEntries)
    .set({
      status: "posted",
      postedAt: new Date(),
      postedBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, reversal.id), eq(schema.journalEntries.orgId, doc.orgId)));
  await tx
    .update(schema.journalEntries)
    .set({
      status: "reversed",
      updatedAt: new Date(),
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, doc.orgId)));

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
  const replacement = (await tx
    .insert(schema.journalEntries)
    .values({
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
      status: "draft",
      sourceDocumentId: doc.id,
      origin: subApplied.multi ? "intercompany" : "migration",
      custom: {
        ...evidence,
        reversalEntryId: reversal.id,
      },
      createdBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .returning({ id: schema.journalEntries.id }))[0]!;
  const replacementLines = await tx
    .insert(schema.journalLines)
    .values(kernelLines.map((line, index) => ({
      orgId: doc.orgId,
      entryId: replacement.id,
      lineNumber: index + 1,
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: line.amount,
      currency: line.currency,
      txnAmount: line.txnAmount,
      fxRate: line.fxRate,
      partyId: line.partyId ?? null,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      equipmentUnitId: line.equipmentUnitId ?? null,
      extraDims: line.extraDims ?? {},
      paymentCardId: line.paymentCardId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      memo: line.memo ?? null,
      dueDate: line.dueDate ?? null,
      isOpenItem: line.isOpenItem ?? false,
    })))
    .returning();
  await tx
    .update(schema.journalEntries)
    .set({
      status: "posted",
      postedAt: new Date(),
      postedBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, replacement.id), eq(schema.journalEntries.orgId, doc.orgId)));
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
  const priorLineIds = new Set(existing.map((line) => line.id));
  const transferredApplications: Array<{
    priorApplicationId: string;
    replacementApplicationId: string;
    priorFromLineId: string;
    replacementFromLineId: string;
    priorToLineId: string;
    replacementToLineId: string;
  }> = [];
  const replacementEndpoint = (lineId: string): string => {
    if (!priorLineIds.has(lineId)) return lineId;
    const prior = existing.find((line) => line.id === lineId)!;
    const exact = replacementLines.filter(
      (line) =>
        line.isOpenItem &&
        line.accountId === prior.accountId &&
        line.partyId === prior.partyId &&
        line.subsidiaryId === prior.subsidiaryId &&
        line.currency === prior.currency,
    );
    const candidates = exact.length
      ? exact
      : replacementLines.filter(
          (line) =>
            line.isOpenItem &&
            line.partyId === prior.partyId &&
            line.subsidiaryId === prior.subsidiaryId &&
            line.currency === prior.currency,
        );
    if (candidates.length !== 1) {
      throw new PostingError(
        `cannot transfer application endpoint ${lineId}: expected one replacement open-item line, found ${candidates.length}`,
      );
    }
    return candidates[0]!.id;
  };
  // Settlement evidence moves verbatim onto the replacement endpoints, and the
  // database re-validates every transferred application at commit
  // (app_validate_endpoints plus the deferred app_check_open). A deferred
  // refusal surfaces as a raw driver error after the reversal and replacement
  // are already written, so prove the transfer fits FIRST — the same endpoint
  // sharing and open-capacity arithmetic the triggers enforce — and refuse
  // with an attributable error, the way a void with live applications does.
  // The whole correction still rolls back atomically; the operator unapplies
  // the settlements, corrects, and re-applies.
  if (activeApplications.length > 0) {
    const outsideIds = [
      ...new Set(
        activeApplications.flatMap((application) => [
          application.fromLineId,
          application.toLineId,
        ]),
      ),
    ].filter((id) => !priorLineIds.has(id));
    const outsideRows =
      outsideIds.length === 0
        ? []
        : await tx
            .select()
            .from(schema.journalLines)
            .where(
              and(
                eq(schema.journalLines.orgId, doc.orgId),
                inArray(schema.journalLines.id, outsideIds),
              ),
            );
    const outsideById = new Map(outsideRows.map((line) => [line.id, line]));
    const replacementById = new Map(
      replacementLines.map((line) => [line.id, line]),
    );
    const endpointOf = (lineId: string) => {
      const replacementId = replacementEndpoint(lineId);
      const line =
        replacementById.get(replacementId) ?? outsideById.get(replacementId);
      if (!line) {
        throw new PostingError(
          `cannot transfer application endpoint ${lineId}: the settlement line is missing`,
        );
      }
      return line;
    };
    const magnitude = (value: string): bigint => {
      const units = toUnits(value);
      return units < 0n ? -units : units;
    };
    const transferredLoad = new Map<
      string,
      { toAmount: bigint; toTxn: bigint; fromAmount: bigint; fromTxn: bigint }
    >();
    const loadOf = (id: string) => {
      const load = transferredLoad.get(id) ?? {
        toAmount: 0n,
        toTxn: 0n,
        fromAmount: 0n,
        fromTxn: 0n,
      };
      transferredLoad.set(id, load);
      return load;
    };
    const remappedIds = new Set<string>();
    for (const application of activeApplications) {
      const from = endpointOf(application.fromLineId);
      const to = endpointOf(application.toLineId);
      if (priorLineIds.has(application.fromLineId)) remappedIds.add(from.id);
      if (priorLineIds.has(application.toLineId)) remappedIds.add(to.id);
      if (!from.isOpenItem || !to.isOpenItem) {
        throw new PostingError(
          `source correction of ${doc.documentNumber} cannot transfer application ${application.id}: a replacement endpoint is not an open item — unapply the settlements before correcting`,
        );
      }
      if (
        from.accountId !== to.accountId ||
        (from.partyId ?? null) !== (to.partyId ?? null) ||
        from.subsidiaryId !== to.subsidiaryId
      ) {
        throw new PostingError(
          `source correction of ${doc.documentNumber} cannot transfer application ${application.id}: the replacement endpoints no longer share one account, party, and subsidiary — unapply the settlements before correcting`,
        );
      }
      const fromSign = toUnits(from.amount) > 0n;
      if ((toUnits(to.amount) > 0n) === fromSign) {
        throw new PostingError(
          `source correction of ${doc.documentNumber} cannot transfer application ${application.id}: the replacement endpoints no longer have opposite debit/credit signs — unapply the settlements before correcting`,
        );
      }
      const toLoad = loadOf(to.id);
      toLoad.toAmount += magnitude(application.amount);
      toLoad.toTxn += magnitude(application.targetTransactionAmount);
      const fromLoad = loadOf(from.id);
      fromLoad.fromAmount += magnitude(application.sourceAmount);
      fromLoad.fromTxn += magnitude(application.sourceTransactionAmount);
    }
    for (const id of remappedIds) {
      // Endpoints outside the corrected entry keep their lines and shed load,
      // so only remapped endpoints can newly overflow.
      const line = replacementById.get(id)!;
      const load = loadOf(id);
      const capacity = magnitude(line.amount);
      const txnCapacity = magnitude(line.txnAmount ?? line.amount);
      const breach =
        load.toAmount > capacity
          ? `${fromUnits(load.toAmount)} applied exceeds the replacement line's open ${fromUnits(capacity)}`
          : load.fromAmount > capacity
            ? `${fromUnits(load.fromAmount)} applied exceeds the replacement line's open ${fromUnits(capacity)}`
            : load.toTxn > txnCapacity || load.fromTxn > txnCapacity
              ? `the transferred settlement exceeds the replacement line's transaction amount`
              : null;
      if (breach) {
        throw new PostingError(
          `source correction of ${doc.documentNumber} cannot transfer its live applications onto the corrected entry: ${breach} — unapply the settlements before correcting`,
        );
      }
    }
  }
  const correctedAt = new Date();
  for (const application of activeApplications) {
    const fromLineId = replacementEndpoint(application.fromLineId);
    const toLineId = replacementEndpoint(application.toLineId);
    const released = await tx
      .update(schema.applications)
      .set({
        unappliedAt: correctedAt,
        updatedAt: correctedAt,
        updatedBy: correction.actorId,
      })
      .where(
        and(
          eq(schema.applications.id, application.id),
          eq(schema.applications.orgId, doc.orgId),
          sql`${schema.applications.unappliedAt} is null`,
        ),
      )
      .returning({ id: schema.applications.id });
    if (released.length !== 1) {
      throw new PostingError(
        `application ${application.id} changed during source correction`,
      );
    }
    const replacementApplication = (await tx
      .insert(schema.applications)
      .values({
        orgId: application.orgId,
        fromLineId,
        toLineId,
        amount: application.amount,
        sourceAmount: application.sourceAmount,
        sourceTransactionAmount: application.sourceTransactionAmount,
        sourceTransactionCurrency: application.sourceTransactionCurrency,
        targetTransactionAmount: application.targetTransactionAmount,
        targetTransactionCurrency: application.targetTransactionCurrency,
        settlementRate: application.settlementRate,
        settlementRateSource: application.settlementRateSource,
        settlementRateReference: application.settlementRateReference,
        settlementFxRateId: application.settlementFxRateId,
        appliedOn: application.appliedOn,
        fxGainLossEntryId: application.fxGainLossEntryId,
        createdBy: correction.actorId,
        updatedBy: correction.actorId,
      })
      .returning({ id: schema.applications.id }))[0]!;
    transferredApplications.push({
      priorApplicationId: application.id,
      replacementApplicationId: replacementApplication.id,
      priorFromLineId: application.fromLineId,
      replacementFromLineId: fromLineId,
      priorToLineId: application.toLineId,
      replacementToLineId: toLineId,
    });
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (
          ${doc.orgId}, 'applications', ${application.id}, 'update',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason,
            replacementApplicationId: replacementApplication.id,
            before: { unappliedAt: null },
            after: { unappliedAt: correctedAt.toISOString() },
          })}::jsonb,
          ${correction.actorId}, ${correction.requestId}
        ),
        (
          ${doc.orgId}, 'applications', ${replacementApplication.id}, 'insert',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason,
            priorApplicationId: application.id,
            fromLineId,
            toLineId,
          })}::jsonb,
          ${correction.actorId}, ${correction.requestId}
        )
    `);
  }
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
