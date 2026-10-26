import { assertJournalVoidNotAutomaticallyReversed } from "./journal-reversals.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isDocumentRevisionToken } from "../records/revision.ts";
import { runRecordFlows } from "../flows/run.ts";
import { listReceiptVoidBlockers } from "../inventory/receipt-void-dependents.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import {
  DocumentVoidError,
  assertDocumentVoidable,
  assertPostingEffectsCompleteForVoid,
  loadDocument,
  refuseBilledCostSourceVoid,
  resolveVoidCalendarSubsidiaryId,
  resolveVoidReversalPeriod,
  runBeforeVoidScripts,
  validateDate,
  validateReason,
  type DocumentVoidInput,
  type DocumentVoidResult,
} from "./document-void-shared.ts";
import { suggestVoidReversalDate } from "./document-void-suggestion.ts";
import {
  refuseDrawReleaseBehindLaterDraws,
  refuseUnavailablePayRunVoid,
} from "./document-void-remedies.ts";
import { completeRequestedDocumentVoid } from "./document-void-complete.ts";

/**
 * Request a controlled cancellation/void. `before_void` flow gates are the
 * approval authority. The document remains posted while gates wait; the final
 * aggregate approval invokes completeRequestedDocumentVoid through the
 * documents adapter.
 */
export async function requestDocumentVoid(input: DocumentVoidInput): Promise<DocumentVoidResult> {
  const reason = validateReason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    await lockLedgerSetupFence(db, input.orgId, "shared");
    const current = await loadDocument(input.documentId, input.orgId);
    if (current.kind === "journal")
      await assertJournalVoidNotAutomaticallyReversed(db, input.orgId, input.documentId);
    // Keep the scope decision on the locked source row and hold that lock
    // through reservation, gate creation, and any immediate reversal.
    if (
      input.allowedSubsidiaryIds !== undefined &&
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, current.subsidiaryId)
    ) {
      throw new ScopeNotFoundError();
    }
    // The aggregate lock precedes the read and comparison. A waiter observes
    // the committed revision, including edits that differ by one microsecond.
    if (
      input.expectedUpdatedAt != null &&
      (!isDocumentRevisionToken(input.expectedUpdatedAt) ||
        input.expectedUpdatedAt !== current.revision)
    ) {
      throw new DocumentVoidError(
        "this document changed after you opened it; reload and review the latest revision",
        409,
        "stale-revision",
      );
    }
    // An explicit reversal date is honored as given. Otherwise the reversal
    // belongs to the entry's own date — same period, same fiscal year — and
    // only a closed entry period moves it forward to the first open period
    // after it. Posting today by default once pushed prior-year voids into
    // the wrong fiscal year on both sides.
    const reversalDate = validateDate(
      input.reversalDate ?? (await suggestVoidReversalDate(db, input.orgId, current)).suggestedDate,
    );
    const reversalPeriodId =
      input.reversalPeriodId != null && input.reversalPeriodId !== ""
        ? await resolveVoidReversalPeriod(
            db,
            input.orgId,
            input.reversalPeriodId,
            reversalDate,
            await resolveVoidCalendarSubsidiaryId(
              db,
              input.orgId,
              current.id,
              current.subsidiaryId,
            ),
          )
        : null;
    // A released payroll bank file refuses here, before the reservation:
    // the pay-run document sits in draft while committed, so the zero-row
    // reservation below would otherwise answer with the generic draft/status
    // refusal and the operator would never see the file number or its remedy.
    await refuseUnavailablePayRunVoid(db, input.orgId, input.documentId);
    // A draw invoice/bill whose void would return its draw to approved
    // underneath a later draw refuses here, before the reservation and any
    // approval routing, so the operator sees the later draws named.
    await refuseDrawReleaseBehindLaterDraws(db, input.orgId, input.documentId);
    await refuseBilledCostSourceVoid(db, input.orgId, input.documentId);
    if (current.status === "posted")
      await assertPostingEffectsCompleteForVoid(db, input.orgId, input.documentId);
    // This compare-and-set is the single-winner claim. PostgreSQL locks the
    // aggregate row and rechecks the predicate after a concurrent waiter
    // resumes. Every material before_void effect stays in this same
    // transaction: a throw, disconnect, or process crash rolls the claim,
    // audit, script journal, and flow effects back together, so a retry starts
    // from the original issued document.
    const reserved = await db.execute<{ id: string }>(
      sql`
      update documents
         set void_reason = ${reason},
             void_requested_at = now(),
             void_requested_by = ${input.actorId},
             void_reversal_date = ${reversalDate},
             void_reversal_period_id = ${reversalPeriodId},
             updated_at = now(),
             updated_by = ${input.actorId}
       where id = ${input.documentId} and org_id = ${input.orgId}
         and status in ('approved', 'posted')
         and void_requested_at is null
      returning id
    `,
      "objects",
    );
    if (!reserved[0]) {
      assertDocumentVoidable(current);
      throw new DocumentVoidError(
        `${current.documentNumber} changed while the void request was being created; reload and try again`,
      );
    }
    const doc = current;
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${input.orgId}, 'documents', ${doc.id}, 'update',
        ${JSON.stringify({
          mode: "void_request",
          source: input.source ?? "ui",
          reason,
          reversalDate,
          reversalPeriodId,
          before: { voidRequestedAt: null, voidRequestedBy: null },
          after: { voidRequestedAt: "now", voidRequestedBy: input.actorId },
        })}::jsonb,
        ${input.actorId}, ${input.source ?? "ui"}
      )
    `);

    await runBeforeVoidScripts({ document: doc, orgId: input.orgId, actorId: input.actorId });

    const flows = await runRecordFlows(
      { kind: "before_void", source: input.source ?? "ui" },
      doc.kind,
      doc.id,
      {
        orgId: input.orgId,
        userId: input.actorId,
        allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      },
    );
    if (flows.failed) {
      throw new DocumentVoidError("void approval routing failed; the document was not voided");
    }
    if (flows.gatesCreated > 0) {
      const gatedRun = flows.runs.find((run) => run.gatesCreated > 0);
      return {
        status: "pending_approval",
        reversalEntryId: null,
        runId: gatedRun?.runId ?? flows.runs[0]?.runId ?? null,
      };
    }
    const reversalEntryId = await completeRequestedDocumentVoid(
      doc.id,
      input.orgId,
      input.allowedSubsidiaryIds,
    );
    return { status: "voided", reversalEntryId, runId: null };
  });
}

/**
 * Void a goods receipt together with the dependents consuming its stock.
 * Offered only when every dependent reverses through its own native
 * document void (a voidable sales fulfillment): each dependent voids
 * first through the same controlled path, then the receipt voids — one
 * atomic unit, posted history appended never edited. Any other dependent
 * (a posted invoice's sale, landed cost, custody) refuses with the order
 * of operations instead of a partial cascade.
 */
export async function requestReceiptVoidWithDependents(
  input: DocumentVoidInput,
): Promise<DocumentVoidResult> {
  return withOrgTransaction(input.orgId, async () => {
    await lockLedgerSetupFence(db, input.orgId, "shared");
    const relief = await listReceiptVoidBlockers(db, input.orgId, input.documentId);
    if (relief.blockers.length === 0) return requestDocumentVoid(input);
    if (!relief.allowVoidWithDependents) {
      const steps = relief.blockers.flatMap((blocker) =>
        blocker.dependents.map((dependent) => dependent.reverseAction),
      );
      throw new DocumentVoidError(
        `Void with dependents is unavailable for goods receipt ${relief.receiptNumber}: ` +
          `at least one dependent does not reverse through its own document void. ${steps.join(" ")}`,
        422,
        "receipt-stock-consumed",
        {
          receiptNumber: relief.receiptNumber,
          blockers: relief.blockers,
          allowVoidWithDependents: false,
          remainderQuantity: relief.remainderQuantity,
        },
      );
    }
    const seen = new Set<string>();
    for (const blocker of relief.blockers) {
      for (const dependent of blocker.dependents) {
        const doc = dependent.sourceDocument;
        if (!doc || seen.has(doc.id)) continue;
        seen.add(doc.id);
        const outcome = await requestDocumentVoid({
          documentId: doc.id,
          orgId: input.orgId,
          actorId: input.actorId,
          reason: input.reason,
          reversalDate: input.reversalDate,
          reversalPeriodId: input.reversalPeriodId,
          source: input.source,
          allowedSubsidiaryIds: input.allowedSubsidiaryIds,
        });
        if (outcome.status !== "voided") {
          throw new DocumentVoidError(
            `Void with dependents stopped: ${doc.number} is awaiting approval — approve or reject its void, then retry`,
            409,
            "receipt-stock-consumed",
          );
        }
      }
    }
    return requestDocumentVoid(input);
  });
}

export async function rejectRequestedDocumentVoid(
  documentId: string,
  orgId: string,
  actorId: string | null,
  comment: string | null,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    const locked = await db.execute<{
      id: string;
      void_requested_at: Date | null;
      void_reason: string | null;
      void_requested_by: string | null;
    }>(
      sql`
      select id, void_requested_at, void_reason, void_requested_by
        from documents
       where id = ${documentId} and org_id = ${orgId}
       for update
    `,
      "objects",
    );
    const request = locked[0];
    if (!request?.void_requested_at || !request.void_requested_by || !request.void_reason) {
      throw new DocumentVoidError("the document has no pending void request", 409);
    }

    const cleared = await db.execute<{ id: string }>(
      sql`
      update documents
         set void_requested_at = null,
             void_requested_by = null,
             void_reversal_date = null,
             void_reversal_period_id = null,
             void_reason = null,
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${documentId} and org_id = ${orgId}
         and void_requested_at is not null
         and void_requested_by is not null
         and void_reason is not null
      returning id
    `,
      "objects",
    );
    if (!cleared[0]) {
      throw new DocumentVoidError("the document has no pending void request", 409);
    }
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${orgId}, 'documents', ${request.id}, 'reject',
        ${JSON.stringify({
          mode: "void_request_rejected",
          reason: comment?.trim() || "approval_rejected",
          requestedReason: request.void_reason,
          requestedBy: request.void_requested_by,
        })}::jsonb,
        ${actorId}, 'flows'
      )
    `);
  });
}
