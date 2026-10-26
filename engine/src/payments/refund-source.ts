import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { persistPaymentMoney } from "./settlement-policy.ts";
import {
  PspAutomationError,
  type ProviderRefundEvent,
  type RefundSourceEvidence,
} from "./psp-automation-context.ts";

export function refundSource(event: ProviderRefundEvent): RefundSourceEvidence {
  if (
    event.refundedAmount !== null &&
    persistPaymentMoney(event.refundedAmount, "refunded amount") < 0n
  ) {
    throw new PspAutomationError("The provider's refunded amount cannot be negative.");
  }
  return {
    basis: event.refundAmountBasis ?? "incremental",
    amount: event.refundedAmount === null ? null : fromUnits(toUnits(event.refundedAmount)),
    currency: event.refundCurrency?.toUpperCase() ?? null,
    refundId: event.providerRefundId ?? null,
  };
}

export function refundSourceOf(history: unknown): RefundSourceEvidence | null {
  if (!Array.isArray(history)) return null;
  for (const entry of [...history].reverse()) {
    const source =
      entry && typeof entry === "object"
        ? (entry as { refundSource?: unknown }).refundSource
        : null;
    if (!source || typeof source !== "object") continue;
    const value = source as RefundSourceEvidence;
    if (
      (value.basis === "incremental" || value.basis === "cumulative") &&
      (value.amount === null || typeof value.amount === "string") &&
      (value.currency === null || typeof value.currency === "string") &&
      (value.refundId === null || typeof value.refundId === "string")
    )
      return value;
  }
  return null;
}

/** Refund totals follow the original attempt across every replacement receipt. */
export async function postedAttemptRefunds(
  orgId: string,
  attemptId: string,
  currency: string,
): Promise<bigint> {
  const rows = await db.execute<{ amount: string }>(
    sql`
    select amount::text as amount from payment_disputes
     where org_id = ${orgId} and attempt_id = ${attemptId} and kind = 'refund'
       and status = 'posted' and currency = ${currency}
  `,
    "objects",
  );
  return rows.reduce((total, row) => total + toUnits(row.amount), 0n);
}

export function refundDelta(source: RefundSourceEvidence, posted: bigint): bigint | null {
  if (source.amount === null) return null;
  const reported = persistPaymentMoney(source.amount, "refunded amount");
  if (reported < 0n)
    throw new PspAutomationError("The provider's refunded amount cannot be negative.");
  return source.basis === "cumulative" ? (reported > posted ? reported - posted : 0n) : reported;
}
