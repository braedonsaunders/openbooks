import { eq, sql } from "drizzle-orm";
import type { FlowEventSource } from "@openbooks/forms-core";
import { db, schema, withOrg } from "./db.ts";
import { now } from "./clock.ts";
import { neg } from "./money.ts";
import { emitStatusChange, runRecordFlows } from "./flows/run.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "./transaction-audit.ts";
import { releaseBillingProvenance, releaseVendorBillProvenance } from "./billing-provenance.ts";

export class DocumentVoidError extends Error {}

export interface DocumentVoidResult {
  status: "voided" | "pending_approval";
  reversalEntryId: string | null;
  runId: string | null;
}

function validateReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 5 || value.length > 500) {
    throw new DocumentVoidError("a void reason between 5 and 500 characters is required");
  }
  return value;
}

function validateDate(value?: string | null): string {
  // Business-meaningful default date — honours a pinned simulation clock.
  const date = value?.trim() || now().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new DocumentVoidError("reversalDate must be a valid YYYY-MM-DD date");
  }
  return date;
}

/**
 * Request a controlled cancellation/void. `before_void` flow gates are the
 * approval authority. The document remains posted while gates wait; the final
 * aggregate approval invokes completeRequestedDocumentVoid through the
 * documents adapter.
 */
export async function requestDocumentVoid(input: {
  documentId: string;
  orgId: string;
  actorId: string;
  reason: string;
  reversalDate?: string | null;
  source?: FlowEventSource;
}): Promise<DocumentVoidResult> {
  const reason = validateReason(input.reason);
  const reversalDate = validateDate(input.reversalDate);
  return withOrg(input.orgId, async () => {
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, input.documentId));
    if (!doc) throw new DocumentVoidError("document not found");
    if (!["approved", "posted"].includes(doc.status)) {
      throw new DocumentVoidError(
        `${doc.documentNumber} is ${doc.status}; only issued or posted documents can be voided`,
      );
    }
    if (doc.voidRequestedAt) {
      throw new DocumentVoidError(`${doc.documentNumber} already has a pending void request`);
    }

    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, input.orgId));
    const lines = await db
      .select()
      .from(schema.documentLines)
      .where(eq(schema.documentLines.documentId, doc.id));
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

    const reserved = (await db.execute<{ id: string }>(sql`
      update documents
         set void_reason = ${reason},
             void_requested_at = now(),
             void_requested_by = ${input.actorId},
             void_reversal_date = ${reversalDate},
             updated_at = now(),
             updated_by = ${input.actorId}
       where id = ${doc.id} and org_id = ${input.orgId}
         and status in ('approved', 'posted')
         and void_requested_at is null
       returning id
    `));
    if (!reserved.rows[0]) {
      throw new DocumentVoidError(
        `${doc.documentNumber} changed while the void request was being created; reload and try again`,
      );
    }
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

    const flows = await runRecordFlows(
      { kind: "before_void", source: input.source ?? "ui" },
      doc.kind,
      doc.id,
      { orgId: input.orgId, userId: input.actorId },
    );
    if (flows.failed) {
      await db.execute(sql`
        update documents
           set void_requested_at = null, void_requested_by = null,
               void_reversal_date = null, void_reason = null,
               updated_at = now(), updated_by = ${input.actorId}
         where id = ${doc.id}
      `);
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
 * Complete a previously stored request. Called directly when no gate exists,
 * or by the flow adapter after the final configured approval.
 */
export async function completeRequestedDocumentVoid(
  documentId: string,
  orgId: string,
): Promise<string | null> {
  return withOrg(orgId, async () => {
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

      const before = await captureTransactionAuditSnapshot(tx, documentId);
      if (!before) throw new DocumentVoidError("document not found");
      const entryId = doc.posted_entry_id ? String(doc.posted_entry_id) : null;
      let reversalEntryId: string | null = null;

      if (entryId) {
        const reconciled = (await tx.execute(sql`
          select 1
            from reconciliation_matches rm
           where rm.journal_line_id in (
             select id from journal_lines where entry_id = ${entryId}
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
           where a.unapplied_at is null
             and a.to_line_id in (
               select id from journal_lines where entry_id = ${entryId}
             )
           limit 1
        `));
        if (incoming.rows.length > 0) {
          throw new DocumentVoidError(
            "this transaction has live payments or credits applied to it — unapply them before voiding",
          );
        }
        const downstream = (await tx.execute<{ document_number: string }>(sql`
          select d2.document_number
            from document_links dl
            join documents d2 on d2.id = dl.to_document_id
           where dl.from_document_id = ${documentId}
             and d2.status in ('approved', 'posted')
             and dl.link_type <> 'pays'
           limit 1
        `));
        if (downstream.rows[0]) {
          throw new DocumentVoidError(
            `this transaction feeds ${downstream.rows[0].document_number} — reverse the downstream transaction first`,
          );
        }
        const dependentSubledger = (await tx.execute<{ inventory: boolean; revenue: boolean }>(sql`
          select
            exists (
              select 1
                from inventory_movements movement
               where movement.document_line_id in (
                 select id from document_lines where document_id = ${documentId}
               )
            ) as inventory,
            exists (
              select 1
                from performance_obligations obligation
               where obligation.document_line_id in (
                 select id from document_lines where document_id = ${documentId}
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
          throw new DocumentVoidError(`no accounting period covers ${reversalDate}`);
        }
        const blocked = (await tx.execute(sql`
          select 1
            from (
              select distinct subsidiary_id
                from journal_lines
               where entry_id = ${entryId}
            ) s
           where period_module_is_closed(
             ${orgId}, ${period.rows[0].id}, ${String(entry.book_id)},
             s.subsidiary_id, 'gl'
           )
           limit 1
        `));
        if (blocked.rows.length > 0) {
          throw new DocumentVoidError(
            `the reversal period for ${reversalDate} is closed for GL posting`,
          );
        }

        const outgoingFx = (await tx.execute<{ id: string }>(sql`
          select distinct a.fx_gain_loss_entry_id as id
            from applications a
           where a.unapplied_at is null
             and a.fx_gain_loss_entry_id is not null
             and a.from_line_id in (
               select id from journal_lines where entry_id = ${entryId}
             )
        `));
        await tx.execute(sql`
          update applications
             set unapplied_at = now(), updated_at = now(),
                 updated_by = ${String(doc.void_requested_by)}
           where unapplied_at is null
             and from_line_id in (
               select id from journal_lines where entry_id = ${entryId}
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
            .where(eq(schema.journalLines.entryId, sourceEntryId));
          const [reversal] = await tx
            .insert(schema.journalEntries)
            .values({
              orgId,
              bookId: String(source.book_id),
              subsidiaryId: String(source.subsidiary_id),
              entryNumber: `${String(source.entry_number)}-${suffix}`,
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
            .returning({ id: schema.journalEntries.id });
          await tx.insert(schema.journalLines).values(
            lines.map((line) => ({
              orgId,
              entryId: reversal.id,
              lineNumber: line.lineNumber,
              accountId: line.accountId,
              subsidiaryId: line.subsidiaryId,
              amount: neg(line.amount),
              currency: line.currency,
              txnAmount: neg(line.txnAmount),
              fxRate: line.fxRate,
              partyId: line.partyId,
              departmentId: line.departmentId,
              projectId: line.projectId,
              locationId: line.locationId,
              classId: line.classId,
              equipmentUnitId: line.equipmentUnitId,
              extraDims: line.extraDims,
              paymentCardId: line.paymentCardId,
              taxCodeId: line.taxCodeId,
              memo: line.memo,
              dueDate: null,
              isOpenItem: false,
              createdBy: String(doc.void_requested_by),
            })),
          );
          await tx
            .update(schema.journalEntries)
            .set({
              status: "posted",
              postedAt: new Date(),
              postedBy: String(doc.void_requested_by),
            })
            .where(eq(schema.journalEntries.id, reversal.id));
          await tx
            .update(schema.journalEntries)
            .set({
              status: "reversed",
              updatedAt: new Date(),
              updatedBy: String(doc.void_requested_by),
            })
            .where(eq(schema.journalEntries.id, sourceEntryId));
          return reversal.id;
        };

        reversalEntryId = await reverseEntry(entryId, "VOID");
        for (const fx of outgoingFx.rows) {
          await reverseEntry(fx.id, "VOID");
        }
      }

      if (String(doc.kind) === "customer_invoice") {
        await releaseBillingProvenance(tx, orgId, documentId);
      }
      if (String(doc.kind) === "vendor_bill") {
        await releaseVendorBillProvenance(tx, orgId, documentId);
      }
      if (String(doc.kind) === "pay_run") {
        await releaseVoidedPayRun(tx, orgId, documentId);
      }
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
      const after = await captureTransactionAuditSnapshot(tx, documentId);
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
  await withOrg(orgId, async () => {
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
