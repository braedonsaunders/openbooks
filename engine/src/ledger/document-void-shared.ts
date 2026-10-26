import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { FlowEventSource } from "@openbooks/forms-core";
import { db, schema, type SqlExecutor } from "../platform/db.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { DocumentVoidError } from "../journal/document-void-refusal.ts";
import { voidRemedyHooks } from "../journal/void-remedy-contributors.ts";
import type { DocumentScriptContext } from "../journal/posting-preconditions.ts";
import { billedCostSourceRefusal, liveInvoicesBillingDocument } from "./billing-provenance.ts";
import { isUuid } from "../platform/uuid.ts";

export { DocumentVoidError, voidCloseModule, type DocumentVoidCode } from "../journal/document-void-refusal.ts";

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
  /**
   * Explicit adjustment-period override for the reversal journals. Regular
   * periods always resolve by reversal date; only an adjustment period may
   * be named, and it must cover the reversal date. Null omits the override.
   */
  reversalPeriodId?: string | null;
  source?: FlowEventSource;
  expectedUpdatedAt?: string | null;
  /** Restricted callers pass their resolved entity scope for the locked claim. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
};

export function validateReason(reason: string): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 5 || value.length > 500) {
    throw new DocumentVoidError("a void reason between 5 and 500 characters is required");
  }
  return value;
}

export function validateDate(value: string): string {
  if (!isIsoCalendarDate(value)) {
    throw new DocumentVoidError("reversalDate must be a valid YYYY-MM-DD date");
  }
  return value;
}

/** Lock contention in the shared application-evidence protocol (55P03). */
export function isLockNotAvailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: string }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Resolve an explicit adjustment-period reversal override. Only an
 * adjustment period of this org covering the reversal date qualifies —
 * regular periods always resolve by date, so naming one is refused rather
 * than silently ignored. Runs at request time (fail fast) and again at
 * completion (authoritative: the period may have changed while gates waited).
 */
export const PAYMENT_KINDS: ReadonlySet<string> = new Set(["customer_payment", "vendor_payment"]);

type CarriedCreditAllocation = { fromLineId: string; toLineId: string; amount: string };

/** The credit allocations a payment carried, as stored on its approved document. */
export function carriedCreditAllocations(custom: unknown): CarriedCreditAllocation[] {
  const raw = (custom as { creditAllocations?: unknown } | null)?.creditAllocations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const allocation = entry as Partial<CarriedCreditAllocation> | null;
    return allocation &&
      isUuid(allocation.fromLineId) &&
      isUuid(allocation.toLineId) &&
      typeof allocation.amount === "string"
      ? [
          {
            fromLineId: allocation.fromLineId,
            toLineId: allocation.toLineId,
            amount: allocation.amount,
          },
        ]
      : [];
  });
}

/**
 * Voiding a payment releases the credits it applied, in the void's own
 * transaction. Posting wrote each carried credit allocation as a credit →
 * target application dated on the payment's posting date; without this the
 * void reversed the cash but left the credit consumed and the bill reduced by
 * a payment that no longer exists. Each release is recorded in the audit log
 * against the payment, naming the application, its endpoints and amount.
 */
