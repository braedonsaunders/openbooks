import { toUnits } from "../money.ts";

export interface TaxProjectDimensionCandidate {
  lineId: string;
  entryId: string;
  entryStatus: "posted" | "reversed";
  reversesEntryId: string | null;
  reversalEntryId: string | null;
  reversalEntryCount: number;
  documentId: string;
  documentNumber: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string;
  projectId: string;
  equipmentUnitId: string | null;
  taxCodeId: string;
  accountId: string;
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
}

export interface ReversalPairViolation {
  lineId: string;
  entryId: string;
  reason: string;
}

function isExactReversal(
  left: TaxProjectDimensionCandidate,
  right: TaxProjectDimensionCandidate,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.subsidiaryId === right.subsidiaryId &&
    left.projectId === right.projectId &&
    left.equipmentUnitId === right.equipmentUnitId &&
    left.taxCodeId === right.taxCodeId &&
    left.accountId === right.accountId &&
    left.currency === right.currency &&
    left.fxRate === right.fxRate &&
    toUnits(left.amount) === -toUnits(right.amount) &&
    toUnits(left.txnAmount) === -toUnits(right.txnAmount)
  );
}

/**
 * Every dimension amendment to one side of a reversal pair must include the
 * exact inverse line on the other side. Entry-level balance is insufficient:
 * asymmetric dimensions would corrupt dimensional reports while net GL stays
 * zero.
 */
export function reversalPairViolations(
  population: TaxProjectDimensionCandidate[],
): ReversalPairViolation[] {
  const violations: ReversalPairViolation[] = [];
  for (const candidate of population) {
    if (
      candidate.entryStatus === "posted" &&
      !candidate.reversesEntryId &&
      candidate.reversalEntryCount === 0
    ) {
      continue;
    }
    if (
      candidate.entryStatus === "posted" &&
      !candidate.reversesEntryId &&
      candidate.reversalEntryCount > 0
    ) {
      violations.push({
        lineId: candidate.lineId,
        entryId: candidate.entryId,
        reason:
          "an entry with a posted reversal must be in the reversed lifecycle state",
      });
      continue;
    }

    const partnerEntryId =
      candidate.reversesEntryId ?? candidate.reversalEntryId;
    if (
      !partnerEntryId ||
      (candidate.entryStatus === "reversed" &&
        candidate.reversalEntryCount !== 1)
    ) {
      violations.push({
        lineId: candidate.lineId,
        entryId: candidate.entryId,
        reason: `expected exactly one reversal partner, found ${candidate.reversalEntryCount}`,
      });
      continue;
    }
    const partners = population.filter(
      (other) =>
        other.entryId === partnerEntryId &&
        (candidate.reversesEntryId
          ? other.entryId === candidate.reversesEntryId &&
            other.reversesEntryId === null
          : other.reversesEntryId === candidate.entryId) &&
        isExactReversal(candidate, other),
    );
    if (partners.length !== 1) {
      violations.push({
        lineId: candidate.lineId,
        entryId: candidate.entryId,
        reason: `expected one exact inverse candidate in entry ${partnerEntryId}, found ${partners.length}`,
      });
    }
  }
  return violations;
}
