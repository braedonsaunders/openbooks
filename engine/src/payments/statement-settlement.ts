import { fromUnits, toUnits } from "../money/money.ts";

/**
 * How one bank statement line settles the open documents an operator chose:
 * the cash applied to each document, any cash left over (kept on account for
 * the party: a customer's unapplied credit or a vendor prepayment), and any
 * short-paid balance the operator writes off. Pure exact-money arithmetic in
 * the documents' transaction currency; the payment and write-off services
 * re-validate every amount against live open balances under their locks.
 */

export class StatementSettlementError extends Error {
  override readonly name = "StatementSettlementError";
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export interface SettlementDocument {
  openLineId: string;
  /** Remaining open balance in the transaction currency (positive). */
  open: string;
  dueDate: string | null;
  postingDate: string;
  /** Document or entry number, for refusals. */
  label: string;
}

export interface PlannedDocumentSettlement {
  openLineId: string;
  /** Cash applied to the document. */
  applied: string;
  /** Short-paid balance written off; zero unless the operator chose a write-off. */
  writeOff: string;
  /** Balance the document still carries afterwards. */
  remaining: string;
}

export interface StatementSettlementPlan {
  documents: PlannedDocumentSettlement[];
  appliedTotal: string;
  /** Cash beyond the applications, kept on account for the party. */
  onAccount: string;
  writeOffTotal: string;
}

/** Earliest due first (undated last), then earliest posted, then label: the order cash is applied by default. */
export function settlementOrder(documents: readonly SettlementDocument[]): SettlementDocument[] {
  return [...documents].sort(
    (a, b) =>
      (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") ||
      a.postingDate.localeCompare(b.postingDate) ||
      a.label.localeCompare(b.label) ||
      (a.openLineId < b.openLineId ? -1 : a.openLineId > b.openLineId ? 1 : 0),
  );
}

/**
 * The default allocation of a line amount: oldest document first, each up to
 * its open balance, until the amount runs out. Documents the amount does not
 * reach receive nothing; an amount larger than every balance leaves the rest
 * unallocated (on account).
 */
export function allocateOldestFirst(
  amount: string,
  documents: readonly SettlementDocument[],
): Record<string, string> {
  let remaining = toUnits(amount);
  if (remaining < 0n)
    throw new StatementSettlementError(
      "A settlement amount cannot be negative.",
      "Enter the statement amount as a positive value.",
    );
  const out: Record<string, string> = {};
  for (const doc of settlementOrder(documents)) {
    const open = toUnits(doc.open);
    const take = remaining < open ? remaining : open;
    out[doc.openLineId] = fromUnits(take > 0n ? take : 0n);
    remaining -= take > 0n ? take : 0n;
  }
  return out;
}

function parseApplied(raw: string | undefined, label: string): bigint {
  if (raw === undefined || raw.trim() === "") {
    throw new StatementSettlementError(
      `${label} has no amount to apply.`,
      "Enter the amount this payment applies to each selected document, or deselect it.",
    );
  }
  if (!/^\d{1,13}(\.\d{1,4})?$/.test(raw.trim())) {
    throw new StatementSettlementError(
      `${label}'s amount ${raw} is not a valid amount.`,
      "Enter a positive amount with at most four decimal places.",
    );
  }
  return toUnits(raw.trim());
}

/**
 * Validate the operator's allocation of a statement line and derive the rest
 * of the settlement. Every selected document receives a positive amount no
 * larger than its open balance; the applications never exceed the line; cash
 * left over stays on account; and a write-off clears each document's
 * shortfall only when no cash is left unapplied — leftover cash would pay
 * that shortfall instead.
 */
export function planStatementSettlement(input: {
  lineAmount: string;
  documents: readonly SettlementDocument[];
  applied: Readonly<Record<string, string>>;
  writeOff: boolean;
}): StatementSettlementPlan {
  const line = toUnits(input.lineAmount);
  if (line <= 0n)
    throw new StatementSettlementError(
      "The statement line settles nothing.",
      "Exclude a zero-amount line instead.",
    );
  if (input.documents.length === 0) {
    throw new StatementSettlementError(
      "Select at least one open invoice or bill.",
      "Choose the documents this line pays.",
    );
  }
  const known = new Set(input.documents.map((doc) => doc.openLineId));
  const stray = Object.keys(input.applied).find((id) => !known.has(id));
  if (stray !== undefined) {
    throw new StatementSettlementError(
      "An amount names a document that is not selected.",
      "Refresh the proposals and allocate the line again.",
    );
  }
  let appliedTotal = 0n;
  let writeOffTotal = 0n;
  const documents: PlannedDocumentSettlement[] = [];
  for (const doc of settlementOrder(input.documents)) {
    const open = toUnits(doc.open);
    const applied = parseApplied(input.applied[doc.openLineId], doc.label);
    if (applied <= 0n) {
      throw new StatementSettlementError(
        `${doc.label} receives nothing from this line.`,
        "Enter a positive amount for every selected document, or deselect it.",
      );
    }
    if (applied > open) {
      throw new StatementSettlementError(
        `${doc.label} would receive ${fromUnits(applied)}, more than its open balance of ${fromUnits(open)}.`,
        "Apply at most the open balance; any excess stays on account for the party.",
      );
    }
    const shortfall = open - applied;
    const writeOff = input.writeOff ? shortfall : 0n;
    appliedTotal += applied;
    writeOffTotal += writeOff;
    documents.push({
      openLineId: doc.openLineId,
      applied: fromUnits(applied),
      writeOff: fromUnits(writeOff),
      remaining: fromUnits(shortfall - writeOff),
    });
  }
  if (appliedTotal > line) {
    throw new StatementSettlementError(
      `The amounts applied total ${fromUnits(appliedTotal)}, more than the statement line's ${fromUnits(line)}.`,
      "Reduce the amounts so they total at most the statement amount.",
    );
  }
  const onAccount = line - appliedTotal;
  if (input.writeOff) {
    if (writeOffTotal === 0n) {
      throw new StatementSettlementError(
        "Every selected document is paid in full, so there is nothing to write off.",
        "Clear the write-off option.",
      );
    }
    if (onAccount > 0n) {
      throw new StatementSettlementError(
        `${fromUnits(onAccount)} of the line would stay unapplied while a short-paid balance is written off.`,
        "Apply the remaining cash to the short-paid documents before writing off what is left.",
      );
    }
  }
  return {
    documents,
    appliedTotal: fromUnits(appliedTotal),
    onAccount: fromUnits(onAccount),
    writeOffTotal: fromUnits(writeOffTotal),
  };
}
