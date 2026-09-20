/** Pure document-to-ledger projection rules. Transaction orchestration remains in posting.ts. */
import { add, cmp, isZero, neg, sum, toUnits } from "../money/money.ts";
import { type Doc, type DocLine, type KernelLine, type PostingDeps, type ExpenseSettlement, PostingError } from "./posting-contracts.ts";
import { componentsForLine, assertTaxControlAccount } from "./posting-tax-policy.ts";
export { componentsForLine, validateTaxControlAccounts } from "./posting-tax-policy.ts";
export { type PostingDocument, type PostingDocumentLine, type Doc, type DocLine, type KernelLine, type PostingDeps, type TaxPostingComponent, type ExpenseSettlement, PostingError } from "./posting-contracts.ts";
/**
 * An AR/AP journal line participates in the subledger only when it identifies
 * the customer/vendor whose balance it changes. source platform permits direct GL
 * journals to control accounts without an entity; those remain legitimate
 * control-account GL activity, but must not become anonymous aging items.
 */
export function controlLineIsOpenItem(
  accountId: string,
  partyId: string | null | undefined,
  openItemAccountIds?: ReadonlySet<string>,
): boolean {
  return partyId != null && openItemAccountIds?.has(accountId) === true;
}

type RuleFn = (doc: Doc, lines: DocLine[], deps: PostingDeps) => KernelLine[];

/** Resolve a document line's posting account before it reaches any SQL binder. */
function resolvedLineAccount(
  line: DocLine,
  resolved: unknown = line.accountId,
): string {
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new PostingError(
      `document line ${line.lineNumber} has no resolvable account`,
    );
  }
  return resolved;
}

/**
 * Card charge / refund. A charge DRs its expense lines and CRs the card's
 * liability control account; a refund is the arithmetic reverse and rides the
 * same rule with negative line amounts (its detail is stored already signed).
 * The liability account is the doc's `controlAccountId` override (the per-card
 * employee sub-account source platform used) else the resolved card liability.
 */
const cardRule: RuleFn = (doc, lines, deps) => {
  const expense: KernelLine[] = lines.map((l) => ({
    accountId: resolvedLineAccount(l),
    amount: purchaseBaseAmount(l, deps),
    memo: l.description,
    partyId: l.partyId ?? doc.partyId,
    paymentCardId: doc.paymentCardId,
    ...dims(doc, l),
  }));
  const tax = purchaseTaxLines(doc, lines, deps, 1);
  const total = sum([...expense, ...tax].map((l) => l.amount));
  const cardLiability = controlOverride(doc) ?? deps.cardLiabilityAccountId;
  if (!cardLiability)
    throw new PostingError("card_charge requires a payment card");
  return [
    ...expense,
    ...tax,
    {
      accountId: cardLiability,
      amount: neg(total),
      paymentCardId: doc.paymentCardId,
      ...dims(doc),
    },
  ];
};

const dims = (d: Doc, l?: DocLine) => ({
  departmentId: l?.departmentId ?? d.departmentId,
  projectId: l?.projectId ?? d.projectId,
  locationId: l?.locationId ?? d.locationId,
  classId: l?.classId ?? d.classId,
  equipmentUnitId: l?.equipmentUnitId ?? null,
  extraDims: {
    ...((d.extraDims ?? {}) as Record<string, string>),
    ...((l?.extraDims ?? {}) as Record<string, string>),
  },
});

/**
 * Tax-control legs settle an amount with a tax authority; they are not
 * project cost or revenue. Nonrecoverable purchase tax is already capitalized
 * into the originating detail line by purchaseBaseAmount, so carrying the
 * project onto the recoverable/output control leg would double-state project
 * activity in balance-sheet categories. Preserve the other analytical context
 * for statutory reporting, but explicitly clear project/equipment dimensions.
 */
const taxControlDims = (d: Doc, l: DocLine) => ({
  departmentId: l.departmentId ?? d.departmentId,
  projectId: null,
  locationId: l.locationId ?? d.locationId,
  classId: l.classId ?? d.classId,
  equipmentUnitId: null,
  extraDims: {
    ...((d.extraDims ?? {}) as Record<string, string>),
    ...((l.extraDims ?? {}) as Record<string, string>),
  },
});

/** Pure GL projection for a financial equipment/resource charge. The debit is
 * job cost; the credit relieves a distinct recovery pool. Keeping this helper
 * exported makes the accounting invariant directly testable. */
