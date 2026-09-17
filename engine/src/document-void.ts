import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { FlowEventSource } from "@openbooks/forms-core";
import { db, schema, withOrgTransaction } from "./db.ts";
import { documentRevisionCounterSql, isDocumentRevisionToken } from "./document-revision.ts";
import { businessToday, isIsoCalendarDate } from "./business-date.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  closeModuleForDocument,
} from "./close.ts";
import { nextFreeEntryNumber } from "./entry-number.ts";
import { reversalJournalLines } from "./reversal-journal-lines.ts";
import { emitStatusChange, runRecordFlows } from "./flows/run.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "./transaction-audit.ts";
import { releaseCamBillingProvenance, releaseBillingProvenance, releaseConvertedOrderQuantities, releaseVendorBillProvenance } from "./billing-provenance.ts";
import { projectRetainageHeldSql } from "./construction-billing.ts";
import { add, cmp, neg } from "./money.ts";
import { InventoryError, reverseInventoryMovement } from "./inventory.ts";

/**
 * Machine-readable void refusal reasons (F-t06-021). The human message
 * travels unchanged in `message`; `code` lets callers branch — the journal
 * drawer maps the three actionable refusals to localized copy instead of
 * toasting raw kernel text. Every other refusal is `invalid`.
 */
export type DocumentVoidCode =
  | "invalid"
  | "stale-revision"
  | "reversal-period-uncovered"
  | "reversal-period-closed";

export class DocumentVoidError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code: DocumentVoidCode = "invalid",
  ) { super(message); }
}

/** NOWAIT pre-lock contention anywhere in the cause chain (55P03 lock_not_available). */
function isLockNotAvailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: string }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Provenance ids travel as text; validate the shape before any uuid[] cast. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentVoidResult {
  status: "voided" | "pending_approval";
  reversalEntryId: string | null;
  runId: string | null;
}

/**
 * Optimistic-concurrency token from documents.revision_seq. When supplied, the
 * void refuses unless the caller's view is still the stored revision — a stale
 * dashboard must not cancel a document it never saw (edits, applications, or
 * an approval that landed after it loaded). The comparison happens inside the
 * claim transaction against the row the claim itself locks.
 */
export type DocumentVoidInput = {
  documentId: string;
  orgId: string;
  actorId: string;
  reason: string;
  reversalDate?: string | null;
  source?: FlowEventSource;
  expectedUpdatedAt?: string | null;
};

function validateReason(reason: string): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 5 || value.length > 500) {
    throw new DocumentVoidError("a void reason between 5 and 500 characters is required");
  }
  return value;
}

function validateDate(value: string): string {
  if (!isIsoCalendarDate(value)) {
    throw new DocumentVoidError("reversalDate must be a valid YYYY-MM-DD date");
  }
  return value;
}

type DocumentRow = typeof schema.documents.$inferSelect & { revision: string };

async function loadDocument(documentId: string, orgId: string): Promise<DocumentRow> {
  const [doc] = await db
    .select({ ...getTableColumns(schema.documents), revision: documentRevisionCounterSql(sql`revision_seq`) })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
    .for("update");
  if (!doc) throw new DocumentVoidError("document not found");
  return doc;
}

function assertDocumentVoidable(doc: DocumentRow): void {
  if (!["approved", "posted"].includes(doc.status)) {
    throw new DocumentVoidError(
      `${doc.documentNumber} is ${doc.status}; only issued or posted documents can be voided`,
    );
  }
  if (doc.voidRequestedAt) {
    throw new DocumentVoidError(`${doc.documentNumber} already has a pending void request`);
  }
}

/**
 * Run only after requestDocumentVoid owns the document's conditional
 * reservation. The caller's transaction must remain active so script_runs and
 * ob.journal.create participate in the same atomic unit as the reservation.
 * ob.query alone checks out from the physically separate governed READ ONLY
 * pool, so ten contending request transactions cannot form a pool cycle.
 */
async function runBeforeVoidScripts(input: {
  document: DocumentRow;
  orgId: string;
}): Promise<void> {
  const doc = input.document;
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, input.orgId));
  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, doc.id), eq(schema.documentLines.orgId, input.orgId)));
  if (!org) throw new DocumentVoidError("organization not found");
  const scriptCtx: ScriptContext = {
    trigger: "before_void",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };
  const outcomes = await runTriggerScripts("before_void", scriptCtx, doc.id);
  const bad = outcomes.find((outcome) => outcome.status !== "ok");
  if (bad) {
    throw new DocumentVoidError(
      bad.status === "aborted"
        ? `voiding vetoed by script "${bad.name}": ${bad.abortReason}`
        : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
    );
  }
}

/**
 * Request a controlled cancellation/void. `before_void` flow gates are the
 * approval authority. The document remains posted while gates wait; the final
 * aggregate approval invokes completeRequestedDocumentVoid through the
 * documents adapter.
 */
