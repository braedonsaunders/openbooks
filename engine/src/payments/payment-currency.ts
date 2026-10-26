import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { lookupSpotRateWithEvidence } from "../fx/spot-rate.ts";
import { accountingPreferences } from "../organization/accounting-preferences.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { persistPaymentFxRate } from "./settlement-policy.ts";

/** Freeze the receipt's exact functional basis using the native entity/book
 * currency and effective named exchange-rate policy. Missing quotes refuse. */
export async function resolvePaymentCurrencyBasis(
  orgId: string,
  subsidiaryId: string,
  currency: string,
  onDate: string,
) {
  if (!isIso4217CurrencyCode(currency) || !isIsoCalendarDate(onDate))
    throw new PaymentError("Payment currency or accounting date is invalid.");
  const bookId = await paymentBookId(orgId);
  const entity = (
    await db.execute<{ currency: string }>(
      sql`select public.accounting_book_currency(${orgId}, ${bookId}, id) as currency
    from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination for share`,
      "objects",
    )
  )[0];
  if (!entity || !isIso4217CurrencyCode(entity.currency))
    throw new PaymentError(
      "Payment accounting currency is unavailable; review the entity and primary accounting book in Setup.",
    );
  const policy = await accountingPreferences(db, orgId, subsidiaryId, onDate);
  const evidence = await lookupSpotRateWithEvidence(
    db,
    orgId,
    currency,
    entity.currency,
    onDate,
    policy.postingRateType,
  );
  if (evidence.rate === null)
    throw new PaymentError(
      `No ${policy.postingRateType} exchange rate converts ${currency} to ${entity.currency} on ${onDate}; enter the dated quote in Setup → Exchange rates.`,
    );
  return {
    fxRate: persistPaymentFxRate(evidence.rate),
    evidence: { ...evidence, bookId, subsidiaryId, accountingPreferenceId: policy.id },
  };
}