export function projectChargeKernelLines(
  doc: Doc,
  lines: DocLine[],
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    const accountId = resolvedLineAccount(line);
    if (!line.recoveryAccountId)
      throw new PostingError("project charge requires a cost recovery account");
    if (line.recoveryAccountId === accountId) {
      throw new PostingError(
        "project charge cost and recovery accounts must be different",
      );
    }
    out.push({
      accountId,
      amount: line.amount,
      memo: line.description,
      ...dims(doc, line),
    });
    out.push({
      accountId: line.recoveryAccountId,
      amount: neg(line.amount),
      memo: line.description,
      departmentId: doc.departmentId,
      locationId: doc.locationId,
      classId: doc.classId,
      projectId: null,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: (doc.extraDims ?? {}) as Record<string, string>,
    });
  }
  return out;
}

const lineTotal = (l: DocLine) => add(l.amount, l.taxAmount ?? "0");

/**
 * The payable/receivable/card-liability/bank control account a document should post
 * to. source platform lets a transaction choose its own AP/AR/financing/funding account on the
 * header (usually the org default, but sometimes a financing sub-account like
 * "Ford Credit" or a per-card employee liability). We surface that choice as
 * `doc.custom.controlAccountId`; when present it wins over the org default.
 */
const controlOverride = (doc: Doc): string | undefined => {
  const c = (doc.custom as Record<string, unknown> | null)?.controlAccountId;
  return typeof c === "string" && c ? c : undefined;
};

function signed(amount: string, direction: 1 | -1): string {
  return direction === 1 ? amount : neg(amount);
}

/**
 * Who fronted the money for an expense line (0171). Fail closed on anything
 * outside the migration's CHECK values: a future settlement kind must be
 * taught to the kernel deliberately, never defaulted into the wrong
 * counterparty. Non-expense kinds never call this (their lines ignore the
 * column), so an unexpected value here is always a real data fault.
 */
export function settlementOf(line: Pick<DocLine, "lineNumber" | "settlementType">): ExpenseSettlement {
  const s: unknown = line.settlementType ?? "out_of_pocket";
  if (s === "out_of_pocket" || s === "company_paid" || s === "personal") return s;
  throw new PostingError(
    `document line ${line.lineNumber} has unknown settlement type ${JSON.stringify(s)}`,
  );
}

/**
 * What a personal line debits to the employee receivable: the full economic
 * amount (net + nonrecoverable + every recoverable input component). Only
 * standard calculation is supportable — withholding and reverse charge have
 * no meaning on a non-business charge, so they fail closed here instead of
 * posting a tax leg the receivable must never carry.
 */
function personalReceivableAmount(line: DocLine, deps: PostingDeps): string {
  let recoverable = "0";
  for (const c of componentsForLine(line, deps)) {
    if (c.calculationType !== "standard") {
      throw new PostingError(
        `personal expense line ${line.lineNumber} cannot carry ${c.calculationType} tax`,
      );
    }
    recoverable = add(recoverable, c.recoverableAmount);
  }
  return add(purchaseBaseAmount(line, deps), recoverable);
}

/** Expense/inventory basis includes only the nonrecoverable purchase tax. */
function purchaseBaseAmount(line: DocLine, deps: PostingDeps): string {
  const nonrecoverable = sum(
    componentsForLine(line, deps)
      .filter((c) => c.calculationType !== "withholding")
      .map((c) => c.nonrecoverableAmount),
  );
  return add(line.amount, nonrecoverable);
}

/**
 * Purchase tax projection:
 * - standard: recoverable input tax only (nonrecoverable was capitalized above)
 * - withholding: credit the statutory withholding payable
 * - reverse charge: debit recoverable input, credit full output liability;
 *   nonrecoverable input remains in expense/inventory.
 */
function purchaseTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps)) {
      const common = {
        taxCodeId: component.taxCodeId,
        partyId: line.partyId ?? doc.partyId,
        ...taxControlDims(doc, line),
      };
      if (component.calculationType === "withholding") {
        out.push({
          ...common,
          accountId: assertTaxControlAccount(component, deps, "withholding"),
          amount: signed(neg(component.taxAmount), direction),
        });
        continue;
      }
      if (!isZero(component.recoverableAmount)) {
        out.push({
          ...common,
          accountId: assertTaxControlAccount(component, deps, "paid"),
          amount: signed(component.recoverableAmount, direction),
        });
      }
      if (
        component.calculationType === "reverse_charge" &&
        !isZero(component.taxAmount)
      ) {
        out.push({
          ...common,
          accountId: assertTaxControlAccount(component, deps, "collected"),
          amount: signed(neg(component.taxAmount), direction),
        });
      }
    }
  }
  return out;
}

/** Sales tax projection: standard output liability, withholding receivable. */
function salesTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps)) {
      const common = {
        taxCodeId: component.taxCodeId,
        partyId: line.partyId ?? doc.partyId,
        ...taxControlDims(doc, line),
      };
      if (component.calculationType === "reverse_charge") continue;
      if (component.calculationType === "withholding") {
        out.push({
          ...common,
          accountId: assertTaxControlAccount(component, deps, "withholding"),
          amount: signed(component.taxAmount, direction),
        });
      } else {
        out.push({
          ...common,
          accountId: assertTaxControlAccount(component, deps, "collected"),
          amount: signed(neg(component.taxAmount), direction),
        });
      }
    }
  }
  return out;
}

