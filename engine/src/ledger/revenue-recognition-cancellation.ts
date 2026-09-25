/**
 * Invoice revenue-recognition cancellation: reverse recognition journals,
 * then route the invoice through the controlled void — in one transaction.
 * Moved verbatim from revenue/recognition.ts (ARCH-MODULE-CYCLE C10); the
 * document-void import is static here because the caller now lives in ledger.
 */
import { sql } from "drizzle-orm";
import { neg } from "../money/money.ts";
import { db, withOrg } from "../platform/db.ts";
import { CloseError, assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockRevenueContract } from "../revenue/recognition.ts";
import { completeRequestedDocumentVoid, requestDocumentVoid } from "./document-void.ts";
// ---------------------------------------------------------------------------
// Controlled invoice cancellation
// ---------------------------------------------------------------------------

export class RevenueRecognitionCancellationError extends Error {}

export interface CancelRevenueRecognitionResult {
  status: "cancelled" | "pending_approval";
  recognitionReversalEntryIds: string[];
  invoiceReversalEntryId: string | null;
  runId: string | null;
}

function cancellationReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new RevenueRecognitionCancellationError(
      "a cancellation reason between 5 and 500 characters is required",
    );
  }
  return reason;
}

function cancellationDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new RevenueRecognitionCancellationError(
      "reversalDate must be a valid YYYY-MM-DD date",
    );
  }
  return value;
}

/**
 * Cancel all revenue-recognition activity sourced by an invoice, then route the
 * invoice through the normal controlled-void workflow.
 *
 * Posted recognition journals are never edited or detached. Each receives one
 * exact, row-locked compensating journal and the schedule line stores both ids.
 * Unposted schedule lines remain as historical plan evidence but are made
 * ineligible by the cancelled obligation. Retries and concurrent callers return
 * the same lineage.
 */