export async function requestDocumentVoid(
  input: DocumentVoidInput,
): Promise<DocumentVoidResult> {
  const reason = validateReason(input.reason);
  // Business-meaningful default date — the org's business day via a sim-clock-
  // aware instant, not the server's UTC day.
  const reversalDate = validateDate(input.reversalDate ?? (await businessToday(input.orgId)));
  return withOrgTransaction(input.orgId, async () => {
    const current = await loadDocument(input.documentId, input.orgId);
    // The aggregate lock precedes the read and comparison. A waiter observes
    // the committed revision, including edits that differ by one microsecond.
    if (input.expectedUpdatedAt != null &&
        (!isDocumentRevisionToken(input.expectedUpdatedAt) || input.expectedUpdatedAt !== current.revision)) {
      throw new DocumentVoidError(
        "this document changed after you opened it; reload and review the latest revision", 409,
        "stale-revision",
      );
    }
    // This compare-and-set is the single-winner claim. PostgreSQL locks the
    // aggregate row and rechecks the predicate after a concurrent waiter
    // resumes. Every material before_void effect stays in this same
    // transaction: a throw, disconnect, or process crash rolls the claim,
    // audit, script journal, and flow effects back together, so a retry starts
    // from the original issued document.
    const reserved = (await db.execute<{ id: string }>(sql`
      update documents
         set void_reason = ${reason},
             void_requested_at = now(),
             void_requested_by = ${input.actorId},
             void_reversal_date = ${reversalDate},
             updated_at = now(),
             updated_by = ${input.actorId}
       where id = ${input.documentId} and org_id = ${input.orgId}
         and status in ('approved', 'posted')
         and void_requested_at is null
      returning id
    `));
    if (!reserved.rows[0]) {
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
          before: { voidRequestedAt: null, voidRequestedBy: null },
          after: { voidRequestedAt: "now", voidRequestedBy: input.actorId },
        })}::jsonb,
        ${input.actorId}, ${input.source ?? "ui"}
      )
    `);

    await runBeforeVoidScripts({ document: doc, orgId: input.orgId });

    const flows = await runRecordFlows(
      { kind: "before_void", source: input.source ?? "ui" },
      doc.kind,
      doc.id,
      { orgId: input.orgId, userId: input.actorId },
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
    const reversalEntryId = await completeRequestedDocumentVoid(doc.id, input.orgId);
    return { status: "voided", reversalEntryId, runId: null };
  });
}

/**
 * Unwind one shipment (sales_fulfillment) or goods receipt
 * (purchase_receipt) inside the caller's void transaction: reverse every
 * still-live stock movement through the inventory kernel and restore the
 * source order lines' fulfilled counters, so the quantities can ship or be
 * received again and no stock is stranded.
 *
 * Only movements with no reversal row count as live: the kernel keeps the
 * original movement posted and records the reversal as a separate `return`
 * movement, so an already-reversed leg is never reversed twice. A refused
 * unwind names its real blocker (billed quantities, missing provenance, or
 * the kernel's own reason such as downstream inventory activity).
 */
async function reverseOrderShipment(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    voidDocumentId: string;
    voidKind: string;
    actorId: string;
    reversalDate: string;
    reason: string;
  },
): Promise<void> {
  const evidenceKey = input.voidKind === "sales_fulfillment" ? "fulfillment" : "receipt";
  const movementKind = input.voidKind === "sales_fulfillment" ? "issue" : "receipt";
  const voidQtyBySource = (await tx.execute<{
    source_line_id: string | null;
    void_quantity: string;
  }>(sql`
    select l.custom->${evidenceKey}->>'sourceLineId' as source_line_id,
           sum(l.quantity)::text as void_quantity
      from document_lines l
     where l.document_id = ${input.voidDocumentId} and l.org_id = ${input.orgId}
     group by 1
  `));
  if (voidQtyBySource.rows.some((row) => !row.source_line_id)) {
    throw new DocumentVoidError(
      "this document has a line without order-line provenance — correct the line before voiding",
    );
  }
  if (voidQtyBySource.rows.length > 0) {
    const sources = voidQtyBySource.rows as { source_line_id: string; void_quantity: string }[];
    // Malformed legacy provenance must refuse as a controlled void error,
    // never as a raw SQL cast failure from the uuid[] predicates below.
    for (const source of sources) {
      if (!UUID_SHAPE.test(source.source_line_id)) {
        throw new DocumentVoidError(
          "this document has a line with malformed order-line provenance — correct the line before voiding",
        );
      }
    }
    const expectedOrderKind =
      input.voidKind === "sales_fulfillment" ? "sales_order" : "purchase_order";
    const idArr = `{${sources.map((row) => row.source_line_id).join(",")}}`;
    // Lock source headers before their lines (the order-cycle lock order),
    // then the lines, so concurrent fulfill/receive commands serialize.
    const orders = (await tx.execute<{ id: string; status: string; kind: string }>(sql`
      select d.id, d.status, d.kind
        from documents d
       where d.org_id = ${input.orgId}
         and d.id in (
           select l.document_id from document_lines l
            where l.org_id = ${input.orgId} and l.id = any(${idArr}::uuid[])
         )
       order by d.id
       for update
    `));
    for (const order of orders.rows) {
      if (order.kind !== expectedOrderKind) {
        throw new DocumentVoidError(
          "a source line does not belong to an order of the expected kind — correct the line before voiding",
        );
      }
    }
    const orderByLine = new Map<string, { id: string; status: string; kind: string }>();
    for (const order of orders.rows) {
      const lineIds = (await tx.execute<{ id: string }>(sql`
        select l.id from document_lines l
         where l.org_id = ${input.orgId} and l.document_id = ${order.id}
           and l.id = any(${idArr}::uuid[])
      `));
      for (const line of lineIds.rows) orderByLine.set(line.id, order);
    }
    if (orderByLine.size !== sources.length) {
      throw new DocumentVoidError("a source order line for this document is missing");
    }
    const sourceLines = (await tx.execute<{ id: string }>(sql`
      select l.id from document_lines l
       where l.org_id = ${input.orgId} and l.id = any(${idArr}::uuid[])
       order by l.id
       for update of l
    `));
    if (sourceLines.rows.length !== sources.length) {
      throw new DocumentVoidError("a source order line changed while it was being voided");
    }
    for (const source of sources) {
      const order = orderByLine.get(source.source_line_id)!;
      if (order.status !== "approved") {
        throw new DocumentVoidError("the source order is no longer approved — resolve it before voiding");
      }
      // Restoring the counter must neither drive fulfilled negative nor cut
      // into already-billed quantities; both are decided in storage arithmetic.
      const cover = (await tx.execute<{ restorable: boolean; billed_block: boolean }>(sql`
        select (quantity_fulfilled - ${source.void_quantity}::numeric) >= 0 as restorable,
               (quantity_fulfilled - ${source.void_quantity}::numeric) < quantity_billed as billed_block
          from document_lines where id = ${source.source_line_id} and org_id = ${input.orgId}
      `)).rows[0]!;
      if (!cover.restorable) {
        throw new DocumentVoidError("voiding would drive a source line below zero fulfilled");
      }
      if (cover.billed_block) {
        throw new DocumentVoidError(
          "this document's quantities are already billed — reverse the invoice or bill first",
        );
      }
    }
    // Before-evidence for every source order whose counters are about to
    // move: captured under the locks above, before any counter or movement
    // write in this unwind.
    const beforeSnapshots = new Map<string, TransactionAuditSnapshot>();
    for (const order of orders.rows) {
      const snapshot = await captureTransactionAuditSnapshot(tx, order.id, input.orgId);
      if (!snapshot) throw new DocumentVoidError("a source order disappeared while it was being voided");
      beforeSnapshots.set(order.id, snapshot);
    }
    const liveMovements = (await tx.execute<{ id: string }>(sql`
      select movement.id
        from inventory_movements movement
        join document_lines line
          on line.id = movement.document_line_id and line.org_id = movement.org_id
       where movement.org_id = ${input.orgId}
         and line.document_id = ${input.voidDocumentId}
         and movement.kind = ${movementKind}
         and movement.status = 'posted'
         and not exists (
           select 1 from inventory_movements reversal
            where reversal.org_id = movement.org_id
              and reversal.reverses_movement_id = movement.id
         )
       order by movement.id
       for update of movement
    `));
    for (const movement of liveMovements.rows) {
      try {
        await reverseInventoryMovement(input.orgId, input.actorId, {
          movementId: movement.id,
          reversalDate: input.reversalDate,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof InventoryError) {
          throw new DocumentVoidError(
            `this document cannot be voided yet — ${error.message}`,
          );
        }
        throw error;
      }
    }
    // Approved lines are storage-immutable (migration 0034): restoring the
    // fulfilled counter is operational reconciliation state, not a
    // commercial edit. Reopen each source header while its counters restore
    // (the established order-cycle pattern), then restore approved status.
    for (const order of orders.rows) {
      const reopened = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'draft', updated_by = ${input.actorId}
         where id = ${order.id} and org_id = ${input.orgId} and status = 'approved'
        returning id
      `)).rows[0];
      if (!reopened) throw new DocumentVoidError("the source order changed while it was being voided");
      for (const source of sources.filter((row) => orderByLine.get(row.source_line_id)!.id === order.id)) {
        const restored = (await tx.execute<{ id: string }>(sql`
          update document_lines
             set quantity_fulfilled = quantity_fulfilled - ${source.void_quantity}::numeric,
                 updated_by = ${input.actorId}
           where id = ${source.source_line_id} and org_id = ${input.orgId}
             and quantity_fulfilled - ${source.void_quantity}::numeric >= 0
          returning id
        `)).rows[0];
        if (!restored) throw new DocumentVoidError("a source order line changed while it was being voided");
      }
      const restored = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'approved', updated_by = ${input.actorId}
         where id = ${order.id} and org_id = ${input.orgId} and status = 'draft'
        returning id
      `)).rows[0];
      if (!restored) throw new DocumentVoidError("the source order changed while it was being voided");
    }
    // After-evidence pairs each source order's before snapshot: the void's
    // reason and actor travel on the envelope like the shipment's own.
    for (const order of orders.rows) {
      const after = await captureTransactionAuditSnapshot(tx, order.id, input.orgId);
      await recordTransactionAudit(tx, {
        orgId: input.orgId,
        documentId: order.id,
        action: "update",
        actorId: input.actorId,
        source: "controlled_void",
        reason: input.reason,
        before: beforeSnapshots.get(order.id)!,
        after,
      });
    }
  }
}

/**
 * Retainage lifecycle fence for source reversal. A posted draw invoice/bill
 * whose holdback supports live retainage releases cannot be voided out from
 * under them. Capacity semantics mirror release creation on each side:
 *
 * - Customer: held retainage is GL money (posted + reversed entries net), so
 *   posted releases are already sunk in the held balance and must NOT be
 *   counted again — only pending (not yet posted, not voided) releases can be
 *   stranded. A void that would drive the held balance itself negative is
 *   still refused, because a pending count of zero is greater than negative
 *   availability.
 * - Vendor: held retainage is subledger money (posted billed applications),
 *   which never nets posted releases, so every non-voided release bill counts.
 *
 * Runs inside the caller's void transaction after the document lock is held,
 * taking the same project/subcontract row lock release creation takes, so a
 * concurrent release cannot reserve the support being removed. Draft deletes
 * need no equivalent: drafts never contribute to held money on either side.
 */
async function assertRetainageDrawVoidable(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const kind = String(doc.kind);
  if (kind !== "customer_invoice" && kind !== "vendor_bill") return;
  if (doc.posted_entry_id == null) return;
  const control = (await tx.execute<{ account: string | null }>(sql`
    select settings->'controlAccounts'->>${kind === "customer_invoice" ? "retainageReceivable" : "retainagePayable"} as account
      from orgs where id = ${orgId}
  `)).rows[0]?.account;
  if (!control) return;
  if (kind === "customer_invoice") {
    // Support removed, per project: the negative retainage-receivable lines
    // this void reverses. A release invoice carries a positive line, so it
    // never matches and reverses freely.
    const removed = (await tx.execute<{ project_id: string; removed: string }>(sql`
      select project_id, coalesce(sum(-amount), 0)::text as removed
        from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
         and account_id = ${control}::uuid and amount < 0
       group by project_id
    `)).rows.filter((row) => cmp(row.removed, "0") > 0);
    for (const { project_id: projectId, removed: drawSupport } of removed) {
      await tx.execute(sql`select id from projects where org_id = ${orgId} and id = ${projectId} for update`);
      const held = String(
        (await tx.execute<{ held: string | number }>(projectRetainageHeldSql(orgId, projectId, control))).rows[0]?.held ?? "0",
      );
      const pending = (await tx.execute<{ reserved: string; release_number: string | null }>(sql`
        select coalesce(sum(d.total), 0)::text as reserved, min(d.document_number) as release_number
          from pay_applications pa
          join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
         where pa.org_id = ${orgId} and pa.project_id = ${projectId} and pa.kind = 'retainage_release'
           and pa.status in ('invoiced', 'posted') and d.status not in ('posted', 'voided')
      `)).rows[0];
      if (cmp(String(pending?.reserved ?? "0"), add(held, neg(drawSupport))) > 0) {
        throw new DocumentVoidError(
          `this application supports retainage release ${pending?.release_number ?? "(pending)"} — reverse the retainage release first`,
        );
      }
    }
    return;
  }
  // Vendor draw bill: support is the billed application's retained amount,
  // which leaves held money when the void returns the application to approved.
  const draws = (await tx.execute<{ subcontract_id: string; support: string }>(sql`
    select vpa.subcontract_id, coalesce(sum(vpa.retainage_this_period), 0)::text as support
      from vendor_pay_applications vpa
     where vpa.org_id = ${orgId} and vpa.vendor_bill_document_id = ${documentId} and vpa.status = 'billed'
     group by vpa.subcontract_id
  `)).rows.filter((row) => cmp(row.support, "0") > 0);
  for (const { subcontract_id: subcontractId, support: drawSupport } of draws) {
    await tx.execute(sql`select id from subcontracts where org_id = ${orgId} and id = ${subcontractId} for update`);
    const balance = (await tx.execute<{ held: string; released: string; release_number: string | null }>(sql`
      select coalesce(sum(case when d.status = 'posted' then vpa.retainage_this_period else 0 end), 0)::text as held,
             coalesce((select sum(vrr.amount) from vendor_retainage_releases vrr
                        join documents rd on rd.id = vrr.vendor_bill_document_id and rd.org_id = vrr.org_id
                       where vrr.org_id = ${orgId} and vrr.subcontract_id = ${subcontractId} and rd.status <> 'voided'), 0)::text as released,
             (select min(rd.document_number) from vendor_retainage_releases vrr
                join documents rd on rd.id = vrr.vendor_bill_document_id and rd.org_id = vrr.org_id
               where vrr.org_id = ${orgId} and vrr.subcontract_id = ${subcontractId} and rd.status <> 'voided') as release_number
        from vendor_pay_applications vpa
        left join documents d on d.id = vpa.vendor_bill_document_id and d.org_id = vpa.org_id
       where vpa.org_id = ${orgId} and vpa.subcontract_id = ${subcontractId} and vpa.status = 'billed'
    `)).rows[0];
    if (cmp(String(balance?.released ?? "0"), add(String(balance?.held ?? "0"), neg(drawSupport))) > 0) {
      throw new DocumentVoidError(
        `this subcontract draw supports retainage release ${balance?.release_number ?? "(pending)"} — reverse the retainage release first`,
      );
    }
  }
}

/**
 * Complete a previously stored request. Called directly when no gate exists,
 * or by the flow adapter after the final configured approval.
 */
export async function completeRequestedDocumentVoid(
  documentId: string,
  orgId: string,
): Promise<string | null> {
  return withOrgTransaction(orgId, async () => {
    const result: {
      reversalEntryId: string | null;
      kind: string;
      previousStatus: string;
    } = await db.transaction(async (tx) => {
      const locked = (await tx.execute<Record<string, unknown>>(sql`
        select *
          from documents
         where id = ${documentId} and org_id = ${orgId}
         for update
      `));
      const doc = locked.rows[0];
      if (!doc) throw new DocumentVoidError("document not found");
      if (doc.status === "voided") {
        return {
          reversalEntryId: String(doc.reversal_entry_id ?? "") || null,
          kind: String(doc.kind),
          previousStatus: "voided",
        };
      }
      if (!doc.void_requested_at || !doc.void_requested_by || !doc.void_reason) {
        throw new DocumentVoidError("the document has no pending void request");
      }
      if (!["approved", "posted"].includes(String(doc.status))) {
        throw new DocumentVoidError(`a ${String(doc.status)} document cannot be voided`);
      }

      // Downstream fence for every kind. A document that feeds a live
      // downstream document cannot be voided out from under it. This guard
      // used to run only inside `if (entryId)` below, so non-posting order
      // documents (quotes, orders, shipments, receipts — never carrying a
      // posted entry) skipped it entirely.
      const downstream = (await tx.execute<{ document_number: string }>(sql`
        select d2.document_number
          from document_links dl
          join documents d2 on d2.id = dl.to_document_id and d2.org_id = dl.org_id
         where dl.from_document_id = ${documentId} and dl.org_id = ${orgId}
           and d2.status in ('approved', 'posted')
           and dl.link_type <> 'pays'
         limit 1
      `));
      if (downstream.rows[0]) {
        throw new DocumentVoidError(
          `this transaction feeds ${downstream.rows[0].document_number} — reverse the downstream transaction first`,
        );
      }

      // Retainage lifecycle fence. A draw invoice/bill whose holdback supports
      // live retainage releases cannot be voided out from under them: the void
      // would erase held funds the releases already consumed or reserved.
      // Reverse the dependent releases first, then void the draw.
      await assertRetainageDrawVoidable(tx, orgId, documentId, doc);

      if (String(doc.kind) === "sales_fulfillment" || String(doc.kind) === "purchase_receipt") {
        // Voiding a shipment or goods receipt unwinds it completely in this
        // transaction: live stock movements are reversed through the
        // inventory kernel and the source order's fulfilled counters are
        // restored, so the quantities can ship again and no relieved stock
        // is stranded. A refused unwind names its real blocker.
        await reverseOrderShipment(tx, {
          orgId,
          voidDocumentId: documentId,
          voidKind: String(doc.kind),
          actorId: String(doc.void_requested_by),
          reversalDate: String(doc.void_reversal_date),
          reason: String(doc.void_reason),
        });
      }

      const before = await captureTransactionAuditSnapshot(tx, documentId, orgId);
      if (!before) throw new DocumentVoidError("document not found");
      const entryId = doc.posted_entry_id ? String(doc.posted_entry_id) : null;
      let reversalEntryId: string | null = null;

      if (entryId) {
        // Serialize against application writers on this entry's lines before
        // any guard below reads. Manual posts, the settlement mirror, and the
        // applications trigger itself all take these same single-table
        // id-ordered endpoint row locks before reading open state — without
        // this lock a writer could commit between the reconciliation /
        // live-application checks and the reversal writes, settling money
        // onto freshly reversed lines (or failing a whole mirror batch on
        // the commit-time guard).
        //
        // NOWAIT, deliberately: a blocking lock here deadlocks against those
        // same writers, because every application insert's open-balance
        // trigger locks the target document row while this void already holds
        // it (endpoints one way, the document the other — a true cycle no
        // acquisition order can fix). Failing fast with a retryable refusal
        // keeps the void deadlock-free: the in-flight writer always finishes
        // first and the retry then sees its committed state.
        try {
          await tx.execute(sql`
            select id
              from journal_lines
             where entry_id = ${entryId} and org_id = ${orgId}
             order by id
             for update nowait
          `);
        } catch (error) {
          if (isLockNotAvailable(error)) {
            throw new DocumentVoidError(
              "another posting to this transaction is in flight — retry the void once it completes",
              409,
            );
          }
          throw error;
        }
        const reconciled = (await tx.execute(sql`
          select 1
            from reconciliation_matches rm
           where rm.org_id = ${orgId}
             and rm.journal_line_id in (
             select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
           )
           limit 1
        `));
        if (reconciled.rows.length > 0) {
          throw new DocumentVoidError(
            "this transaction is bank-reconciled — remove the reconciliation match before voiding",
          );
        }
        const incoming = (await tx.execute(sql`
          select 1
            from applications a
           where a.org_id = ${orgId} and a.unapplied_at is null
             and a.to_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
           limit 1
        `));
        if (incoming.rows.length > 0) {
          throw new DocumentVoidError(
            "this transaction has live payments or credits applied to it — unapply them before voiding",
          );
        }
        const dependentSubledger = (await tx.execute<{ inventory: boolean; revenue: boolean }>(sql`
          select
            exists (
              select 1
                from inventory_movements movement
               where movement.org_id = ${orgId}
                 and movement.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
            ) as inventory,
            exists (
              select 1
                from performance_obligations obligation
               where obligation.org_id = ${orgId}
                 and obligation.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
                 and obligation.status <> 'cancelled'
            ) as revenue
        `));
        if (dependentSubledger.rows[0]?.inventory || dependentSubledger.rows[0]?.revenue) {
          throw new DocumentVoidError(
            "this transaction has inventory or revenue-recognition subledger activity — use the dedicated return/cancellation workflow",
          );
        }

        const entryResult = (await tx.execute<Record<string, unknown>>(sql`
          select * from journal_entries
           where id = ${entryId} and org_id = ${orgId}
           for update
        `));
        const entry = entryResult.rows[0];
        if (!entry || entry.status !== "posted") {
          throw new DocumentVoidError("the source journal entry is not posted");
        }
        const reversalDate = String(doc.void_reversal_date);
        const period = (await tx.execute<{ id: string }>(sql`
          select id
            from accounting_periods
           where org_id = ${orgId}
             and starts_on <= ${reversalDate}
             and ends_on >= ${reversalDate}
           order by is_adjustment, starts_on
           limit 1
        `));
        if (!period.rows[0]) {
          throw new DocumentVoidError(
            `no accounting period covers ${reversalDate} — generate the period covering that date, then void again`,
            422,
            "reversal-period-uncovered",
          );
        }
        const subsidiaries = (await tx.execute<{ subsidiary_id: string }>(sql`
          select distinct subsidiary_id
            from journal_lines
           where entry_id = ${entryId} and org_id = ${orgId}
        `));
        try {
          await assertPeriodModulesOpen(tx, {
            orgId,
            periodId: period.rows[0].id,
            bookId: String(entry.book_id),
            subsidiaryIds: subsidiaries.rows.map((row) => row.subsidiary_id),
            modules: [closeModuleForDocument(String(doc.kind))],
          });
        } catch (error) {
          if (error instanceof CloseError) {
            throw new DocumentVoidError(
              `the reversal period for ${reversalDate} is closed: ${error.message}`,
              422,
              "reversal-period-closed",
            );
          }
          throw error;
        }

        const outgoingFx = (await tx.execute<{ id: string }>(sql`
          select distinct a.fx_gain_loss_entry_id as id
            from applications a
           where a.org_id = ${orgId} and a.unapplied_at is null
             and a.fx_gain_loss_entry_id is not null
             and a.from_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
        `));
        await tx.execute(sql`
          update applications
             set unapplied_at = now(), updated_at = now(),
                 updated_by = ${String(doc.void_requested_by)}
           where org_id = ${orgId} and unapplied_at is null
             and from_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
        `);

        const reverseEntry = async (
          sourceEntryId: string,
          suffix: string,
        ): Promise<string> => {
          const sourceResult = (await tx.execute<Record<string, unknown>>(sql`
            select * from journal_entries
             where id = ${sourceEntryId} and org_id = ${orgId}
             for update
          `));
          const source = sourceResult.rows[0];
          if (!source || source.status !== "posted") {
            throw new DocumentVoidError("linked posted entry is missing or already reversed");
          }
          const lines = await tx
            .select()
            .from(schema.journalLines)
            .where(and(eq(schema.journalLines.entryId, sourceEntryId), eq(schema.journalLines.orgId, orgId)));
          const reversal = (await tx
            .insert(schema.journalEntries)
            .values({
              orgId,
              bookId: String(source.book_id),
              subsidiaryId: String(source.subsidiary_id),
              entryNumber: await nextFreeEntryNumber(
                tx,
                orgId,
                `${String(source.entry_number)}-${suffix}`,
              ),
              postingDate: reversalDate,
              periodId: period.rows[0]!.id,
              memo: `Reversal: ${String(doc.void_reason)}`,
              status: "draft",
              sourceDocumentId: documentId,
              origin: source.origin as typeof schema.journalEntries.$inferInsert["origin"],
              reversesEntryId: sourceEntryId,
              createdBy: String(doc.void_requested_by),
              updatedBy: String(doc.void_requested_by),
            })
            .returning({ id: schema.journalEntries.id }))[0]!;
          await tx.insert(schema.journalLines).values(
            reversalJournalLines(lines, { entryId: reversal.id, orgId }),
          );
          await tx
            .update(schema.journalEntries)
            .set({
              status: "posted",
              postedAt: new Date(),
              postedBy: String(doc.void_requested_by),
            })
            .where(and(eq(schema.journalEntries.id, reversal.id), eq(schema.journalEntries.orgId, orgId)));
          await tx
            .update(schema.journalEntries)
            .set({
              status: "reversed",
              updatedAt: new Date(),
              updatedBy: String(doc.void_requested_by),
            })
            .where(and(eq(schema.journalEntries.id, sourceEntryId), eq(schema.journalEntries.orgId, orgId)));
          return reversal.id;
        };

        reversalEntryId = await reverseEntry(entryId, "VOID");
        for (const fx of outgoingFx.rows) {
          await reverseEntry(fx.id, "VOID");
        }
        // Post-mode allocations in secondary books live in their own
        // origin='allocation' entries on the same document. Voiding the
        // document must mirror those too, or the secondary books would keep
        // attributed balances the primary books reversed away.
        const linkedAllocations = (await tx.execute<{ id: string; book_id: string }>(sql`
          select id, book_id
            from journal_entries
           where org_id = ${orgId} and source_document_id = ${documentId}
             and origin = 'allocation' and status = 'posted'
           order by id
           for update
        `));
        for (const linked of linkedAllocations.rows) {
          const linkedSubs = (await tx.execute<{ subsidiary_id: string }>(sql`
            select distinct subsidiary_id
              from journal_lines
             where entry_id = ${linked.id} and org_id = ${orgId}
          `));
          try {
            await assertPeriodModulesOpen(tx, {
              orgId,
              periodId: period.rows[0]!.id,
              bookId: linked.book_id,
              subsidiaryIds: linkedSubs.rows.map((row) => row.subsidiary_id),
              modules: [closeModuleForDocument(String(doc.kind))],
            });
          } catch (error) {
            if (error instanceof CloseError) {
              throw new DocumentVoidError(
                `the reversal period for ${reversalDate} is closed: ${error.message}`,
              );
            }
            throw error;
          }
          await reverseEntry(linked.id, "VOID");
        }
      }

      if (String(doc.kind) === "customer_invoice" || String(doc.kind) === "customer_credit") {
        await releaseCamBillingProvenance(tx, orgId, documentId, { actorId: String(doc.void_requested_by), reason: String(doc.void_reason) });
      }
      if (String(doc.kind) === "customer_invoice") {
        await releaseBillingProvenance(tx, orgId, documentId, { actorId: String(doc.void_requested_by), reason: String(doc.void_reason) });
      }
      if (String(doc.kind) === "vendor_bill") {
        await releaseVendorBillProvenance(tx, orgId, documentId);
      }
      if (String(doc.kind) === "pay_run") {
        await releaseVoidedPayRun(tx, orgId, documentId);
      }
      // A voided child returns its conversion/capture cover to the source
      // order lines, so the remainder is convertible and billable again. A
      // no-op for documents without that provenance (fulfillments, payments,
      // standalone bills) and for legacy children converted before it existed.
      await releaseConvertedOrderQuantities(tx, orgId, documentId, {
        actorId: String(doc.void_requested_by),
        reason: String(doc.void_reason),
        source: "controlled_void",
      });
      await tx.execute(sql`
        update documents
           set status = 'voided',
               voided_at = now(),
               voided_by = ${String(doc.void_requested_by)},
               reversal_entry_id = ${reversalEntryId},
               open_balance = null,
               void_requested_at = null,
               void_requested_by = null,
               void_reversal_date = null,
               updated_at = now(),
               updated_by = ${String(doc.void_requested_by)}
         where id = ${documentId} and org_id = ${orgId}
      `);
      const after = await captureTransactionAuditSnapshot(tx, documentId, orgId);
      if (!after) throw new DocumentVoidError("document disappeared while voiding");
      await recordTransactionAudit(tx, {
        orgId,
        documentId,
        action: "void",
        actorId: String(doc.void_requested_by),
        source: "controlled_void",
        reason: String(doc.void_reason),
        before,
        after,
      });
      return {
        reversalEntryId,
        kind: String(doc.kind),
        previousStatus: String(doc.status),
      };
    });
    await emitStatusChange(
      result.kind,
      documentId,
      { from: result.previousStatus, to: "voided" },
      { orgId },
    );
    return result.reversalEntryId;
  });
}

/**
 * Un-count a voided pay run.
 *
 * Reversing the GL is not enough for payroll: the payroll subledger is
 * `pay_runs` + `pay_stubs`, and EVERY consumer of it selects on
 * `pay_runs.run_status = 'committed'` with no predicate on the document's
 * status. Leaving a voided run committed therefore keeps it counted in
 * statutory year-to-date (CPP/CPP2/EI room, US wage bases), WCB annual room,
 * the EHT exemption, T4/T4 Summary/W-2/941 and the remittance summary — so the
 * next run under-deducts against consumed room and the CRA is billed for
 * withholdings that no longer exist. One status write retires the run from all
 * of them at once.
 *
 * The two other claims a commit made must also be released:
 *
 * - `time_entries.payroll_batch_ref` — commit stamps the period's approved
 *   hours with the run id so they are never paid twice. If the void left the
 *   stamp, those hours could never be paid at all.
 * - `entitlement_ledger` movements keyed to the run (vacation/banked-hours
 *   accruals and payouts). Balances are SUM(ledger) with no run-status
 *   predicate, so a voided accrual would stay in the employee's bank. These are
 *   REVERSED, not deleted, dated on the same reversal date as the GL entry so
 *   the entitlement liability and its GL account move together.
 *
 * A run that has been PAID needs no special handling here: the payment applies
 * to the run's open net-pay items, so the generic "live payments or credits
 * applied" guard above already refuses the void.
 */
async function releaseVoidedPayRun(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
): Promise<void> {
  // A posted remittance bill is an AP payment obligation backed by this
  // run's accrued liabilities. Refuse the source void until that bill is
  // itself reversed; otherwise the bill would remain payable after the
  // payroll subledger has been removed from statutory YTD and the next
  // remittance could pay the same money twice. Locking the bill rows gives
  // this check the same ordering as posting's remittance freshness guard.
  const covered = (await tx.execute<{ document_number: string }>(sql`
    select bill.document_number
      from pay_runs r
      join documents bill
        on bill.org_id = r.org_id and bill.kind = 'vendor_bill' and bill.status = 'posted'
       and bill.custom ? 'payrollRemittance'
       and bill.custom->'payrollRemittance'->>'from' <= r.pay_date::text
       and bill.custom->'payrollRemittance'->>'to' >= r.pay_date::text
     where r.org_id = ${orgId} and r.document_id = ${documentId}
     order by bill.created_at, bill.id
     limit 1
     for update of bill
  `)).rows[0];
  if (covered) {
    throw new DocumentVoidError(
      `this pay run is covered by posted payroll remittance bill ${covered.document_number}; void the remittance bill first`,
    );
  }

  const run = (await tx.execute<{ document_id: string }>(sql`
    update pay_runs
       set run_status = 'voided', updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId}
       and run_status <> 'voided'
     returning document_id
  `));
  if (run.rows.length === 0) return; // already released (idempotent replay)

  await tx.execute(sql`
    update time_entries
       set payroll_batch_ref = null, updated_at = now()
     where org_id = ${orgId} and payroll_batch_ref = ${documentId}
  `);

  await tx.execute(sql`
    insert into entitlement_ledger
      (org_id, plan_id, employee_party_id, movement_date, amount, hours, kind,
       pay_run_document_id, note, created_by, updated_by)
    select l.org_id, l.plan_id, l.employee_party_id,
           (select void_reversal_date from documents
             where id = ${documentId} and org_id = ${orgId}),
           -sum(l.amount), -sum(l.hours), 'adjustment', ${documentId},
           'Reversal: voided pay run',
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId}),
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId})
      from entitlement_ledger l
     where l.org_id = ${orgId} and l.pay_run_document_id = ${documentId}
       and l.kind <> 'adjustment'
     group by l.org_id, l.plan_id, l.employee_party_id
    having sum(l.amount) <> 0
    on conflict do nothing
  `);
}

export async function rejectRequestedDocumentVoid(
  documentId: string,
  orgId: string,
  actorId: string | null,
  comment: string | null,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      select org_id, 'documents', id, 'reject',
             jsonb_build_object(
               'mode', 'void_request_rejected',
               'reason', ${comment?.trim() || "approval_rejected"},
               'requestedReason', void_reason,
               'requestedBy', void_requested_by
             ),
             ${actorId}, 'flows'
        from documents
       where id = ${documentId} and org_id = ${orgId}
         and void_requested_at is not null
    `);
    await db.execute(sql`
      update documents
         set void_requested_at = null,
             void_requested_by = null,
             void_reversal_date = null,
             void_reason = null,
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${documentId} and org_id = ${orgId}
    `);
  });
}
