/** Pure document-to-ledger projection rules. Posting phases are coordinated by posting-document.ts. */
import { abs, add, cmp, isZero, neg, toUnits } from "../money/money.ts";
import {
  addMoney,
  negMoney,
  parseMoney,
  sumMoney,
  ZERO_MONEY,
  type Money,
} from "../money/brands.ts";
import { type DocLine, type KernelLine, PostingError } from "../journal/posting-contracts.ts";
import {
  assertCashTendersPresent,
  assertCloseoutTendersMatchTotal,
  assertTendersMatchTotal,
  expectedTenderedForCloseout,
} from "../sales/cash-tenders.ts";
import {
  internalBillingKernelLines,
  InternalBillingPolicyError,
} from "./internal-billing-policy.ts";
import {
  type RuleFn,
  resolvedLineAccount,
  cardRule,
  tenderMemo,
  dims,
  lineTotal,
  controlOverride,
  settlementOf,
  personalReceivableAmount,
  purchaseBaseAmount,
  purchaseTaxLines,
  salesTaxLines,
} from "./posting-rule-builders.ts";
import {
  controlLineIsOpenItem,
  settledAtNoCharge,
  amortizationSource,
  projectChargeKernelLines,
} from "./posting-rule-support.ts";
export {
  controlLineIsOpenItem,
  noChargeMeasurementLegs,
  projectChargeKernelLines,
} from "./posting-rule-support.ts";

