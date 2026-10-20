import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { PAYMENT_RUN_SYSTEM_ACTOR_ID } from "./run-cancellation.ts";

/** Provider refund and dispute automation context: the policy and error vocabulary, the provider event shapes, and the org-scoped loader every automation step reads through. */

/** The nil-UUID system actor every payment automation posts under — the same
 *  convention as PAYMENT_RUN_SYSTEM_ACTOR_ID,aliased so refund/dispute audit
 *  rows name their own actor without minting a second identity. */
export const PSP_AUTOMATION_SYSTEM_ACTOR_ID = PAYMENT_RUN_SYSTEM_ACTOR_ID;

export interface RefundSourceEvidence {
  basis: "incremental" | "cumulative";
  amount: string | null;
  currency: string | null;
  refundId: string | null;
}

export interface ProviderDisputeDetail {
  id: string;
  amount: string;
  currency: string;
  reason?: string | null;
  state: "opened" | "won" | "lost";
}

export interface ProviderRefundEvent {
  provider: string;
  providerEventId: string;
  attemptId: string;
  refundedAmount: string | null;
  refundCurrency: string | null;
  providerRef: string | null;
  refundAmountBasis?: RefundSourceEvidence["basis"];
  providerRefundId?: string | null;
  dispute?: ProviderDisputeDetail | null;
  raw?: unknown;
}

export type RefundAutomationOutcome =
  | { status: "posted"; disputeId: string; documents: string[] }
  | { status: "pending_review"; disputeId: string }
  | { status: "duplicate"; disputeId: string };

export class PspAutomationError extends PaymentError {}

export type AutomationContext = {
  attempt: {
    id: string;
    status: string;
    provider: string;
    external_ref: string;
    payment_document_id: string | null;
    amount: string;
  };
  link: {
    id: string;
    document_id: string;
    party_id: string;
    subsidiary_id: string;
    bank_account_id: string;
    currency: string;
    created_by: string | null;
  };
  receipt: {
    id: string;
    status: string;
    document_number: string;
    total: string;
    currency: string;
    custom: Record<string, unknown>;
  } | null;
  invoice: {
    id: string;
    document_number: string;
    open_balance: string;
  };
  disputeAccounts: {
    disputedFundsAccountId: string | null;
    chargebackLossAccountId: string | null;
    disputeFeeAccountId: string | null;
  };
  bankAccountId: string;
};

export async function loadAutomationContext(
  orgId: string,
  attemptId: string,
): Promise<AutomationContext> {
  const attempt = (
    await db.execute<{
      id: string;
      status: string;
      provider: string;
      external_ref: string;
      payment_document_id: string | null;
      link_id: string;
      amount: string;
    }>(sql`
    select id, status, provider, external_ref, payment_document_id, link_id,
           (coalesce(amount, (select amount from payment_links where id = payment_attempts.link_id and org_id = ${orgId}))
             + coalesce(surcharge_amount, 0))::text as amount
      from payment_attempts
     where id = ${attemptId} and org_id = ${orgId}
     for update
  `)
  ).rows[0];
  if (!attempt)
    throw new PspAutomationError("payment attempt is not in this organization");
  const link = (
    await db.execute<{
      id: string;
      document_id: string;
      party_id: string;
      subsidiary_id: string;
      bank_account_id: string;
      currency: string;
      created_by: string | null;
    }>(sql`
    select l.id, l.document_id, l.party_id, l.subsidiary_id, l.bank_account_id,
           l.currency, l.created_by
      from payment_links l
     where l.id = ${attempt.link_id} and l.org_id = ${orgId}
  `)
  ).rows[0];
  if (!link)
    throw new PspAutomationError("payment link is not in this organization");
  const receipt = attempt.payment_document_id
    ? ((
        await db.execute<{
          id: string;
          status: string;
          document_number: string;
          total: string;
          currency: string;
          custom: Record<string, unknown> | null;
        }>(sql`
        select id, status, document_number, total::text, currency, custom
          from documents
         where id = ${attempt.payment_document_id} and org_id = ${orgId}
      `)
      ).rows[0] ?? null)
    : null;
  const invoice = (
    await db.execute<{
      id: string;
      document_number: string;
      open_balance: string;
    }>(sql`
    select id, document_number, open_balance::text
      from documents
     where id = ${link.document_id} and org_id = ${orgId}
  `)
  ).rows[0];
  if (!invoice)
    throw new PspAutomationError("invoice is not in this organization");
  const config = (
    await db.execute<{
      default_disputed_funds_account_id: string | null;
      default_chargeback_loss_account_id: string | null;
      default_dispute_fee_account_id: string | null;
    }>(sql`
    select default_disputed_funds_account_id,
           default_chargeback_loss_account_id, default_dispute_fee_account_id
      from psp_provider_configs
     where org_id = ${orgId} and provider = ${attempt.provider}
  `)
  ).rows[0];
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      provider: attempt.provider,
      external_ref: attempt.external_ref,
      payment_document_id: attempt.payment_document_id,
      amount: attempt.amount,
    },
    link,
    receipt: receipt
      ? {
          id: receipt.id,
          status: receipt.status,
          document_number: receipt.document_number,
          total: receipt.total,
          currency: receipt.currency,
          custom: receipt.custom ?? {},
        }
      : null,
    invoice,
    disputeAccounts: {
      disputedFundsAccountId: config?.default_disputed_funds_account_id ?? null,
      chargebackLossAccountId:
        config?.default_chargeback_loss_account_id ?? null,
      disputeFeeAccountId: config?.default_dispute_fee_account_id ?? null,
    },
    bankAccountId: link.bank_account_id,
  };
}
