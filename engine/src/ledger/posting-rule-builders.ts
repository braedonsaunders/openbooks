/** Kernel line builders for the posting rules table: account resolution, tax lines, tender memos and settlement amounts. */
import { add, isZero, neg } from "../money/money.ts";
import { addMoney, negMoney, parseMoney, sumMoney, type Money } from "../money/brands.ts";
import {
  type Doc,
  type DocLine,
  type KernelLine,
  type PostingDeps,
  type ExpenseSettlement,
  PostingError,
} from "../journal/posting-contracts.ts";
import { componentsForLine, assertTaxControlAccount } from "./posting-tax-policy.ts";

export type RuleFn = (doc: Doc, lines: DocLine[], deps: PostingDeps) => KernelLine[];

/** Resolve a document line's posting account before it reaches any SQL binder. */
export function resolvedLineAccount(line: DocLine, resolved: unknown = line.accountId): string {
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new PostingError(`document line ${line.lineNumber} has no resolvable account`);
  }
  return resolved;
}

/**
 * Card charge / refund. A charge DRs its expense lines and CRs the card's
 * liability control account; a refund is the arithmetic reverse and rides the
 * same rule with negative line amounts (its detail is stored already signed).
 * The liability account is the doc's `controlAccountId` override (e.g. a
 * per-card employee sub-account) else the resolved card liability.
 */
export const cardRule: RuleFn = (doc, lines, deps) => {
  const expense: KernelLine[] = lines.map((l) => ({
    accountId: resolvedLineAccount(l),
    amount: purchaseBaseAmount(l, deps),
    memo: l.description,
    partyId: l.partyId ?? doc.partyId,
    paymentCardId: doc.paymentCardId,
    ...dims(doc, l),
  }));
  const tax = purchaseTaxLines(doc, lines, deps, 1);
  const total = sumMoney([...expense, ...tax].map((l) => l.amount));
  const cardLiability = controlOverride(doc) ?? deps.cardLiabilityAccountId;
  if (!cardLiability) throw new PostingError("card_charge requires a payment card");
  return [
    ...expense,
    ...tax,
    {
      accountId: cardLiability,
      amount: negMoney(total),
      paymentCardId: doc.paymentCardId,
      ...dims(doc),
    },
  ];
};

/** Tender-leg memo: the method label plus the operator's reference when one was taken. */
export const tenderMemo = (t: { methodLabel: string; reference: string | null }): string | null =>
  t.reference ? `${t.methodLabel} ${t.reference}` : t.methodLabel;

export const dims = (d: Doc, l?: DocLine) => ({
  departmentId: l?.departmentId ?? d.departmentId,
  projectId: l?.projectId ?? d.projectId,
  locationId: l?.locationId ?? d.locationId,
  classId: l?.classId ?? d.classId,
  equipmentUnitId: l?.equipmentUnitId ?? null,
  extraDims: {
    ...((d.extraDims ?? {}) as Record<string, string | null>),
    ...((l?.extraDims ?? {}) as Record<string, string | null>),
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
    ...((d.extraDims ?? {}) as Record<string, string | null>),
    ...((l.extraDims ?? {}) as Record<string, string | null>),
  },
});

export const lineTotal = (l: DocLine): Money => addMoney(l.amount, l.taxAmount ?? "0");

/**
 * The payable/receivable/card-liability/bank control account a document should post
 * to. A transaction may choose its own AP/AR/financing/funding account on the
 * header (usually the org default, but sometimes a financing sub-account like
 * "Ford Credit" or a per-card employee liability). We surface that choice as
 * `doc.custom.controlAccountId`; when present it wins over the org default.
 */
export const controlOverride = (doc: Doc): string | undefined => {
  const c = (doc.custom as Record<string, unknown> | null)?.controlAccountId;
  return typeof c === "string" && c ? c : undefined;
};

/** Direction application that also parses: every signed leg is canonical Money. */
export function signed(amount: string, direction: 1 | -1): Money {
  const money = parseMoney(amount);
  return direction === 1 ? money : negMoney(money);
}

/**
 * Who fronted the money for an expense line (0171). Fail closed on anything
 * outside the migration's CHECK values: a future settlement kind must be
 * taught to the kernel deliberately, never defaulted into the wrong
 * counterparty. Non-expense kinds never call this (their lines ignore the
 * column), so an unexpected value here is always a real data fault.
 */
export function settlementOf(
  line: Pick<DocLine, "lineNumber" | "settlementType">,
): ExpenseSettlement {
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
export function personalReceivableAmount(line: DocLine, deps: PostingDeps): Money {
  let recoverable = "0";
  for (const c of componentsForLine(line, deps, false)) {
    if (c.calculationType !== "standard") {
      throw new PostingError(
        `personal expense line ${line.lineNumber} cannot carry ${c.calculationType} tax`,
      );
    }
    recoverable = add(recoverable, c.recoverableAmount);
  }
  return addMoney(purchaseBaseAmount(line, deps), recoverable);
}

/** Expense/inventory basis includes only the nonrecoverable purchase tax. */
export function purchaseBaseAmount(line: DocLine, deps: PostingDeps): Money {
  const nonrecoverable = sumMoney(
    componentsForLine(line, deps, false)
      .filter((c) => c.calculationType !== "withholding")
      .map((c) => c.nonrecoverableAmount),
  );
  // DocLine boundary: document text is parsed here, fail closed.
  return addMoney(parseMoney(line.amount), nonrecoverable);
}

/**
 * Purchase tax projection:
 * - standard: recoverable input tax only (nonrecoverable was capitalized above)
 * - withholding: credit the statutory withholding payable
 * - reverse charge: debit recoverable input, credit full output liability;
 *   nonrecoverable input remains in expense/inventory.
 */
export function purchaseTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps, false)) {
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
      if (component.calculationType === "reverse_charge" && !isZero(component.taxAmount)) {
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

/**
 * Sales tax projection: standard output liability, withholding receivable,
 * and marketplace clearing. Facilitator-collected tax never touches the
 * merchant's liability: gross documents (the marketplace tax is inside the
 * charged total) credit the facilitator's clearing account — the
 * marketplace settles it through the payout — while net documents (shown
 * for reporting only) emit no leg at all.
 */
export function salesTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps, true)) {
      const common = {
        taxCodeId: component.taxCodeId,
        partyId: line.partyId ?? doc.partyId,
        // Sales tax follows its line's entity across legal entities, like
        // the income line above; null keeps the document subsidiary default.
        subsidiaryId: line.subsidiaryId ?? null,
        ...taxControlDims(doc, line),
      };
      if (component.collectedBy === "marketplace") {
        if (component.calculationType !== "standard") {
          throw new PostingError(
            `line ${line.lineNumber} carries marketplace-collected ${component.calculationType} tax — only standard output tax can be marketplace-collected`,
          );
        }
        const clearing = deps.marketplaceClearingByName?.get(component.facilitatorName ?? "");
        if (!clearing) {
          throw new PostingError(
            `line ${line.lineNumber} names marketplace facilitator "${component.facilitatorName ?? ""}" with no clearing account — configure the facilitator in Setup → Taxes → Marketplace facilitators`,
          );
        }
        if (clearing.mode === "net") continue;
        out.push({
          ...common,
          accountId: clearing.accountId,
          amount: signed(neg(component.taxAmount), direction),
        });
        continue;
      }
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
