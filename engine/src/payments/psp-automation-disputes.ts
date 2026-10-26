import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  type ProviderDisputeDetail,
  type RefundAutomationOutcome,
  type RefundSourceEvidence,
  PspAutomationError,
} from "./psp-automation-context.ts";

/** Dispute record state for provider chargebacks: row creation, status transitions with history, lookups and review parking. */

function historyAppend(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

export async function insertDisputeRow(
  orgId: string,
  row: {
    provider: string;
    providerEventId: string;
    kind: "refund" | "dispute";
    status: string;
    attemptId: string | null;
    receiptDocumentId: string | null;
    invoiceDocumentId: string | null;
    currency: string;
    amount: string;
    feeAmount: string;
    providerRef: string | null;
    reason: string | null;
    refundSource?: RefundSourceEvidence;
  },
): Promise<{ id: string; created: boolean }> {
  // The event key is the automation idempotency lock: a redelivery converges
  // on the stored row instead of posting twice. The conflict is expected on
  // every redelivery, which is why doing nothing here is benign.
  const id = randomUUID();
  const inserted = await db.execute<{ id: string }>(
    sql`
    insert into payment_disputes
      (id, org_id, provider, provider_event_id, kind, status, attempt_id,
       receipt_document_id, invoice_document_id, currency, amount, fee_amount,
       provider_ref, reason, status_history, created_by, updated_by)
    values (${id}, ${orgId}, ${row.provider}, ${row.providerEventId}, ${row.kind},
            ${row.status}, ${row.attemptId}, ${row.receiptDocumentId}, ${row.invoiceDocumentId},
            ${row.currency}, ${row.amount}, ${row.feeAmount}, ${row.providerRef}, ${row.reason},
            ${JSON.stringify([{ status: row.status, at: new Date().toISOString(), reason: row.reason, ...(row.refundSource ? { refundSource: row.refundSource } : {}) }])}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}, ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
    -- Repeated provider delivery reuses the dispute selected below instead of recording it twice.
    on conflict (org_id, provider, provider_event_id) do nothing
    returning id
  `,
    "objects",
  );
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = (
    await db.execute<{ id: string }>(
      sql`
    select id from payment_disputes
     where org_id = ${orgId} and provider = ${row.provider} and provider_event_id = ${row.providerEventId}
  `,
      "objects",
    )
  )[0];
  if (!existing) throw new PspAutomationError("dispute record could not be locked");
  return { id: existing.id, created: false };
}

export async function transitionDisputeRow(
  orgId: string,
  disputeId: string,
  status: string,
  documents: string[],
  reason: string | null,
): Promise<void> {
  // The zero-row check is the failure, not the update: under RLS an unscoped
  // write silently matches nothing, which would report a posted refund whose
  // record never moved.
  const updated = await db.execute<never>(sql`
    update payment_disputes
       set status = ${status},
           documents_posted = ${JSON.stringify(documents)}::jsonb,
           reason = coalesce(${reason}, reason),
           status_history = status_history || ${historyAppend({ status, at: new Date().toISOString(), reason, documents })}::jsonb,
           updated_at = now(),
           updated_by = ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}
     where id = ${disputeId} and org_id = ${orgId}
  `);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("dispute record is not in this organization");
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payment_disputes', ${disputeId}, 'update',
            ${JSON.stringify({ after: { status, documents, reason } })}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
  `);
}

export async function disputeRow(
  orgId: string,
  disputeId: string,
): Promise<{
  id: string;
  kind: string;
  status: string;
  attempt_id: string | null;
  receipt_document_id: string | null;
  invoice_document_id: string | null;
  currency: string;
  amount: string;
  fee_amount: string;
  provider: string;
  provider_event_id: string;
  provider_ref: string | null;
  reason: string | null;
  documents_posted: unknown;
  status_history: unknown;
}> {
  const row = (
    await db.execute<{
      id: string;
      kind: string;
      status: string;
      attempt_id: string | null;
      receipt_document_id: string | null;
      invoice_document_id: string | null;
      currency: string;
      amount: string;
      fee_amount: string;
      provider: string;
      provider_event_id: string;
      provider_ref: string | null;
      reason: string | null;
      documents_posted: unknown;
      status_history: unknown;
    }>(
      sql`
    select id, kind, status, attempt_id, receipt_document_id, invoice_document_id,
           currency, amount::text, fee_amount::text, provider, provider_event_id,
           provider_ref, reason, documents_posted, status_history
      from payment_disputes
     where id = ${disputeId} and org_id = ${orgId}
     for update
  `,
      "objects",
    )
  )[0];
  if (!row) throw new PspAutomationError("dispute record is not in this organization");
  return row;
}

export async function parkForReview(
  orgId: string,
  disputeId: string,
  reason: string,
): Promise<RefundAutomationOutcome> {
  const row = await disputeRow(orgId, disputeId);
  await transitionDisputeRow(
    orgId,
    disputeId,
    "pending_review",
    asDocIds(row.documents_posted),
    reason,
  );
  return { status: "pending_review", disputeId };
}

export interface ProviderDisputeEvent {
  provider: string;
  providerEventId: string;
  attemptId: string | null;
  dispute: ProviderDisputeDetail;
  raw?: unknown;
}

export type PendingAction = "refund" | "dispute-opened" | "dispute-won" | "dispute-lost";

export async function findDisputeByRef(
  orgId: string,
  provider: string,
  providerRef: string,
): Promise<{
  id: string;
  status: string;
  attempt_id: string | null;
  receipt_document_id: string | null;
  invoice_document_id: string | null;
  currency: string;
  amount: string;
  fee_amount: string;
  provider_event_id: string;
  reason: string | null;
  documents_posted: unknown;
  status_history: unknown;
} | null> {
  const row = (
    await db.execute<{
      id: string;
      status: string;
      attempt_id: string | null;
      receipt_document_id: string | null;
      invoice_document_id: string | null;
      currency: string;
      amount: string;
      fee_amount: string;
      provider_event_id: string;
      reason: string | null;
      documents_posted: unknown;
      status_history: unknown;
    }>(
      sql`
    select id, status, attempt_id, receipt_document_id, invoice_document_id,
           currency, amount::text, fee_amount::text, provider_event_id, reason,
           documents_posted, status_history
      from payment_disputes
     where org_id = ${orgId} and provider = ${provider} and provider_ref = ${providerRef}
       and kind = 'dispute'
     order by created_at desc limit 1
     for update
  `,
      "objects",
    )
  )[0];
  return row ?? null;
}

export function historyHasEvent(history: unknown, providerEventId: string): boolean {
  if (!Array.isArray(history)) return false;
  return history.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (record.providerEventId === providerEventId) return true;
    const event = record.event as Record<string, unknown> | undefined;
    return event?.providerEventId === providerEventId;
  });
}

export function pendingActionOf(history: unknown): PendingAction | null {
  if (!Array.isArray(history)) return null;
  for (const entry of [...history].reverse()) {
    if (typeof entry !== "object" || entry === null) continue;
    const action = (entry as Record<string, unknown>).pendingAction;
    if (
      action === "refund" ||
      action === "dispute-opened" ||
      action === "dispute-won" ||
      action === "dispute-lost"
    ) {
      return action;
    }
  }
  return null;
}

export function pendingEventOf(history: unknown): Record<string, unknown> | null {
  if (!Array.isArray(history)) return null;
  for (const entry of [...history].reverse()) {
    if (!entry || typeof entry !== "object" || !("pendingAction" in entry)) continue;
    const event = (entry as { event?: unknown }).event;
    return event && typeof event === "object" ? (event as Record<string, unknown>) : null;
  }
  return null;
}

export async function parkDisputeForReview(
  orgId: string,
  disputeId: string,
  pendingAction: PendingAction,
  event: Record<string, unknown>,
  reason: string,
): Promise<RefundAutomationOutcome> {
  const updated = await db.execute<never>(sql`
    update payment_disputes
       set status = 'pending_review',
           reason = ${reason},
           fee_amount = coalesce(${typeof event.feeAmount === "string" ? event.feeAmount : null}::numeric, fee_amount),
           status_history = status_history || ${JSON.stringify({ status: "pending_review", at: new Date().toISOString(), reason, pendingAction, event })}::jsonb,
           updated_at = now(),
           updated_by = ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}
     where id = ${disputeId} and org_id = ${orgId}
  `);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("dispute record is not in this organization");
  }
  return { status: "pending_review", disputeId };
}

export function asDocIds(documents: unknown): string[] {
  return Array.isArray(documents)
    ? documents.filter((d): d is string => typeof d === "string")
    : [];
}
