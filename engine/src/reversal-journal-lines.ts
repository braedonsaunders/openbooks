import type { schema } from "./db.ts";
import { neg } from "./money.ts";

export type ReversalSourceJournalLine = Pick<
  typeof schema.journalLines.$inferSelect,
  | "lineNumber"
  | "accountId"
  | "subsidiaryId"
  | "amount"
  | "currency"
  | "txnAmount"
  | "fxRate"
  | "partyId"
  | "departmentId"
  | "projectId"
  | "locationId"
  | "classId"
  | "equipmentUnitId"
  | "extraDims"
  | "paymentCardId"
  | "taxCodeId"
  | "memo"
  | "quantity"
  | "unit"
  | "custom"
>;

/** Mirror posted journal lines onto a reversal entry with negated amounts and quantity. */
export function reversalJournalLines(
  sourceLines: ReversalSourceJournalLine[],
  ctx: { entryId: string; orgId: string },
): (typeof schema.journalLines.$inferInsert)[] {
  return sourceLines.map((line) => ({
    orgId: ctx.orgId,
    entryId: ctx.entryId,
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    subsidiaryId: line.subsidiaryId,
    amount: neg(line.amount),
    currency: line.currency,
    txnAmount: neg(line.txnAmount),
    fxRate: line.fxRate,
    partyId: line.partyId,
    departmentId: line.departmentId,
    projectId: line.projectId,
    locationId: line.locationId,
    classId: line.classId,
    equipmentUnitId: line.equipmentUnitId,
    extraDims: line.extraDims,
    paymentCardId: line.paymentCardId,
    taxCodeId: line.taxCodeId,
    memo: line.memo,
    quantity: line.quantity == null ? null : neg(line.quantity),
    unit: line.unit,
    dueDate: null,
    isOpenItem: false,
    custom: line.custom,
  }));
}