export async function cancelRevenueRecognitionForInvoice(input: {
  documentId: string;
  orgId: string;
  actorId: string;
  reason: string;
  reversalDate: string;
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<CancelRevenueRecognitionResult> {
  if (!input.actorId) {
    throw new RevenueRecognitionCancellationError(
      "an attributable actor is required",
    );
  }
  const reason = cancellationReason(input.reason);
  const reversalDate = cancellationDate(input.reversalDate);

  // Keep the recognition reversals and the invoice's controlled-void request
  // in one transaction. A void can fail after its request is claimed (for
  // example, because a downstream transaction or a closed subledger period
  // blocks the final reversal). Calling the void path after this transaction
  // commits would leave the recognition lineage cancelled while the invoice
  // remains posted. The org transaction boundary is reused by the document
  // void helpers, so every effect rolls back together on any failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withOrg(input.orgId, () =>
        db.transaction(async (tx) => {
      const document = (await tx.execute<{
        id: string;
        status: string;
        subsidiary_id: string | null;
        reversal_entry_id: string | null;
        void_requested_at: Date | null;
        void_reason: string | null;
        void_reversal_date: string | null;
      }>(sql`
        select id, status, subsidiary_id, reversal_entry_id, void_requested_at,
               void_reason, void_reversal_date
          from documents
         where id = ${input.documentId}
           and org_id = ${input.orgId}
           and kind = 'customer_invoice'
         for update
      `));
      const doc = document.rows[0];
      // Scope is rechecked under the invoice lock: the route's unlocked
      // pre-read can authorize entity A while a concurrent A→B rehome lands
      // before this cancel commits. Missing and out-of-scope answer alike.
      if (!doc || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, doc.subsidiary_id)) {
        throw new ScopeNotFoundError();
      }
      if (!["posted", "voided"].includes(doc.status)) {
        throw new RevenueRecognitionCancellationError(
          `customer invoice is ${doc.status}; only a posted invoice can be cancelled`,
        );
      }

      // A retry may resume only the exact controlled-void request created by
      // this cancellation. Durable audit evidence binds its reason and date;
      // an unrelated pending void must never be completed as a side effect.
      if (doc.void_requested_at) {
        const evidence = await tx.execute(sql`
          select 1 from audit_log
           where org_id = ${input.orgId}
             and table_name = 'performance_obligations'
             and row_id = ${input.documentId}
             and request_id = 'revenue_recognition_cancellation'
             and changes->>'mode' = 'revenue_recognition_cancellation'
             and changes->>'reason' = ${reason}
             and changes->>'reversalDate' = ${reversalDate}
           limit 1
        `);
        if (!evidence.rows[0]) {
          throw new RevenueRecognitionCancellationError(
            'this invoice already has a different pending void request — resume or reject that request before cancelling recognition',
          );
        }
      }

      const affectedContracts=(await tx.execute<{contract_id:string}>(sql`select distinct o.contract_id from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id where o.org_id=${input.orgId} and dl.document_id=${input.documentId} order by o.contract_id`)).rows;
      for(const c of affectedContracts)await lockRevenueContract(tx,input.orgId,c.contract_id);
      const obligations = (await tx.execute<{ id: string; contract_id: string; status: string }>(sql`
        select obligation.id, obligation.contract_id, obligation.status
          from performance_obligations obligation
         where obligation.org_id = ${input.orgId}
           and obligation.contract_id in(select jsonb_array_elements_text(${JSON.stringify(affectedContracts.map(c=>c.contract_id))}::jsonb)::uuid)
         order by obligation.id
         for update of obligation
      `));
      if (obligations.rows.length === 0) {
        throw new RevenueRecognitionCancellationError(
          "invoice has no revenue-recognition obligations",
        );
      }

      const obligationIds = obligations.rows.map((row) => row.id);
      const sources = (await tx.execute<{
          line_id: string;
          journal_entry_id: string;
          reversal_journal_entry_id: string | null;
          entry_number: string;
          book_id: string;
          subsidiary_id: string;
          entry_status: string;
        }>(sql`
        select schedule_line.id as line_id,
               schedule_line.journal_entry_id,
               schedule_line.reversal_journal_entry_id,
               entry.entry_number,
               entry.book_id,
               entry.subsidiary_id,
               entry.status as entry_status
          from recognition_schedule_lines schedule_line
          join recognition_schedules schedule
            on schedule.id = schedule_line.schedule_id
           and schedule.org_id = schedule_line.org_id
          join journal_entries entry
            on entry.id = schedule_line.journal_entry_id
           and entry.org_id = schedule_line.org_id
         where schedule_line.org_id = ${input.orgId}
           and schedule.obligation_id =
             any(${`{${obligationIds.join(",")}}`}::uuid[])
         order by schedule_line.created_at, schedule_line.id
         for update of schedule_line, entry
      `));

      const reversalIds: string[] = [];
      for (const source of sources.rows) {
        if (source.reversal_journal_entry_id) {
          reversalIds.push(source.reversal_journal_entry_id);
          continue;
        }
        if (source.entry_status !== "posted") {
          throw new RevenueRecognitionCancellationError(
            `${source.entry_number} is ${source.entry_status} without recorded cancellation lineage`,
          );
        }
        const period = (await tx.execute<{ id: string }>(sql`
          select period.id
            from accounting_periods period
           where period.org_id = ${input.orgId}
             and period.starts_on <= ${reversalDate}
             and period.ends_on >= ${reversalDate}
           order by period.is_adjustment, period.starts_on
           limit 1
        `));
        if (!period.rows[0]) {
          throw new RevenueRecognitionCancellationError(
            `no accounting period covers ${reversalDate}`,
          );
        }
        // One period gate: the shared GL check replaces the raw
        // period_module_is_closed predicate. A reversal is new activity, not
        // historical replay, so source-owned imported locks refuse exactly
        // like user locks.
        try {
          await assertPeriodModulesOpen(tx, {
            orgId: input.orgId,
            periodId: period.rows[0].id,
            bookId: source.book_id,
            subsidiaryIds: [source.subsidiary_id],
            modules: ["gl"],
          });
        } catch (error) {
          if (error instanceof CloseError) {
            throw new RevenueRecognitionCancellationError(
              `the GL period covering ${reversalDate} is closed`,
            );
          }
          throw error;
        }

        // The cancellation mirrors the source lines exactly through the ONE
        // ledger API; the source entry is then marked reversed — never edited.
        const mirrorSource = (await tx.execute<{
          line_number: number;
          account_id: string;
          subsidiary_id: string;
          amount: string;
          currency: string | null;
          txn_amount: string;
          fx_rate: string;
          party_id: string | null;
          department_id: string | null;
          project_id: string | null;
          location_id: string | null;
          class_id: string | null;
          equipment_unit_id: string | null;
          payment_card_id: string | null;
          extra_dims: unknown;
          tax_code_id: string | null;
          quantity: string | null;
          unit: string | null;
          custom: unknown;
        }>(sql`
          select line_number, account_id, subsidiary_id, amount::text as amount,
                 currency, txn_amount::text as txn_amount, fx_rate::text as fx_rate,
                 party_id, department_id, project_id, location_id, class_id,
                 equipment_unit_id, payment_card_id, extra_dims, tax_code_id,
                 quantity::text as quantity, unit, custom
            from journal_lines
           where entry_id = ${source.journal_entry_id} and org_id = ${input.orgId}
           order by line_number
        `)).rows;
        const postedCancel = await postEntry(tx, {
          orgId: input.orgId,
          bookId: source.book_id,
          subsidiaryId: source.subsidiary_id,
          entryNumber: `${source.entry_number}-CANCEL`,
          postingDate: reversalDate,
          periodId: period.rows[0].id,
          memo: `Revenue recognition cancellation — ${reason}`,
          origin: "revenue_recognition",
          reversesEntryId: source.journal_entry_id,
          actorId: input.actorId,
          lines: mirrorSource.map((line) => ({
            accountId: line.account_id,
            subsidiaryId: line.subsidiary_id,
            amount: neg(line.amount),
            currency: line.currency,
            txnAmount: neg(line.txn_amount),
            fxRate: line.fx_rate,
            memo: `Revenue recognition cancellation — ${reason}`,
            partyId: line.party_id,
            departmentId: line.department_id,
            projectId: line.project_id,
            locationId: line.location_id,
            classId: line.class_id,
            equipmentUnitId: line.equipment_unit_id,
            paymentCardId: line.payment_card_id,
            extraDims: (line.extra_dims ?? {}) as Record<string, unknown>,
            taxCodeId: line.tax_code_id,
            quantity: line.quantity == null ? null : neg(line.quantity),
            unit: line.unit,
            custom: (line.custom ?? {}) as Record<string, unknown>,
            lineNumber: line.line_number,
          })),
        });
        const reversalId = postedCancel.entryId;
        await markEntryReversed(tx, { orgId: input.orgId, entryId: source.journal_entry_id, actorId: input.actorId });
        await tx.execute(sql`
          update recognition_schedule_lines
             set reversal_journal_entry_id = ${reversalId},
                 updated_at = now(), updated_by = ${input.actorId}
           where id = ${source.line_id} and org_id = ${input.orgId}
        `);
        reversalIds.push(reversalId);
      }

      await tx.execute(sql`
        update performance_obligations
           set status = 'cancelled',
               cancellation_reason = coalesce(cancellation_reason, ${reason}),
               cancelled_at = coalesce(cancelled_at, now()),
               cancelled_by = coalesce(cancelled_by, ${input.actorId}),
               updated_at = now(), updated_by = ${input.actorId}
         where id = any(${`{${obligationIds.join(",")}}`}::uuid[])
           and org_id = ${input.orgId}
           and status <> 'cancelled'
      `);
      await tx.execute(sql`
        update recognition_schedules
           set status = 'cancelled', updated_at = now(),
               updated_by = ${input.actorId}
         where obligation_id =
           any(${`{${obligationIds.join(",")}}`}::uuid[])
           and org_id = ${input.orgId}
           and status <> 'cancelled'
      `);
      const contractIds = [...new Set(obligations.rows.map((row) => row.contract_id))];
      await tx.execute(sql`
        update revenue_contracts contract
           set status = 'cancelled', updated_at = now(),
               updated_by = ${input.actorId}
         where contract.id = any(${`{${contractIds.join(",")}}`}::uuid[])
           and contract.org_id = ${input.orgId}
           and not exists (
             select 1
               from performance_obligations obligation
              where obligation.contract_id = contract.id
                and obligation.org_id = contract.org_id
                and obligation.status <> 'cancelled'
           )
      `);
      if (!doc.void_requested_at) {
        await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values (
            ${input.orgId}, 'performance_obligations', ${input.documentId},
            'update',
            ${JSON.stringify({
              mode: "revenue_recognition_cancellation",
              reason,
              reversalDate,
              obligationIds,
            })}::jsonb,
            ${input.actorId}, 'revenue_recognition_cancellation'
          )
        `);
      }
      if (doc.status === "voided") {
        return {
          status: "cancelled" as const,
          recognitionReversalEntryIds: reversalIds,
          invoiceReversalEntryId: doc.reversal_entry_id,
          runId: null,
        };
      }

      // The normal void path owns document reversal, approval routing, audit
      // snapshots, applications, and period controls. Run it while this
      // transaction is still open so a failure rolls back the recognition
      // reversals as well. An overlapping request is completed rather than
      // claimed a second time.
      if (doc.void_requested_at) {
        const pending = await tx.execute<{ run_id: string }>(sql`
          select run.id as run_id
            from flow_runs run
            join flow_gates gate
              on gate.run_id = run.id and gate.org_id = run.org_id
           where run.org_id = ${input.orgId}
             and run.subject_id = ${input.documentId}
             and run.trigger = 'before_void'
             and run.status = 'waiting'
             and gate.status in ('pending', 'escalated')
           order by run.started_at desc, run.id desc
           limit 1
        `);
        if (pending.rows[0]) {
          return {
            status: "pending_approval" as const,
            recognitionReversalEntryIds: reversalIds,
            invoiceReversalEntryId: null,
            runId: pending.rows[0].run_id,
          };
        }
        // The waiting-only probe above cannot see the rest of the gate
        // lifecycle. A retry must never complete the void while approval is
        // still in flight, nor after the approval run refused or errored —
        // only a completed run (or no run at all) authorizes completion.
        const lifecycle = await tx.execute<{ id: string; status: string }>(sql`
          select run.id, run.status
            from flow_runs run
           where run.org_id = ${input.orgId}
             and run.subject_id = ${input.documentId}
             and run.trigger = 'before_void'
             and run.started_at >= ${doc.void_requested_at}
           order by run.started_at desc, run.id desc
           limit 1
        `);
        const run = lifecycle.rows[0];
        if (run && run.status === "running") {
          return {
            status: "pending_approval" as const,
            recognitionReversalEntryIds: reversalIds,
            invoiceReversalEntryId: null,
            runId: run.id,
          };
        }
        if (run && (run.status === "failed" || run.status === "cancelled")) {
          throw new RevenueRecognitionCancellationError(
            `the before-void approval ${run.status} — ask an approver to re-run the approval before cancelling; the invoice remains posted`,
          );
        }
        const invoiceReversalEntryId =
          await completeRequestedDocumentVoid(input.documentId, input.orgId);
        return {
          status: "cancelled" as const,
          recognitionReversalEntryIds: reversalIds,
          invoiceReversalEntryId,
          runId: null,
        };
      }
      const requested = await requestDocumentVoid({
        documentId: input.documentId,
        orgId: input.orgId,
        actorId: input.actorId,
        reason,
        reversalDate,
        source: "api",
      });
      return {
        status:
          requested.status === "voided" ? "cancelled" : "pending_approval",
        recognitionReversalEntryIds: reversalIds,
        invoiceReversalEntryId: requested.reversalEntryId,
        runId: requested.runId,
      };
    }),
  );
    } catch (error) {
      // Preserve the previous bounded retry behavior, but retry the complete
      // unit so a failed void never leaves durable recognition side effects.
      if (attempt === 2) throw error;
    }
  }
  throw new RevenueRecognitionCancellationError(
    "invoice cancellation could not be finalized",
  );
}