export async function releaseCarriedCreditAllocations(
  tx: SqlExecutor,
  input: {
    orgId: string;
    paymentDocumentId: string;
    entryId: string;
    allocations: CarriedCreditAllocation[];
    actorId: string;
    reason: string;
  },
): Promise<void> {
  if (input.allocations.length === 0) return;
  const released: Array<CarriedCreditAllocation & { applicationId: string }> = [];
  const notLive: CarriedCreditAllocation[] = [];
  for (const allocation of input.allocations) {
    const application = (
      await tx.execute<{ id: string }>(
        sql`
      select a.id
        from applications a
       where a.org_id = ${input.orgId} and a.unapplied_at is null
         and a.from_line_id = ${allocation.fromLineId} and a.to_line_id = ${allocation.toLineId}
         and a.amount = ${allocation.amount}::numeric
         and a.settlement_rate_reference = 'same transaction currency'
         and a.applied_on = (
           select entry.posting_date from journal_entries entry
            where entry.id = ${input.entryId} and entry.org_id = ${input.orgId})
         ${released.length > 0 ? sql`and a.id not in ${released.map((row) => row.applicationId)}` : sql``}
       order by a.created_at, a.id
       limit 1
       for update
    `,
        "objects",
      )
    )[0];
    if (!application) {
      notLive.push(allocation);
      continue;
    }
    const unapplied = (
      await tx.execute<{ id: string }>(
        sql`
      update applications
         set unapplied_at = now(), updated_at = now(), updated_by = ${input.actorId}
       where id = ${application.id} and org_id = ${input.orgId} and unapplied_at is null
       returning id
    `,
        "objects",
      )
    )[0];
    if (!unapplied) {
      throw new DocumentVoidError(
        "a credit this payment applied changed while the void was being completed — retry",
        409,
      );
    }
    released.push({ ...allocation, applicationId: application.id });
  }
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${input.orgId}, 'documents', ${input.paymentDocumentId}, 'update',
      ${JSON.stringify({
        mode: "void_release_carried_credits",
        reason: input.reason,
        released,
        // Allocations with no live application had already been released;
        // recorded so the evidence accounts for every carried allocation.
        notLive,
      })}::jsonb,
      ${input.actorId}, 'controlled_void'
    )
  `);
}

export async function resolveVoidCalendarSubsidiaryId(
  executor: { execute: typeof db.execute },
  orgId: string,
  documentId: string,
  subsidiaryId: string | null,
): Promise<string | null> {
  const row = (
    await executor.execute<{ id: string | null }>(
      sql`
    select coalesce(
      ${subsidiaryId}::uuid,
      (select e.subsidiary_id from journal_entries e
        where e.org_id = ${orgId} and e.source_document_id = ${documentId} and e.status in ('posted', 'reversed')
        order by e.book_id, e.id limit 1),
      (select s.id from subsidiaries s
        where s.org_id = ${orgId} and s.parent_id is null and s.is_active
        order by s.id limit 1)
    )::text as id
  `,
      "objects",
    )
  )[0];
  return row?.id ?? null;
}

export async function resolveVoidReversalPeriod(
  executor: { execute: typeof db.execute },
  orgId: string,
  reversalPeriodId: string,
  reversalDate: string,
  subsidiaryId: string | null,
): Promise<string> {
  if (!isUuid(reversalPeriodId)) {
    throw new DocumentVoidError(
      `reversal period ${reversalPeriodId} is not a valid period reference — name an adjustment period covering ${reversalDate}, or omit the override to reverse in the regular covering period`,
      422,
      "reversal-period-uncovered",
    );
  }
  if (!subsidiaryId) {
    throw new DocumentVoidError(
      "the posting subsidiary could not be resolved for this void — select an active subsidiary before choosing an adjustment period",
      422,
      "reversal-period-uncovered",
    );
  }
  const row = (
    await executor.execute<{ id: string }>(
      sql`
    select p.id
      from accounting_periods p
      join lateral accounting_period_posting_window(${orgId}::uuid, p.id) w on true
     where p.id = ${reversalPeriodId} and p.org_id = ${orgId}
       and w.is_adjustment
       and w.window_start <= ${reversalDate}::date and w.window_end >= ${reversalDate}::date
       and p.fiscal_calendar_id = public.subsidiary_posting_calendar(${orgId}::uuid, ${subsidiaryId}::uuid, ${reversalDate}::date)
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!row) {
    throw new DocumentVoidError(
      `reversal period ${reversalPeriodId} is not an adjustment period in the subsidiary's effective fiscal calendar covering ${reversalDate} — name an adjustment period in that calendar, or omit the override to reverse in the regular covering period`,
      422,
      "reversal-period-uncovered",
    );
  }
  return row.id;
}

type DocumentRow = typeof schema.documents.$inferSelect & { revision: string };

export async function loadDocument(documentId: string, orgId: string): Promise<DocumentRow> {
  const [doc] = await db
    .select({
      ...getTableColumns(schema.documents),
      revision: documentRevisionCounterSql(sql`revision_seq`),
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))
    .for("update");
  if (!doc) throw new DocumentVoidError("document not found");
  return doc;
}

/** A void must not strand unfinished effects on a document that can no longer
 * use the posted-document retry action. Successful effects are terminal. */
export async function assertPostingEffectsCompleteForVoid(
  exec: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  const effect = (
    await exec.execute<{ status: string }>(
      sql`
    select status from posting_effects where org_id=${orgId} and document_id=${documentId}
  `,
      "objects",
    )
  )[0];
  if (effect && effect.status !== "succeeded") {
    throw new DocumentVoidError(
      `posting effects are ${effect.status}; wait for completion before voiding. For a terminal failure, resolve the cause and choose Retry posting effects on the posted document with a review reason`,
      422,
      "posting-effects-incomplete",
    );
  }
}

export function assertDocumentVoidable(doc: DocumentRow): void {
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
export async function runBeforeVoidScripts(input: {
  document: DocumentRow;
  orgId: string;
  actorId: string;
}): Promise<void> {
  const doc = input.document;
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, input.orgId));
  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(
      and(eq(schema.documentLines.documentId, doc.id), eq(schema.documentLines.orgId, input.orgId)),
    );
  if (!org) throw new DocumentVoidError("organization not found");
  const scripts = voidRemedyHooks.require("scripting");
  const user = await scripts.resolveUser(input.orgId, input.actorId);
  const scriptCtx: DocumentScriptContext = {
    trigger: "before_void",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    ...(user ? { user } : {}),
  };
  const outcomes = await scripts.runTrigger("before_void", scriptCtx, doc.id);
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
 * A cost source (vendor bill, expense report, card charge, check, project
 * charge, internal billing, order) whose lines a live customer invoice still
 * bills keeps its cost: voiding it would leave the customer billed for a cost
 * that no longer exists. The invoice is voided or deleted first, which
 * releases the link.
 */
export async function refuseBilledCostSourceVoid(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  const invoices = await liveInvoicesBillingDocument(runner, orgId, documentId);
  if (invoices.length > 0)
    throw new DocumentVoidError(billedCostSourceRefusal(invoices), 422, "billed-on-invoice");
}
