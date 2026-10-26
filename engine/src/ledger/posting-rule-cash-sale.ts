/**
 * Cash-sale ledger projection.
 *
 * Kept beside posting-rules.ts so the rules module stays within the line bound.
 * The rules table still exposes this projection as `cash_sale`.
 */
import { abs, add, cmp, neg } from "../money/money.ts";

import { negMoney, sumMoney } from "../money/brands.ts";

import { type KernelLine, PostingError } from "../journal/posting-contracts.ts";

import {
  assertCashTendersPresent,
  assertCloseoutTendersMatchTotal,
  assertTendersMatchTotal,
  expectedTenderedForCloseout,
} from "../sales/cash-tenders.ts";

import {
  type RuleFn,
  resolvedLineAccount,
  tenderMemo,
  dims,
  salesTaxLines,
} from "./posting-rule-builders.ts";

import { settledAtNoCharge } from "./posting-rule-support.ts";

/**
 * Cash sale (sales receipt): paid at the point of sale, so there is no
 * receivable and no open item. The income and tax legs mirror
 * customer_invoice exactly (agency pass-through, deferred-revenue routing,
 * discount lines debiting their discount account); the control leg is
 * replaced by one debit per tender into its clearing or bank account.
 * Tenders must sum to the document total to the minor unit — a mismatch,
 * including any rounding difference, is a named refusal, never a plug.
 */
export const cashSaleRule: RuleFn = (doc, lines, deps) => {
  const income: KernelLine[] = lines.flatMap((l): KernelLine[] => {
    const agency = deps.agencyByLine?.get(l.id);
    if (agency)
      return [
        {
          accountId: resolvedLineAccount(l),
          amount: negMoney(add(l.amount, neg(agency.vendorAmount))),
          memo: l.description,
          partyId: l.partyId ?? doc.partyId,
          ...dims(doc, l),
        },
        {
          accountId: agency.accountId,
          amount: negMoney(agency.vendorAmount),
          memo: "Vendor pass-through consideration",
          partyId: l.partyId ?? doc.partyId,
          ...dims(doc, l),
        },
      ];
    return [
      {
        // Rev-rec lines credit deferred revenue; recognition drains it over the
        // term. All other lines credit income directly.
        accountId: resolvedLineAccount(l, deps.deferralAccountByLine?.get(l.id) ?? l.accountId),
        amount: negMoney(l.amount), // credit income / deferred revenue
        memo: l.description,
        partyId: l.partyId ?? doc.partyId,
        ...dims(doc, l),
      },
    ];
  });
  const tax = salesTaxLines(doc, lines, deps, 1);
  const incomeAndTax = sumMoney([...income, ...tax].map((l) => l.amount));
  // Tenders arrive resolved from document_tenders (prepare/replay); an
  // empty set refuses here rather than posting an unsettled sale, unless
  // there is exactly nothing to tender.
  const tenders = deps.cashTenders ?? [];
  // A close-out re-states the cross-foot explicitly: the till collects the
  // document total plus card tips, net of processor fees and the counted
  // over/short. Without one the tenders must match the total exactly.
  const closeout = deps.cashCloseout ?? null;
  assertCashTendersPresent(
    tenders,
    closeout
      ? expectedTenderedForCloseout(
          abs(incomeAndTax),
          closeout.tipsTotal,
          closeout.feeTotal,
          closeout.overShort,
        )
      : abs(incomeAndTax),
    doc.documentNumber,
    "cash sale",
  );
  if (tenders.length === 0)
    return settledAtNoCharge(doc, lines, [...income, ...tax], deps, "1", "cash sale");
  if (closeout) {
    assertCloseoutTendersMatchTotal(tenders, incomeAndTax, closeout, doc.documentNumber);
    if (cmp(closeout.tipsTotal, "0") !== 0 && !closeout.tipsPayableAccountId) {
      throw new PostingError(
        `cash sale ${doc.documentNumber} records tips with no tips-payable liability — ` +
          `set the Tips payable account in Setup → Company & Accounting → Control accounts, then repost`,
      );
    }
    if (cmp(closeout.feeTotal, "0") !== 0 && !closeout.processorFeeAccountId) {
      throw new PostingError(
        `cash sale ${doc.documentNumber} records processor fees with no fee expense account — ` +
          `set the Processor fees account in Setup → Company & Accounting → Control accounts, then repost`,
      );
    }
    if (cmp(closeout.overShort, "0") !== 0 && !closeout.cashOverShortAccountId) {
      throw new PostingError(
        `cash sale ${doc.documentNumber} records cash over/short with no over/short account — ` +
          `set the Cash over/short account in Setup → Company & Accounting → Control accounts, then repost`,
      );
    }
  } else {
    assertTendersMatchTotal(tenders, incomeAndTax, doc.documentNumber, "cash sale");
  }
  return [
    // Tender legs are bank legs, not AR legs: they carry no party and are
    // never open items, so a paid sale can never appear in aging, dunning,
    // or statements of balance.
    ...tenders.map((t): KernelLine => ({
      accountId: t.accountId,
      amount: t.amount, // debit clearing/bank
      memo: tenderMemo(t),
      ...dims(doc),
    })),
    // Tips are staff money held for pay-out, never revenue: credit the
    // liability tagged with the server's party when the sale names one
    // (payroll pays per employee), otherwise pooled for the house split.
    ...(closeout && cmp(closeout.tipsTotal, "0") !== 0
      ? [
          {
            accountId: closeout.tipsPayableAccountId!,
            amount: negMoney(closeout.tipsTotal),
            memo: `Card tips — cash sale ${doc.documentNumber}`,
            partyId: closeout.serverPartyId,
            ...dims(doc),
          } satisfies KernelLine,
        ]
      : []),
    // Processor fees are a selling cost of this sale, booked gross so the
    // deposit reconciles net — never netted against revenue.
    ...(closeout && cmp(closeout.feeTotal, "0") !== 0
      ? [
          {
            accountId: closeout.processorFeeAccountId!,
            amount: closeout.feeTotal,
            memo: `Processor fees — cash sale ${doc.documentNumber}`,
            ...dims(doc),
          } satisfies KernelLine,
        ]
      : []),
    // The counted over/short: an over credits the account as other income,
    // a short debits it as an expense — one signed leg either way.
    ...(closeout && cmp(closeout.overShort, "0") !== 0
      ? [
          {
            accountId: closeout.cashOverShortAccountId!,
            amount: negMoney(closeout.overShort),
            memo:
              cmp(closeout.overShort, "0") > 0
                ? `Cash over — cash sale ${doc.documentNumber}`
                : `Cash short — cash sale ${doc.documentNumber}`,
            ...dims(doc),
          } satisfies KernelLine,
        ]
      : []),
    ...income,
    ...tax,
  ];
};
