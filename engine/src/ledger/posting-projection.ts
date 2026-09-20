import { isZero, normalizeDecimal, sum, toUnits } from "../money/money.ts";
import { type Doc, type DocLine, type KernelLine, type PostingDeps, RULES, PostingError } from "./posting-rules.ts";
export function glProjectionScopeUnchanged(
  existing: { periodId: string; postingDate: string },
  next: { periodId: string; postingDate: string },
): boolean {
  return (
    existing.periodId === next.periodId &&
    existing.postingDate === next.postingDate
  );
}

/** Build + validate the GL-Impact projection (kernel lines) for a document. */
export function buildProjection(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
): KernelLine[] {
  const rule = RULES[doc.kind];
  if (!rule)
    throw new PostingError(`no posting rule for document kind "${doc.kind}"`);
  const kl = rule(doc, lines, deps).filter((l) => !isZero(l.amount));
  if (kl.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  if (!isZero(sum(kl.map((l) => l.amount)))) {
    throw new PostingError(`posting rule for ${doc.kind} does not balance`);
  }
  // Same AR/AP faithfulness guard as postDocument (this path runs on amend /
  // re-materialization): an open-item leg must carry its subledger party.
  const orphan = kl.find((l) => l.isOpenItem && !l.partyId);
  if (orphan) {
    throw new PostingError(
      `open-item line on account ${orphan.accountId} has no party — every AR/AP line must carry its customer/vendor (line entity)`,
    );
  }
  return kl;
}

/** Stable comparison key for ONE GL line (amount-normalized). */
export function glLineKey(line: {
  accountId: string;
  amount: string;
  subsidiaryId?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  equipmentUnitId?: string | null;
  extraDims?: Record<string, string> | null;
  taxCodeId?: string | null;
  paymentCardId?: string | null;
  dueDate?: string | null;
  isOpenItem?: boolean | null;
  currency?: string | null;
  txnAmount?: string | null;
  fxRate?: string | null;
}): string {
  return JSON.stringify([
    line.accountId,
    toUnits(line.amount).toString(),
    line.subsidiaryId ?? null,
    line.partyId ?? null,
    line.departmentId ?? null,
    line.projectId ?? null,
    line.locationId ?? null,
    line.classId ?? null,
    line.equipmentUnitId ?? null,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(line.extraDims ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    ),
    line.taxCodeId ?? null,
    line.paymentCardId ?? null,
    line.dueDate ?? null,
    !!line.isOpenItem,
    line.currency ?? null,
    line.txnAmount == null ? null : toUnits(line.txnAmount).toString(),
    line.fxRate == null ? null : normalizeDecimal(line.fxRate, 10),
  ]);
}

/**
 * Stable comparison key for a set of GL lines. Line ORDER inside an entry is
 * presentation, not accounting impact — the same multiset of lines posts
 * the same ledger regardless of sequence — so the key sorts per-line keys,
 * making projection equality line-order-insensitive.
 */
export function glProjectionKey(
  lines: Parameters<typeof glLineKey>[0][],
): string {
  return JSON.stringify(
    lines.map((line) => glLineKey(line)).sort(),
  );
}
