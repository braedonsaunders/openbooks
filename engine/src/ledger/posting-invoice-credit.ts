import { cmp, normalizeMoney } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  findMixedCurrencyExposure,
  lockCustomerRole,
  measureCustomerExposure,
  measureLinkedOrderRelief,
  resultingExposureAfterPosting,
} from "../receivables/credit-policy.ts";
import { PostingError } from "./posting-contracts.ts";

export interface PostingInvoiceSubject {
  id: string;
  orgId: string;
  partyId: string | null;
  currency: string;
  total: string;
  documentNumber: string;
}

/**
 * Customer-credit gate for invoice posting (B-SAL-01).
 *
 * Order issuance approves the commitment, but the receivable appears only
 * here: a clerk can convert, partially bill, or write a direct invoice for
 * more than the issued order, and none of that re-runs the issue check.
 * So posting evaluates the same receivables measurement the order path
 * uses — same role-currency denomination, same committed-remainder math,
 * same fail-closed mixed-currency probe — against the invoice about to
 * become a receivable.
 *
 * Posting an order-converted invoice swaps commitment for receivable in one
 * instant, so the linked open-order remainder (capped at the invoice total)
 * is relieved instead of double counting the invoice. A direct invoice has
 * no converting order and relieves nothing.
 *
 * Skips, by design: no party (other validations own that), no active
 * customer role (supported writers always promote one), no configured limit,
 * and invoices in a foreign currency — those cannot be evaluated without
 * FX, so the order-side mixed-currency probe remains their backstop. A
 * missing role currency and a negative limit refuse by name, and a breach
 * refuses with the figures. There is no override reason at posting: the
 * approved-with-reason path stays order-side-only, inside the approval
 * lifecycle where the reason is audited. Callers skip migration replay:
 * re-posting history is not new exposure.
 *
 * Must run inside the posting unit before the receivable commits: the
 * customer_roles row lock serializes concurrent posts against the same
 * customer, so each post re-reads the others' committed invoices.
 */
export async function assertCustomerInvoiceCredit(
  tx: SqlExecutor,
  invoice: PostingInvoiceSubject,
): Promise<void> {
  if (!invoice.partyId) return;
  const role = await lockCustomerRole(tx, invoice.orgId, invoice.partyId);
  if (!role) return;

  // Holds are refused earlier, in prepare: it owns the hold refusal (and its
  // message) and skips migration replay, so this gate never sees a held
  // customer and never re-words that refusal.
  if (role.credit_limit === null) return;
  if (!role.currency) {
    throw new PostingError(
      `customer credit limit has no currency; set a currency on the customer section of the party record before posting invoice ${invoice.documentNumber}`,
    );
  }
  const limit = normalizeMoney(role.credit_limit);
  if (cmp(limit, "0") < 0) {
    throw new PostingError(
      `customer credit limit cannot be negative; correct the credit limit on the customer section of the party record before posting invoice ${invoice.documentNumber}`,
    );
  }
  if (invoice.currency !== role.currency) return;

  const mixedCurrency = await findMixedCurrencyExposure(tx, invoice.orgId, invoice.partyId, role.currency);
  if (mixedCurrency) {
    throw new PostingError(
      `customer has open ${mixedCurrency.kind.replaceAll("_", " ")} exposure in ${mixedCurrency.currency}; credit limit is enforced only in ${role.currency} — settle that ${mixedCurrency.currency} balance before posting invoice ${invoice.documentNumber}`,
    );
  }

  const exposure = await measureCustomerExposure(tx, invoice.orgId, invoice.partyId, role.currency);
  const openOrderExposure = normalizeMoney(exposure.openOrderExposure);
  const unpaidInvoiceExposure = normalizeMoney(exposure.unpaidInvoiceExposure);
  const invoiceTotal = normalizeMoney(invoice.total);
  const relief = await measureLinkedOrderRelief(
    tx,
    invoice.orgId,
    invoice.partyId,
    role.currency,
    invoice.id,
    invoiceTotal,
  );
  const resultingExposure = resultingExposureAfterPosting(
    { openOrderExposure, unpaidInvoiceExposure },
    invoiceTotal,
    relief,
  );
  if (cmp(resultingExposure, limit) > 0) {
    // Converted invoices relieve the linked order, so the order-side credit
    // override stays a live path: bill through a sales order that carries an
    // approved sales_order_credit_override. A direct invoice has no override
    // path at posting — the refusal must say so, not imply one exists.
    const overridePath =
      cmp(normalizeMoney(relief), "0") > 0
        ? ", or bill through a sales order that carries an approved sales_order_credit_override"
        : " — a direct invoice has no override path at posting";
    throw new PostingError(
      `posting invoice ${invoice.documentNumber} would raise customer credit exposure to ${resultingExposure} ${role.currency}, above the ${limit} ${role.currency} limit (open orders ${openOrderExposure}, unpaid invoices ${unpaidInvoiceExposure}, this invoice ${invoiceTotal}): reduce the invoice, collect payment against the open balance, or raise the customer credit limit on the customer section of the party record before posting${overridePath}`,
    );
  }
}