export const RULES: Record<string, RuleFn> = {
  vendor_bill: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      // Inventory item lines DR the clearing/asset account (subledger receives
      // the stock); all other lines DR their expense account.
      accountId: resolvedLineAccount(
        l,
        deps.agencyByLine?.get(l.id)?.accountId ??
          deps.inventoryAssetByLine?.get(l.id) ??
          deps.amortizationByLine?.get(l.id)?.deferralAccountId ??
          l.accountId,
      ),
      amount: purchaseBaseAmount(l, deps), // debit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
      ...amortizationSource(l, deps),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sumMoney([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: negMoney(total), // credit AP
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  customer_invoice: (doc, lines, deps) => {
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
          // term. Gift card lines credit the stored-value liability instead of
          // revenue or deferred revenue: the consideration is owed back to the
          // customer, so it must never read as earned. All other lines credit
          // income directly.
          accountId: resolvedLineAccount(
            l,
            deps.storedValueLiabilityByLine?.get(l.id) ??
              deps.deferralAccountByLine?.get(l.id) ??
              l.accountId,
          ),
          amount: negMoney(l.amount), // credit income / deferred revenue
          memo: l.description,
          partyId: l.partyId ?? doc.partyId,
          // A line earned by another legal entity keeps that entity (consolidated
          // billing across entities); null defaults to the document subsidiary,
          // so single-entity documents post exactly as before.
          subsidiaryId: l.subsidiaryId ?? null,
          ...dims(doc, l),
        },
      ];
    });
    const tax = salesTaxLines(doc, lines, deps, 1);
    const total = sumMoney([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: negMoney(total), // debit AR (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },

  /**
   * Cash sale (sales receipt): paid at the point of sale, so there is no
   * receivable and no open item. The income and tax legs mirror
   * customer_invoice exactly (agency pass-through, deferred-revenue routing,
   * discount lines debiting their discount account); the control leg is
   * replaced by one debit per tender into its clearing or bank account.
   * Tenders must sum to the document total to the minor unit — a mismatch,
   * including any rounding difference, is a named refusal, never a plug.
   */
  cash_sale: (doc, lines, deps) => {
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
  },

  vendor_payment: (doc, lines, deps) => {
    const cash = sumMoney(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    const discount = typeof custom.discountAmount === "string" ? custom.discountAmount : "0";
    const discountAccountId =
      typeof custom.discountAccountId === "string" ? custom.discountAccountId : null;
    if (toUnits(discount) < 0n)
      throw new PostingError("vendor payment discount cannot be negative");
    if (!isZero(discount) && !discountAccountId)
      throw new PostingError("vendor payment discount account is required");
    // Contractor withholding (CIS, § 48 EStG, RCT) deducted at payment: each
    // deduction credits its scheme's liability account, so the payable is
    // relieved by cash + discount + tax withheld.
    const withholdingLegs = new Map<string, Money>();
    const rawWithholdings = custom.withholdings;
    if (
      rawWithholdings !== undefined &&
      rawWithholdings !== null &&
      !Array.isArray(rawWithholdings)
    )
      throw new PostingError("vendor payment withholdings are malformed");
    for (const entry of (rawWithholdings as unknown[] | undefined) ?? []) {
      const row = entry as { liabilityAccountId?: unknown; deducted?: unknown };
      if (typeof row.liabilityAccountId !== "string" || typeof row.deducted !== "string")
        throw new PostingError(
          "vendor payment withholding needs a liability account and an amount",
        );
      if (toUnits(row.deducted) < 0n)
        throw new PostingError("vendor payment withholding cannot be negative");
      withholdingLegs.set(
        row.liabilityAccountId,
        addMoney(
          withholdingLegs.get(row.liabilityAccountId) ?? ZERO_MONEY,
          parseMoney(row.deducted),
        ),
      );
    }
    const withheld = sumMoney([...withholdingLegs.values()]);
    if (
      typeof custom.withholdingAmount === "string" &&
      toUnits(custom.withholdingAmount) !== toUnits(withheld)
    )
      throw new PostingError("vendor payment withholding total does not match its deductions");
    const payable = addMoney(addMoney(cash, discount), withheld);
    return [
      // The AP leg is an OPEN ITEM: it settles against the bills it paid, so it
      // must carry is_open_item to be a valid application source (from_line).
      // controlOverride: a payment against a non-default payable account (a
      // financing sub-account, or a source system with several AP accounts).
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: payable,
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      }, // debit AP
      {
        accountId: lines[0]?.accountId ?? deps.control.bank,
        amount: negMoney(cash),
        ...dims(doc),
      }, // credit bank
      ...(!isZero(discount)
        ? [
            {
              accountId: discountAccountId!,
              amount: negMoney(discount),
              partyId: doc.partyId,
              ...dims(doc),
            },
          ]
        : []),
      ...[...withholdingLegs.entries()]
        .filter(([, amount]) => !isZero(amount))
        .map(([accountId, amount]): KernelLine => ({
          accountId,
          amount: negMoney(amount),
          partyId: doc.partyId,
          memo: "Contractor withholding",
          ...dims(doc),
        })),
    ];
  },

  customer_payment: (doc, lines, deps) => {
    const total = sumMoney(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    // Optional payment-acceptance surcharge: the customer was charged
    // total = invoice portion + fee; the fee leg credits a fee-income account
    // instead of AR, so the AR leg cross-foots to the open-item applications.
    const fee = typeof custom.feeAmount === "string" ? custom.feeAmount : "0";
    const feeAccountId =
      typeof custom.feeIncomeAccountId === "string" ? custom.feeIncomeAccountId : null;
    if (toUnits(fee) < 0n) throw new PostingError("customer payment fee cannot be negative");
    if (cmp(total, "0") < 0) {
      // A refund pays cash OUT (negative total): no payment-acceptance
      // surcharge exists on money returned to the customer, so any fee riding
      // a refund is a data error, refused by name instead of miscompared
      // against a negative receipt.
      if (!isZero(fee))
        throw new PostingError("customer refund cannot carry a payment-acceptance fee");
    } else if (cmp(fee, total) > 0)
      throw new PostingError("customer payment fee exceeds the receipt");
    if (!isZero(fee) && !feeAccountId)
      throw new PostingError("customer payment fee income account is required");
    const receivable = addMoney(total, negMoney(fee));
    // One debit leg per tender account: the bank/cash lines debit bank, and
    // stored-value tender lines debit the liability (a redemption, not a cash
    // receipt). Single-tender payments keep exactly one leg on the first
    // line's account, as before.
    const debitByAccount = new Map<string, ReturnType<typeof lineTotal>[]>();
    for (const line of lines) {
      const accountId = line.accountId ?? deps.control.bank;
      debitByAccount.set(accountId, [...(debitByAccount.get(accountId) ?? []), lineTotal(line)]);
    }
    const debits: KernelLine[] = [...debitByAccount].map(([accountId, amounts]) => ({
      accountId,
      amount: sumMoney(amounts),
      ...dims(doc),
    }));
    return [
      ...debits,
      // The AR leg is an OPEN ITEM: it settles the invoices it paid (from_line).
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: negMoney(receivable),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      }, // credit AR
      ...(!isZero(fee) ? [{ accountId: feeAccountId!, amount: negMoney(fee), ...dims(doc) }] : []), // credit fee income
    ];
  },

  expense_report: (doc, lines, deps) => {
    // Who fronted the money, per line (0171). The three settlements are three
    // different pieces of accounting and post to three different counterparties:
    // out_of_pocket → employee payable (a genuine payable, AP aging);
    // company_paid → card liability (the company already paid; the employee is
    // owed nothing, so this must never become an employee open item);
    // personal → employee receivable (not an expense at all; the sign flips).
    const oop = lines.filter((l) => settlementOf(l) === "out_of_pocket");
    const card = lines.filter((l) => settlementOf(l) === "company_paid");
    const personal = lines.filter((l) => settlementOf(l) === "personal");
    const cardFunded = [...card, ...personal];
    if (cardFunded.length > 0 && !deps.cardLiabilityAccountId) {
      throw new PostingError(
        "company-paid and personal expense lines require a payment card on the report",
      );
    }
    if (personal.length > 0 && !deps.control.employeeReceivable) {
      throw new PostingError(
        "personal expense lines require an employee-receivable control account (orgs.settings.controlAccounts.employeeReceivable)",
      );
    }
    const bookExpense = (ls: DocLine[], cardStamp: boolean): KernelLine[] =>
      ls.map((l) => ({
        accountId: resolvedLineAccount(
          l,
          deps.amortizationByLine?.get(l.id)?.deferralAccountId ?? l.accountId,
        ),
        amount: purchaseBaseAmount(l, deps),
        memo: l.description,
        partyId: l.partyId ?? doc.partyId,
        ...(cardStamp ? { paymentCardId: doc.paymentCardId } : {}),
        ...dims(doc, l),
        ...amortizationSource(l, deps),
      }));
    const oopExpense = bookExpense(oop, false);
    const oopTax = purchaseTaxLines(doc, oop, deps, 1);
    const oopTotal = sumMoney([...oopExpense, ...oopTax].map((l) => l.amount));
    const oopControlId = controlOverride(doc) ?? deps.control.employeePayable ?? deps.control.ap;
    const cardExpense = bookExpense(card, true);
    const cardTax = purchaseTaxLines(doc, card, deps, 1);
    // Personal lines post gross (net + every recoverable input component) to
    // the receivable with no recoverable-tax leg: a non-business charge
    // generates no input tax credit, and claiming one would be a compliance
    // exposure, not a rounding question. Anything but standard calculation on
    // a personal line fails closed rather than posting wrong tax math.
    const personalDebit = personal.map((l) => ({
      accountId: deps.control.employeeReceivable!,
      amount: personalReceivableAmount(l, deps),
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      isOpenItem: controlLineIsOpenItem(
        deps.control.employeeReceivable!,
        l.partyId ?? doc.partyId,
        deps.openItemAccountIds,
      ),
      ...dims(doc, l),
    }));
    const personalTotal = sumMoney(personalDebit.map((l) => l.amount));
    const cardSubtotal = sumMoney([...cardExpense, ...cardTax].map((l) => l.amount));
    return [
      ...oopExpense,
      ...oopTax,
      ...cardExpense,
      ...cardTax,
      ...personalDebit,
      // The out-of-pocket control leg is UNCHANGED from the pre-0171 rule —
      // same account precedence, same party, same open-item derivation — so a
      // report with no card lines regenerates byte-identical math.
      ...(isZero(oopTotal)
        ? []
        : [
            {
              accountId: oopControlId,
              amount: negMoney(oopTotal),
              partyId: doc.partyId,
              isOpenItem: controlLineIsOpenItem(oopControlId, doc.partyId, deps.openItemAccountIds),
              ...dims(doc),
            },
          ]),
      // Card-clearing legs NEVER carry the employee party and are NEVER open
      // items (the cardRule precedent: card legs carry card detail, not party).
      // This one invariant is what keeps company-paid and personal amounts out
      // of every is_open_item reader at once — the dashboard tile, AP aging,
      // openItemsForParty, and the reimbursement run selection — so neither
      // kind can ever reach a reimbursement payment run.
      ...(isZero(sumMoney([cardSubtotal, personalTotal]))
        ? []
        : [
            {
              accountId: deps.cardLiabilityAccountId!,
              amount: negMoney(sumMoney([cardSubtotal, personalTotal])),
              paymentCardId: doc.paymentCardId,
              isOpenItem: false,
              ...dims(doc),
            },
          ]),
    ];
  },

  card_charge: cardRule,
  /** Card refund: the arithmetic reverse of a charge, same posting rule. */
  card_refund: cardRule,

  /** Manual journal: lines carry signed amounts + accounts directly. A line
   *  may name its own subsidiary (intercompany journal); the engine injects
   *  the due-to/due-from legs that keep every subsidiary balanced. */
  journal: (doc, lines, deps) =>
    lines.map((l) => {
      // Line-level entity: a journal line names its own customer/vendor (source
      // systems put the entity on the LINE, e.g. opening-balance journals).
      // Falls back to the header party when the line has none.
      const partyId = l.partyId ?? doc.partyId;
      const accountId = resolvedLineAccount(
        l,
        deps.amortizationByLine?.get(l.id)?.deferralAccountId ?? l.accountId,
      );
      return {
        ...amortizationSource(l, deps),
        accountId,
        amount: parseMoney(l.amount),
        currency:
          doc.journalMode === "currency_adjustment"
            ? (l.journalCurrency ?? doc.currency)
            : (l.journalCurrency ?? undefined),
        fxRate: doc.journalMode === "currency_adjustment" ? "1" : (l.journalFxRate ?? undefined),
        txnAmount: doc.journalMode === "currency_adjustment" && l.journalCurrency ? "0" : l.amount,
        isCurrencyAdjustment: doc.journalMode === "currency_adjustment" && !!l.journalCurrency,
        eliminate: l.journalEliminate ?? false,
        ...(doc.journalMode === "statistical" ? { quantity: l.quantity, unit: l.unit } : {}),
        subsidiaryId: l.subsidiaryId,
        memo: l.description,
        partyId,
        // Entity-bearing AR/AP journal legs are open items. A party-less leg is
        // a direct GL control-account posting and intentionally stays outside
        // aging; manufacturing an anonymous subledger balance would be false.
        isOpenItem:
          doc.journalMode === "currency_adjustment" || doc.journalMode === "statistical"
            ? false
            : controlLineIsOpenItem(accountId, partyId, deps.openItemAccountIds),
        ...dims(doc, l),
      };
    }),

  /**
   * Pay run: the committed payroll GL projection. commitPayRun materialized a
   * balanced, signed line set (DR wages/burden, CR withholding liabilities and
   * per-employee net pay) — the rule maps it 1:1 like a journal. Employee
   * parties ride the net-pay legs so the payable can settle per person.
   */
  pay_run: (doc, lines) =>
    lines.map((l) => {
      const accountId = resolvedLineAccount(l);
      const partyId = l.partyId ?? null;
      const payrollSource = l.custom as Record<string, unknown> | null;
      return {
        accountId,
        amount: parseMoney(l.amount),
        memo: l.description,
        partyId,
        payrollExpense: payrollSource?.["payrollExpense"] === true,
        payComponentId:
          typeof payrollSource?.["payComponentId"] === "string"
            ? payrollSource["payComponentId"]
            : null,
        payrollEmployeePartyId:
          typeof payrollSource?.["employeePartyId"] === "string"
            ? payrollSource["employeePartyId"]
            : null,
        payrollTimeTypeId:
          typeof payrollSource?.["timeTypeId"] === "string" ? payrollSource["timeTypeId"] : null,
        payrollItemId:
          typeof payrollSource?.["itemId"] === "string" ? payrollSource["itemId"] : null,
        // commitPayRun puts a party ONLY on the per-employee net-pay legs —
        // those are open items by construction (settled by the payment
        // journal), regardless of the payable account's configured type.
        isOpenItem: partyId != null,
        ...dims(doc, l),
      };
    }),

  /**
   * Check: a direct bank disbursement. DR the line accounts (expense or the
   * AP/liability being paid), CR bank. Like vendor_payment but the debit side
   * is the document's own line accounts. Purchase-side tax (taxPaid).
   */
  check: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => {
      const accountId = resolvedLineAccount(l);
      return {
        accountId,
        amount: purchaseBaseAmount(l, deps), // debit net + nonrecoverable tax
        memo: l.description,
        partyId: l.partyId ?? doc.partyId,
        // A check written against an AR/AP control account settles the open
        // items it pays (the bills behind that balance) exactly like the AP leg
        // of a vendor_payment: the entity-bearing control leg must carry
        // is_open_item to be a valid application source. A party-less leg is a
        // direct GL control posting and stays outside aging.
        isOpenItem: controlLineIsOpenItem(
          accountId,
          l.partyId ?? doc.partyId,
          deps.openItemAccountIds,
        ),
        ...dims(doc, l),
      };
    });
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sumMoney([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        // The funding bank is the doc's control-account override, else the
        // org default bank — the same contract as `deposit`: a check drawn on
        // a non-default account must credit that account, not the default.
        accountId: controlOverride(doc) ?? deps.control.bank,
        amount: negMoney(total), // credit bank
        ...dims(doc),
      },
    ];
  },

  /**
   * Deposit (Make Deposits): DR the destination bank (the doc's control-account
   * override, else the org default bank) for the sum of the source lines, CR
   * each source account. The mirror of `check`.
   */
  deposit: (doc, lines, deps) => {
    const sources: KernelLine[] = lines.map((l) => {
      const partyId = l.partyId ?? doc.partyId;
      const accountId = resolvedLineAccount(l);
      return {
        accountId,
        amount: negMoney(parseMoney(l.amount)), // credit each source
        memo: l.description,
        partyId,
        // A deposit can settle an AR/AP credit (for example cash received for
        // a vendor credit). Preserve that entity-bearing control leg as an
        // application source; ordinary income/clearing sources stay non-open.
        isOpenItem: controlLineIsOpenItem(accountId, partyId, deps.openItemAccountIds),
        ...dims(doc, l),
      };
    });
    const total = sumMoney(lines.map((l) => l.amount)); // positive = money in
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.bank,
        amount: total,
        ...dims(doc),
      }, // debit bank
      ...sources,
    ];
  },

  /**
   * Transfer: move ONE amount between two bank accounts (DR destination, CR
   * source). Kernel contract — the same shape every native importer emits:
   * exactly two ordered lines, line 0 = DESTINATION carrying the positive
   * amount, line 1 = SOURCE naming only its account with a zero amount. The
   * rule rejects anything else at the posting boundary — one or three legs,
   * a nonzero source leg (equal OR differing amounts), duplicate accounts,
   * non-positive amounts — so no caller (drawer, API, MCP) can post a
   * transfer worth double its entered amount: summing both legs produced
   * DR 200/CR 200 for a $100 transfer while still balancing.
   */
  transfer: (doc, lines) => {
    if (lines.length !== 2)
      throw new PostingError(
        "transfer needs exactly two lines: the destination line carries the amount, the source line carries zero",
      );
    const dest = lines[0]!,
      src = lines[1]!;
    if (!dest.accountId || !src.accountId)
      throw new PostingError(
        "transfer lines must name both the destination and the source account",
      );
    if (dest.accountId === src.accountId)
      throw new PostingError("transfer destination and source must be different accounts");
    if (toUnits(dest.amount) <= 0n) throw new PostingError("transfer amount must be positive");
    if (!isZero(src.amount))
      throw new PostingError(
        "transfer amount must ride exactly one line: the source leg must carry zero",
      );
    return [
      {
        accountId: dest.accountId,
        // Validated positive above via toUnits: parse once for the brand.
        amount: parseMoney(dest.amount),
        ...dims(doc),
      }, // debit destination
      {
        accountId: src.accountId,
        amount: negMoney(parseMoney(dest.amount)),
        ...dims(doc),
      }, // credit source
    ];
  },

  /** Vendor credit memo: DR AP / CR expense or inventory-return variance + tax. */
  vendor_credit: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: resolvedLineAccount(l, deps.inventoryReturnOffsetByLine?.get(l.id) ?? l.accountId),
      amount: negMoney(purchaseBaseAmount(l, deps)), // credit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, -1);
    const total = sumMoney([...expense, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: negMoney(total), // debit AP (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...expense,
      ...tax,
    ];
  },

  /** Customer credit memo: the reverse of customer_invoice. DR income / CR AR + tax. */
  customer_credit: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      accountId: resolvedLineAccount(l),
      amount: parseMoney(l.amount), // debit income (reverse of invoice)
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, -1);
    const total = sumMoney([...income, ...tax].map((l) => l.amount));
    // A "refund to store credit" memo credits the store-credit liability
    // instead of AR: no open item is created, and the stored-value effect
    // mints the customer account against this journal.
    const creditLeg: KernelLine = deps.storeCreditLiabilityAccountId
      ? {
          accountId: deps.storeCreditLiabilityAccountId,
          amount: negMoney(total), // credit store-credit liability
          partyId: doc.partyId,
          ...dims(doc),
        }
      : {
          accountId: controlOverride(doc) ?? deps.control.ar,
          amount: negMoney(total), // credit AR (total is positive)
          partyId: doc.partyId,
          dueDate: doc.dueDate,
          isOpenItem: true,
          ...dims(doc),
        };
    return [creditLeg, ...income, ...tax];
  },

  /**
   * Cash refund: the reverse of a cash sale. Revenue and tax legs mirror
   * customer_credit (debit income, reverse the sales tax); each tender pays
   * out of its clearing or bank account. Lines that restock carry
   * inventory-return evidence and restore stock at original cost through the
   * customer-return engine; lines without it (damaged goods, fee adjustments)
   * are purely financial. Tenders must sum to the refund total, as on a sale.
   */
  cash_refund: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      accountId: resolvedLineAccount(l),
      amount: parseMoney(l.amount), // debit income (reverse of cash sale)
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, -1);
    const incomeAndTax = sumMoney([...income, ...tax].map((l) => l.amount));
    const tenders = deps.cashTenders ?? [];
    assertCashTendersPresent(tenders, abs(incomeAndTax), doc.documentNumber, "cash refund");
    if (tenders.length === 0)
      return settledAtNoCharge(doc, lines, [...income, ...tax], deps, "-1", "cash refund");
    assertTendersMatchTotal(tenders, incomeAndTax, doc.documentNumber, "cash refund");
    return [
      // Payout legs mirror the sale's tender legs: no party, never open items.
      ...tenders.map((t): KernelLine => ({
        accountId: t.accountId,
        amount: negMoney(t.amount), // credit clearing/bank
        memo: tenderMemo(t),
        ...dims(doc),
      })),
      ...income,
      ...tax,
    ];
  },

  /**
   * Project charge / resource usage — allocate a pooled, already-incurred cost
   * onto a project at a cost rate. Per line: DEBIT the target project-COGS
   * account carrying the PROJECT dimension (the job now bears the cost), and
   * CREDIT the source cost pool with NO project (relieve the untagged pool that
   * the original bulk vendor bill posted into). When the item has no dedicated
   * recovery account the credit is the same account as the debit — a pure
   * dimensional reclass (net-zero to the account total, re-attributed to the
   * project), so there is no double-count. A dedicated recovery account instead
   * gives absorption tracking (e.g. owned-equipment recovery vs depreciation).
   * The line's billable rate/markup rides on is_billable for T&M billing; it is
   * NOT posted here (revenue posts at invoice time).
   */
  project_charge: projectChargeKernelLines,

  /**
   * Internal billing: each line debits the rule's debit account with the
   * receiver's dimensions and credits the rule's credit account with the
   * provider's (see internal-billing-policy.ts). An intercompany sale lands
   * its debit in the receiving subsidiary; the kernel then adds the
   * due-to/due-from legs. Policy refusals surface as posting refusals.
   */
  internal_billing: (doc, lines, deps) => {
    try {
      return internalBillingKernelLines(doc, lines, deps.internalBilling);
    } catch (error) {
      if (error instanceof InternalBillingPolicyError) throw new PostingError(error.message);
      throw error;
    }
  },
};
