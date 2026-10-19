import type { schema } from "../platform/db.ts";
import type { PostEntryLineInput } from "./post-entry.ts";

type ReversalJournalLine = typeof schema.journalLines.$inferInsert;

/** Carry every reversed line instruction into the canonical posting API. */
export function reversalPostEntryLine(line: ReversalJournalLine): PostEntryLineInput {
  return {
    accountId: line.accountId,
    subsidiaryId: line.subsidiaryId,
    amount: String(line.amount),
    currency: line.currency,
    txnAmount: line.txnAmount == null ? null : String(line.txnAmount),
    fxRate: line.fxRate == null ? null : String(line.fxRate),
    memo: line.memo,
    partyId: line.partyId,
    departmentId: line.departmentId,
    projectId: line.projectId,
    locationId: line.locationId,
    classId: line.classId,
    equipmentUnitId: line.equipmentUnitId,
    extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
    paymentCardId: line.paymentCardId,
    taxCodeId: line.taxCodeId,
    eliminate: line.eliminate ?? false,
    isCurrencyAdjustment: line.isCurrencyAdjustment ?? false,
    quantity: line.quantity == null ? null : String(line.quantity),
    unit: line.unit,
    custom: (line.custom ?? {}) as Record<string, unknown>,
    contributorKind: line.contributorKind,
    contributorRef: line.contributorRef,
    lineNumber: line.lineNumber,
  };
}