export const RULES: Record<string, RuleFn> = {
  vendor_bill: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      // Inventory item lines DR the clearing/asset account (subledger receives
      // the stock); all other lines DR their expense account.
      accountId: resolvedLineAccount(
        l,
        deps.inventoryAssetByLine?.get(l.id) ?? l.accountId,
      ),
      amount: purchaseBaseAmount(l, deps), // debit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: neg(total), // credit AP
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  customer_invoice: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      // Rev-rec lines credit deferred revenue; recognition drains it over the
      // term. All other lines credit income directly.
      accountId: resolvedLineAccount(
        l,
        deps.deferralAccountByLine?.get(l.id) ?? l.accountId,
      ),
      amount: neg(l.amount), // credit income / deferred revenue
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, 1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(total), // debit AR (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },

  vendor_payment: (doc, lines, deps) => {
    const cash = sum(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    const discount =
      typeof custom.discountAmount === "string" ? custom.discountAmount : "0";
    const discountAccountId =
      typeof custom.discountAccountId === "string"
        ? custom.discountAccountId
        : null;
    if (toUnits(discount) < 0n)
      throw new PostingError("vendor payment discount cannot be negative");
    if (!isZero(discount) && !discountAccountId)
      throw new PostingError("vendor payment discount account is required");
    const payable = add(cash, discount);
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
        amount: neg(cash),
        ...dims(doc),
      }, // credit bank
      ...(!isZero(discount)
        ? [
            {
              accountId: discountAccountId!,
              amount: neg(discount),
              partyId: doc.partyId,
              ...dims(doc),
            },
          ]
        : []),
    ];
  },

  customer_payment: (doc, lines, deps) => {
    const total = sum(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    // Optional payment-acceptance surcharge: the customer was charged
    // total = invoice portion + fee; the fee leg credits a fee-income account
    // instead of AR, so the AR leg cross-foots to the open-item applications.
    const fee = typeof custom.feeAmount === "string" ? custom.feeAmount : "0";
    const feeAccountId =
      typeof custom.feeIncomeAccountId === "string"
        ? custom.feeIncomeAccountId
        : null;
    if (toUnits(fee) < 0n)
      throw new PostingError("customer payment fee cannot be negative");
    if (cmp(fee, total) > 0)
      throw new PostingError("customer payment fee exceeds the receipt");
    if (!isZero(fee) && !feeAccountId)
      throw new PostingError("customer payment fee income account is required");
    const receivable = add(total, neg(fee));
    return [
      {
        accountId: lines[0]?.accountId ?? deps.control.bank,
        amount: total,
        ...dims(doc),
      }, // debit bank
      // The AR leg is an OPEN ITEM: it settles the invoices it paid (from_line).
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(receivable),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      }, // credit AR
      ...(!isZero(fee)
        ? [{ accountId: feeAccountId!, amount: neg(fee), ...dims(doc) }]
        : []), // credit fee income
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
        accountId: resolvedLineAccount(l),
        amount: purchaseBaseAmount(l, deps),
        memo: l.description,
        partyId: l.partyId ?? doc.partyId,
        ...(cardStamp ? { paymentCardId: doc.paymentCardId } : {}),
        ...dims(doc, l),
      }));
    const oopExpense = bookExpense(oop, false);
    const oopTax = purchaseTaxLines(doc, oop, deps, 1);
    const oopTotal = sum([...oopExpense, ...oopTax].map((l) => l.amount));
    const oopControlId =
      controlOverride(doc) ??
      deps.control.employeePayable ??
      deps.control.ap;
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
        (l.partyId ?? doc.partyId),
        deps.openItemAccountIds,
      ),
      ...dims(doc, l),
    }));
    const personalTotal = sum(personalDebit.map((l) => l.amount));
    const cardSubtotal = sum([...cardExpense, ...cardTax].map((l) => l.amount));
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
              amount: neg(oopTotal),
              partyId: doc.partyId,
              isOpenItem: controlLineIsOpenItem(
                oopControlId,
                doc.partyId,
                deps.openItemAccountIds,
              ),
              ...dims(doc),
            },
          ]),
      // Card-clearing legs NEVER carry the employee party and are NEVER open
      // items (the cardRule precedent: card legs carry card detail, not party).
      // This one invariant is what keeps company-paid and personal amounts out
      // of every is_open_item reader at once — the dashboard tile, AP aging,
      // openItemsForParty, and the reimbursement run selection — so neither
      // kind can ever reach a reimbursement payment run.
      ...(isZero(sum([cardSubtotal, personalTotal]))
        ? []
        : [
            {
              accountId: deps.cardLiabilityAccountId!,
              amount: neg(sum([cardSubtotal, personalTotal])),
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
      const accountId = resolvedLineAccount(l);
      return {
        accountId,
        amount: l.amount,
        subsidiaryId: l.subsidiaryId,
        memo: l.description,
        partyId,
        // Entity-bearing AR/AP journal legs are open items. A party-less leg is
        // a direct GL control-account posting and intentionally stays outside
        // aging; manufacturing an anonymous subledger balance would be false.
        isOpenItem: controlLineIsOpenItem(
          accountId,
          partyId,
          deps.openItemAccountIds,
        ),
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
      return {
        accountId,
        amount: l.amount,
        memo: l.description,
        partyId,
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
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        // The funding bank is the doc's control-account override, else the
        // org default bank — the same contract as `deposit`: a check drawn on
        // a non-default account must credit that account, not the default.
        accountId: controlOverride(doc) ?? deps.control.bank,
        amount: neg(total), // credit bank
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
        amount: neg(l.amount), // credit each source
        memo: l.description,
        partyId,
        // A deposit can settle an AR/AP credit (for example cash received for
        // a vendor credit). Preserve that entity-bearing control leg as an
        // application source; ordinary income/clearing sources stay non-open.
        isOpenItem: controlLineIsOpenItem(
          accountId,
          partyId,
          deps.openItemAccountIds,
        ),
        ...dims(doc, l),
      };
    });
    const total = sum(lines.map((l) => l.amount)); // positive = money in
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
    const dest = lines[0]!, src = lines[1]!;
    if (!dest.accountId || !src.accountId)
      throw new PostingError(
        "transfer lines must name both the destination and the source account",
      );
    if (dest.accountId === src.accountId)
      throw new PostingError(
        "transfer destination and source must be different accounts",
      );
    if (toUnits(dest.amount) <= 0n)
      throw new PostingError("transfer amount must be positive");
    if (!isZero(src.amount))
      throw new PostingError(
        "transfer amount must ride exactly one line: the source leg must carry zero",
      );
    return [
      {
        accountId: dest.accountId,
        amount: dest.amount,
        ...dims(doc),
      }, // debit destination
      {
        accountId: src.accountId,
        amount: neg(dest.amount),
        ...dims(doc),
      }, // credit source
    ];
  },

  /** Vendor credit memo: DR AP / CR expense or inventory-return variance + tax. */
  vendor_credit: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: resolvedLineAccount(
        l,
        deps.inventoryReturnOffsetByLine?.get(l.id) ?? l.accountId,
      ),
      amount: neg(purchaseBaseAmount(l, deps)), // credit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, -1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: neg(total), // debit AP (total is negative)
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
      amount: l.amount, // debit income (reverse of invoice)
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, -1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(total), // credit AR (total is positive)
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
};

