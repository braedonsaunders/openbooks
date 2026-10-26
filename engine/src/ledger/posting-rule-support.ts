import { isZero, neg } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { negMoney, parseMoney, ZERO_MONEY } from "../money/brands.ts";
import {
  type Doc,
  type DocLine,
  type KernelLine,
  type PostingDeps,
  PostingError,
} from "../journal/posting-contracts.ts";
import { resolvedLineAccount, dims } from "./posting-rule-builders.ts";

/**
 * An AR/AP journal line participates in the subledger only when it identifies
 * the customer/vendor whose balance it changes. Direct GL journals to control
 * accounts without an entity remain legitimate control-account GL activity,
 * but must not become anonymous aging items.
 */
export function controlLineIsOpenItem(
  accountId: string,
  partyId: string | null | undefined,
  openItemAccountIds?: ReadonlySet<string>,
): boolean {
  return partyId != null && openItemAccountIds?.has(accountId) === true;
}

/**
 * A cash document with nothing to tender: lines that offset one another
 * (a sale line and its discount line) post as they are; when every leg is
 * zero the document records its quantities instead.
 */
export function settledAtNoCharge(
  doc: Doc,
  lines: DocLine[],
  legs: KernelLine[],
  deps: PostingDeps,
  sign: "1" | "-1",
  kindLabel: string,
): KernelLine[] {
  if (legs.some((leg) => !isZero(leg.amount))) return legs;
  if (!deps.noChargeUnitsAccountId) {
    throw new PostingError(
      `${kindLabel} ${doc.documentNumber} settles exactly zero, so it records the quantities given at no charge on a statistical account — ` +
        `set the No-charge units account in Setup → Company & Accounting → Control accounts, then post again`,
    );
  }
  return noChargeMeasurementLegs(doc, lines, deps.noChargeUnitsAccountId, sign, kindLabel);
}

/**
 * The journal of a cash document that settles exactly zero — a sale
 * discounted or comped in full, or the refund of one. It moves no money, so
 * each line is recorded as a zero-money measurement on the statistical
 * No-charge units account: the quantity given (positive on a sale, negative
 * on a refund) in the line's unit. The entry keeps the document's exact
 * journal identity, and the cost of any stocked goods posts through
 * inventory relief as on every sale.
 */
export function noChargeMeasurementLegs(
  doc: Doc,
  lines: DocLine[],
  statisticalAccountId: string,
  sign: "1" | "-1",
  kindLabel: string,
): KernelLine[] {
  const legs: KernelLine[] = [];
  for (const line of lines) {
    const quantity = canonicalDecimal(canonicalDecimal(line.quantity, 8), 4);
    if (quantity === null) {
      throw new PostingError(
        `${kindLabel} ${doc.documentNumber} line ${line.lineNumber} quantity ${line.quantity} cannot be recorded at no charge — state the quantity with at most four decimal places`,
      );
    }
    if (isZero(quantity)) continue;
    legs.push({
      accountId: statisticalAccountId,
      amount: ZERO_MONEY,
      quantity: sign === "1" ? quantity : canonicalDecimal(neg(quantity), 4)!,
      unit: line.unit?.trim() || "unit",
      memo: line.description ? `No charge — ${line.description}` : "No charge",
      partyId: line.partyId ?? doc.partyId,
      ...dims(doc, line),
    });
  }
  if (legs.length === 0) {
    throw new PostingError(
      `${kindLabel} ${doc.documentNumber} settles nothing and records no quantity — add the items sold, or delete the draft`,
    );
  }
  return legs;
}

/** Marks a leg that defers its line through an amortization template. */
export const amortizationSource = (
  l: DocLine,
  deps: PostingDeps,
): { amortizationSourceLineId?: string } =>
  deps.amortizationByLine?.has(l.id) ? { amortizationSourceLineId: l.id } : {};

/** Pure GL projection for a financial equipment/resource charge. The debit is
 * job cost; the credit relieves a distinct recovery pool. Keeping this helper
 * exported makes the accounting invariant directly testable. */
export function projectChargeKernelLines(doc: Doc, lines: DocLine[]): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    const accountId = resolvedLineAccount(line);
    if (!line.recoveryAccountId)
      throw new PostingError("project charge requires a cost recovery account");
    if (line.recoveryAccountId === accountId) {
      throw new PostingError("project charge cost and recovery accounts must be different");
    }
    out.push({
      accountId,
      amount: parseMoney(line.amount),
      memo: line.description,
      ...dims(doc, line),
    });
    out.push({
      accountId: line.recoveryAccountId,
      amount: negMoney(line.amount),
      memo: line.description,
      departmentId: doc.departmentId,
      locationId: doc.locationId,
      classId: doc.classId,
      projectId: null,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: (doc.extraDims ?? {}) as Record<string, string | null>,
    });
  }
  return out;
}
