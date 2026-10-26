import { db, schema } from "../platform/db.ts";
import { isZero, neg, sum } from "../money/money.ts";
import { postEntry } from "../journal/post-entry.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import type { SettlementRateSource } from "./settlement-policy.ts";

export type SettlementApplication = {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceAmount: string;
  sourceTransactionAmount: string;
  sourceTransactionCurrency: string;
  targetTransactionAmount: string;
  targetTransactionCurrency: string;
  settlementRate: string;
  settlementRateSource: SettlementRateSource;
  settlementRateReference: string;
  settlementFxRateId: string | null;
  appliedOn: string;
  controlAdjustment: string;
};

/** Persist validated allocations and their realized FX in the caller's
 * financial transaction. Every caller locks and validates its endpoints. */
export async function writePaymentApplications(input: {
  orgId: string;
  sourceDocumentId: string;
  documentNumber: string;
  bookId: string;
  subsidiaryId: string;
  controlAccountId: string;
  partyId: string;
  functionalCurrency: string;
  postingDate: string;
  periodId: string;
  actorId: string | null;
  gainLossAccountId?: string | null;
  fxIdempotencyKey?: string;
  applications: SettlementApplication[];
}): Promise<string[]> {
  const fxAdjustment = sum(input.applications.map((application) => application.controlAdjustment));
  let fxEntryId: string | null = null;
  if (!isZero(fxAdjustment)) {
    if (!input.gainLossAccountId)
      throw new PaymentError("realized FX gain/loss account is not configured");
    const postedFx = await postEntry(db, {
      orgId: input.orgId,
      bookId: input.bookId,
      subsidiaryId: input.subsidiaryId,
      entryNumber: `${input.documentNumber}-FX`,
      postingDate: input.postingDate,
      periodId: input.periodId,
      memo: `Realized FX settlement — ${input.documentNumber}`,
      sourceDocumentId: input.sourceDocumentId,
      origin: "fx_settlement",
      actorId: input.actorId,
      currency: input.functionalCurrency,
      ...(input.fxIdempotencyKey ? { idempotencyKey: input.fxIdempotencyKey } : {}),
      lines: [
        {
          accountId: input.controlAccountId,
          amount: fxAdjustment,
          partyId: input.partyId,
          memo: `Realized FX settlement — ${input.documentNumber}`,
        },
        {
          accountId: input.gainLossAccountId,
          amount: neg(fxAdjustment),
          memo: `Realized FX settlement — ${input.documentNumber}`,
        },
      ],
    });
    fxEntryId = postedFx.entryId;
  }
  if (!input.applications.length) return [];
  const rows = await db
    .insert(schema.applications)
    .values(
      input.applications.map((application) => ({
        orgId: input.orgId,
        fromLineId: application.fromLineId,
        toLineId: application.toLineId,
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
        fxGainLossEntryId: fxEntryId,
        createdBy: input.actorId,
      })),
    )
    .returning({ id: schema.applications.id });
  if (rows.length !== input.applications.length)
    throw new PaymentError("payment applications could not all be recorded");
  return rows.map((row) => row.id);
}