/**
 * Application-layer proof immediately before a ledger write. PostgreSQL
 * repeats these assertions at the deferred-constraint boundary; keeping both
 * defenses independent turns a malformed projection into a readable posting
 * error before any journal row is inserted.
 */
export function assertFinalKernelBalance(
  lines: readonly { amount: string; subsidiaryId: string }[],
): void {
  if (lines.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(lines.map((line) => line.amount));
  if (!isZero(total))
    throw new PostingError(
      `functional-currency journal does not balance (sum=${total})`,
    );
  const bySubsidiary = new Map<string, string[]>();
  for (const line of lines) {
    const amounts = bySubsidiary.get(line.subsidiaryId) ?? [];
    amounts.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, amounts);
  }
  for (const [subsidiaryId, amounts] of bySubsidiary) {
    const subsidiaryTotal = sum(amounts);
    if (!isZero(subsidiaryTotal)) {
      throw new PostingError(
        `functional-currency journal does not balance for subsidiary ${subsidiaryId} (sum=${subsidiaryTotal})`,
      );
    }
  }
}

/**
 * Credit memos are stated in their own direction — positive lines, positive
 * total — with the kernel flipping the sign at posting. A negative-total
 * credit would post backwards: a customer credit becomes a shadow invoice
 * (debit AR, credit income) outside every invoice-gated control, from
 * dunning to capacity, and a vendor credit becomes a shadow bill (debit
 * expense, credit AP). A balance owed by the customer is an invoice; a
 * balance owed to a vendor is a bill. Migrations replaying source-system
 * history pass migration=true and are unaffected.
 */
export function assertCreditMemoDirection(
  doc: Pick<Doc, "kind" | "total">,
  migration?: boolean,
): void {
  if (doc.kind === "customer_credit" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a credit memo must carry a positive total; a negative balance owed by the customer is an invoice`,
    );
  }
  if (doc.kind === "vendor_credit" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a credit memo must carry a positive total; a negative balance owed to the vendor is a bill`,
    );
  }
}
