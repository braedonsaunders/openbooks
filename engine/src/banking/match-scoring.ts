/**
 * Explainable bank-match scoring.
 *
 * Every proposal the matcher makes carries a score and the structured reasons
 * that produced it, so a reviewer can see why a statement line was paired and
 * the stored match keeps the same explanation. Reasons are codes with
 * parameters, never prose: the review UI renders them through the locale
 * catalog.
 *
 * Pure over plain rows: no database, no clock. Callers load candidates under
 * their own locks and scope rules and keep every eligibility guard (exact
 * amount under the account's sign convention, duplicates, balance-summary
 * rows, carried openings); this module only ranks what is already eligible.
 */
import { calendarDaysBetween } from "../platform/civil-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";

export type MatchReason =
  /** The statement amount equals the ledger amount exactly. */
  | { code: "exact_amount" }
  /** Bank posting date minus book date; positive means the bank posted later. */
  | { code: "date_lag"; days: number }
  /** A cheque, invoice or bill reference appears on the statement line. */
  | { code: "shared_reference"; reference: string }
  /** Counterparty words shared by the statement text and the ledger memo or party name. */
  | { code: "shared_counterparty"; tokens: string[] }
  /** An earlier confirmed match with the same payee words cleared this party. */
  | { code: "prior_party" }
  /** One open document's balance equals the statement amount exactly. */
  | { code: "exact_open_balance" }
  /** Several open documents of one party sum exactly to the statement amount. */
  | { code: "combined_open_balance"; count: number }
  /** The line pays part of one document's open balance; `remaining` stays open on it. */
  | { code: "partial_open_balance"; remaining: string }
  /** The line exceeds the documents it settles in full; `remainder` stays on account for the party. */
  | { code: "on_account_remainder"; remainder: string }
  /** Statement date minus the document due date; positive means paid after the due date. */
  | { code: "due_date"; days: number }
  /** A confirmed match with the same payee words used this offset account. */
  | { code: "history_payee"; tokens: string[]; matchedOn: string };

export type MatchReasonCode = MatchReason["code"];

export const MATCH_REASON_CODES: readonly MatchReasonCode[] = [
  "exact_amount",
  "date_lag",
  "shared_reference",
  "shared_counterparty",
  "prior_party",
  "exact_open_balance",
  "combined_open_balance",
  "partial_open_balance",
  "on_account_remainder",
  "due_date",
  "history_payee",
];

/** Ledger candidates further than this many days from the bank date never pair automatically. */
export const LEDGER_MATCH_WINDOW_DAYS = 14;

/**
 * Automatic matches scoring at or below this ceiling are held in the review
 * tab; above it they count as high confidence. The stored confidence is the
 * score over 100, so "held for review" is exactly `confidence <= 0.70`.
 * Exact amount with the bank posting zero to three days after the book date
 * (or one day before) clears the ceiling on dates alone; a four-day lag, a
 * two-day lead, or anything further needs reference, counterparty or history
 * evidence to count as high confidence.
 */
export const REVIEW_SCORE_CEILING = 70;

const LEDGER_POINTS = {
  exactAmount: 50,
  sameDay: 30,
  /** Bank postings normally trail the book date by a few days. */
  perLaggingDay: 3,
  /** A bank posting before the book date is unusual, so leading days cost more. */
  perLeadingDay: 8,
  reference: 15,
  counterpartyFirst: 10,
  counterpartyEach: 5,
  counterpartyMax: 15,
  priorParty: 10,
} as const;

const DOCUMENT_POINTS = {
  exactOpenBalance: 60,
  combinedOpenBalance: 45,
  /** A part payment or overpayment is proposed only on document evidence, never on amount alone. */
  partialOpenBalance: 10,
  onAccountRemainder: 10,
  reference: 25,
  counterpartyFirst: 10,
  counterpartyEach: 5,
  counterpartyMax: 20,
  dueWithinWeek: 10,
  dueWithinMonth: 5,
} as const;

export interface ScoredMatch {
  score: number;
  /** score / 100 as an exact four-place decimal string ("0.8000"). */
  confidence: string;
  reasons: MatchReason[];
}

/** Exact decimal confidence for a whole-number score, clamped to 0..1. */
export function confidenceFromScore(score: number): string {
  const bounded = Math.max(0, Math.min(100, Math.trunc(score)));
  return fromUnits(BigInt(bounded) * 100n);
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Words that describe the transaction channel rather than the counterparty.
 * Sharing one says nothing about who was paid.
 */
const CHANNEL_WORDS: ReadonlySet<string> = new Set([
  "ach",
  "and",
  "atm",
  "auth",
  "bank",
  "bill",
  "card",
  "chq",
  "cheque",
  "check",
  "com",
  "corp",
  "credit",
  "debit",
  "dep",
  "deposit",
  "direct",
  "eft",
  "etransfer",
  "fee",
  "fees",
  "for",
  "from",
  "inc",
  "int",
  "interac",
  "llc",
  "ltd",
  "mastercard",
  "online",
  "payment",
  "pmt",
  "pos",
  "preauthorized",
  "purchase",
  "pymt",
  "rec",
  "ref",
  "the",
  "transfer",
  "trf",
  "txn",
  "visa",
  "web",
  "wire",
  "withdrawal",
  "www",
  "batch",
  "client",
  "customer",
  "invoice",
  "partial",
  "receipt",
  "receipts",
  "refund",
  "supplier",
  "vendor",
]);

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Counterparty words of one or more texts: case- and accent-folded, split on
 * anything that is not a letter or digit, at least three characters, no
 * digits (those are references or store numbers), channel words removed.
 * Order of first appearance, each word once.
 */
export function counterpartyTokens(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const raw of fold(text).split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3 || /\p{N}/u.test(raw) || CHANNEL_WORDS.has(raw) || seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

function tokensAgree(a: string, b: string): boolean {
  if (a === b) return true;
  // Truncated merchant names ("STARBUCK" for "starbucks") still agree when
  // the shorter word is long enough to be specific.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/** Words of `a` that agree with some word of `b`, in `a`'s order. */
export function sharedTokens(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((left) => b.some((right) => tokensAgree(left, right)));
}

/**
 * Whether two descriptions name the same payee: at least two shared words,
 * or one when either side has only one word.
 */
export function payeeTokensMatch(a: readonly string[], b: readonly string[]): boolean {
  const required = Math.min(2, a.length, b.length);
  return required > 0 && sharedTokens(a, b).length >= required;
}

function compact(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

function digitRuns(text: string): Set<string> {
  const runs = new Set<string>();
  for (const run of fold(text).match(/\d+/g) ?? []) {
    const stripped = run.replace(/^0+/, "");
    if (stripped.length >= 3) runs.add(stripped);
  }
  return runs;
}

/**
 * The first candidate reference (cheque, invoice or bill number) that appears
 * on the statement text. Digit-only references must appear as a whole digit
 * run (leading zeros ignored, at least three significant digits); lettered
 * references match their compacted form ("INV-1042" in "INV1042") or their
 * trailing number.
 */
export function sharedReference(
  statementTexts: ReadonlyArray<string | null | undefined>,
  candidateReferences: ReadonlyArray<string | null | undefined>,
): string | null {
  const text = statementTexts.filter((value): value is string => !!value).join(" ");
  if (text === "") return null;
  const statementCompact = compact(text);
  const statementRuns = digitRuns(text);
  for (const reference of candidateReferences) {
    if (!reference) continue;
    const candidate = compact(reference);
    if (!/\d/.test(candidate)) continue;
    const trailing = (candidate.match(/(\d+)$/)?.[1] ?? "").replace(/^0+/, "");
    if (/^\d+$/.test(candidate)) {
      if (trailing.length >= 3 && statementRuns.has(trailing)) return reference.trim();
      continue;
    }
    if (candidate.length >= 4 && statementCompact.includes(candidate)) return reference.trim();
    if (trailing.length >= 3 && statementRuns.has(trailing)) return reference.trim();
  }
  return null;
}

function counterpartyPoints(
  count: number,
  points: { counterpartyFirst: number; counterpartyEach: number; counterpartyMax: number },
): number {
  if (count === 0) return 0;
  return Math.min(
    points.counterpartyMax,
    points.counterpartyFirst + points.counterpartyEach * (count - 1),
  );
}

// ---------------------------------------------------------------------------
// Statement line ↔ ledger line
// ---------------------------------------------------------------------------

export interface StatementLineFacts {
  id: string;
  postedOn: string;
  description: string | null;
  counterpartyRef?: string | null;
}

export interface LedgerCandidateFacts {
  id: string;
  postingDate: string;
  memo: string | null;
  partyId: string | null;
  partyName: string | null;
  /** Document number, payment reference or cheque number of the source document. */
  references: ReadonlyArray<string | null>;
}

/** A confirmed earlier match: who it cleared and the payee words on its statement line. */
export interface PriorPayee {
  partyId: string;
  tokens: readonly string[];
}

/** Date points: full marks on the same day, gently less per lagging day, steeply less per leading day. */
export function datePoints(lagDays: number): number {
  if (lagDays >= 0)
    return Math.max(0, LEDGER_POINTS.sameDay - LEDGER_POINTS.perLaggingDay * lagDays);
  return Math.max(0, LEDGER_POINTS.sameDay - LEDGER_POINTS.perLeadingDay * -lagDays);
}

/**
 * Score one exact-amount ledger candidate for a statement line. Null when the
 * dates are further apart than the matching window.
 */
export function scoreLedgerCandidate(
  line: StatementLineFacts,
  candidate: LedgerCandidateFacts,
  priorPayees: readonly PriorPayee[] = [],
): (ScoredMatch & { lagDays: number }) | null {
  const lagDays = calendarDaysBetween(candidate.postingDate, line.postedOn);
  if (Math.abs(lagDays) > LEDGER_MATCH_WINDOW_DAYS) return null;
  const reasons: MatchReason[] = [{ code: "exact_amount" }, { code: "date_lag", days: lagDays }];
  let score = LEDGER_POINTS.exactAmount + datePoints(lagDays);

  const reference = sharedReference([line.description, line.counterpartyRef], candidate.references);
  if (reference) {
    score += LEDGER_POINTS.reference;
    reasons.push({ code: "shared_reference", reference });
  }
  const lineTokens = counterpartyTokens(line.description, line.counterpartyRef);
  const shared = sharedTokens(lineTokens, counterpartyTokens(candidate.memo, candidate.partyName));
  if (shared.length > 0) {
    score += counterpartyPoints(shared.length, LEDGER_POINTS);
    reasons.push({ code: "shared_counterparty", tokens: shared });
  }
  if (
    candidate.partyId &&
    priorPayees.some(
      (prior) => prior.partyId === candidate.partyId && payeeTokensMatch(lineTokens, prior.tokens),
    )
  ) {
    score += LEDGER_POINTS.priorParty;
    reasons.push({ code: "prior_party" });
  }
  return { score, confidence: confidenceFromScore(score), reasons, lagDays };
}

export interface PairProposal {
  lineId: string;
  candidateId: string;
  score: number;
  lagDays: number;
  /** The candidate sits in the bucket the account's sign convention prefers. */
  preferred: boolean;
  /** Position of the line and candidate in their loaded (date, line number) order. */
  lineOrder: number;
  candidateOrder: number;
}

/** The deterministic ranking used for one-to-one assignment. */
export function comparePairProposals(a: PairProposal, b: PairProposal): number {
  return (
    b.score - a.score ||
    Number(b.preferred) - Number(a.preferred) ||
    Math.abs(a.lagDays) - Math.abs(b.lagDays) ||
    Number(b.lagDays >= 0) - Number(a.lagDays >= 0) ||
    a.lineOrder - b.lineOrder ||
    a.candidateOrder - b.candidateOrder ||
    (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0) ||
    (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0)
  );
}

/**
 * Greedy one-to-one assignment: the strongest proposal claims first, and each
 * line and each candidate is used at most once. Ties break on the account's
 * preferred sign bucket, then the closer date, then a lagging bank date over
 * a leading one, then load order and ids, so the same inputs always produce
 * the same pairs.
 */
export function assignOneToOne<T extends PairProposal>(proposals: readonly T[]): T[] {
  const usedLines = new Set<string>();
  const usedCandidates = new Set<string>();
  const out: T[] = [];
  for (const proposal of [...proposals].sort(comparePairProposals)) {
    if (usedLines.has(proposal.lineId) || usedCandidates.has(proposal.candidateId)) continue;
    usedLines.add(proposal.lineId);
    usedCandidates.add(proposal.candidateId);
    out.push(proposal);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statement line ↔ open invoices and bills
// ---------------------------------------------------------------------------

export interface OpenDocumentFacts {
  openLineId: string;
  partyId: string;
  partyName: string | null;
  /** Receivable or payable account: one payment settles one control account. */
  accountId: string;
  subsidiaryId: string | null;
  documentNumber: string | null;
  referenceNumber: string | null;
  entryNumber: string;
  dueDate: string | null;
  /** Remaining balance in the document currency (positive). */
  transactionOpen: string;
}

export interface SettlementLineFacts {
  postedOn: string;
  /** Statement amount as a positive magnitude in the document currency. */
  amount: string;
  description: string | null;
  counterpartyRef?: string | null;
}

export interface RankedOpenDocument extends OpenDocumentFacts {
  score: number;
  reasons: MatchReason[];
}

/**
 * How a proposal settles the line: exactly; in part (the line is smaller
 * than the document, which stays open for the rest); or with an overpayment
 * (every document is paid in full and the rest stays on account).
 */
export type ProposalSettlement = "exact" | "partial" | "overpayment";

export interface OpenDocumentProposal {
  openLineIds: string[];
  partyId: string;
  partyName: string | null;
  /** The statement amount the proposal settles. */
  total: string;
  settlement: ProposalSettlement;
  /** Cash applied to each document, by open line id. */
  applied: Record<string, string>;
  /** Cash left on account for the party. */
  onAccount: string;
  score: number;
  reasons: MatchReason[];
}

function dueDateReason(
  postedOn: string,
  dueDate: string | null,
): { points: number; reason: MatchReason | null; distance: number } {
  if (!dueDate) return { points: 0, reason: null, distance: Number.MAX_SAFE_INTEGER };
  const days = calendarDaysBetween(dueDate, postedOn);
  const distance = Math.abs(days);
  const points =
    distance <= 7
      ? DOCUMENT_POINTS.dueWithinWeek
      : distance <= 30
        ? DOCUMENT_POINTS.dueWithinMonth
        : 0;
  return { points, reason: points > 0 ? { code: "due_date", days } : null, distance };
}

function documentEvidence(line: SettlementLineFacts, doc: OpenDocumentFacts) {
  const reference = sharedReference(
    [line.description, line.counterpartyRef],
    [doc.documentNumber, doc.referenceNumber],
  );
  const shared = sharedTokens(
    counterpartyTokens(line.description, line.counterpartyRef),
    counterpartyTokens(doc.partyName),
  );
  return { reference, shared, due: dueDateReason(line.postedOn, doc.dueDate) };
}

function compareDocuments(a: RankedOpenDocument, b: RankedOpenDocument): number {
  return (
    b.score - a.score ||
    (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") ||
    (a.documentNumber ?? a.entryNumber).localeCompare(b.documentNumber ?? b.entryNumber) ||
    (a.openLineId < b.openLineId ? -1 : a.openLineId > b.openLineId ? 1 : 0)
  );
}

/** Exact-sum subsets of 2..maxSize items, bounded by a node budget so a large party never stalls the request. */
function exactSubsets(
  items: readonly RankedOpenDocument[],
  target: bigint,
  maxSize: number,
  limit: number,
): RankedOpenDocument[][] {
  const sorted = [...items].sort((a, b) => {
    const delta = toUnits(b.transactionOpen) - toUnits(a.transactionOpen);
    return delta > 0n ? 1 : delta < 0n ? -1 : compareDocuments(a, b);
  });
  const units = sorted.map((item) => toUnits(item.transactionOpen));
  const found: RankedOpenDocument[][] = [];
  let budget = 20_000;
  const chosen: number[] = [];
  const visit = (start: number, remaining: bigint): void => {
    if (found.length >= limit || budget-- <= 0) return;
    if (remaining === 0n) {
      if (chosen.length >= 2) found.push(chosen.map((index) => sorted[index]!));
      return;
    }
    if (chosen.length >= maxSize) return;
    for (let index = start; index < sorted.length; index++) {
      if (units[index]! > remaining || units[index]! <= 0n) continue;
      chosen.push(index);
      visit(index + 1, remaining - units[index]!);
      chosen.pop();
      if (found.length >= limit || budget <= 0) return;
    }
  };
  visit(0, target);
  return found;
}

/**
 * Rank open documents against one statement line. `documents` lists every
 * open item the caller may settle with the line (same currency, side, scope,
 * not reserved by a payment run), each scored on its own; `proposals` are
 * the settlements offered: first those that clear the line exactly — one
 * document whose open balance equals the amount, or several documents of one
 * party on one control account summing to it — then, on document evidence,
 * part payments of a larger balance and overpayments of a smaller one.
 */
export function rankOpenDocuments(
  line: SettlementLineFacts,
  candidates: readonly OpenDocumentFacts[],
  options: {
    maxCombinationSize?: number;
    maxGroupItems?: number;
    maxProposals?: number;
    maxDocuments?: number;
  } = {},
): { proposals: OpenDocumentProposal[]; documents: RankedOpenDocument[] } {
  const maxCombinationSize = options.maxCombinationSize ?? 4;
  const maxGroupItems = options.maxGroupItems ?? 24;
  const target = toUnits(line.amount);
  if (target <= 0n) return { proposals: [], documents: [] };

  const evidence = new Map(candidates.map((doc) => [doc.openLineId, documentEvidence(line, doc)]));
  const documents: RankedOpenDocument[] = candidates
    .filter((doc) => toUnits(doc.transactionOpen) > 0n)
    .map((doc) => {
      const { reference, shared, due } = evidence.get(doc.openLineId)!;
      const reasons: MatchReason[] = [];
      let score = 0;
      if (toUnits(doc.transactionOpen) === target) {
        score += DOCUMENT_POINTS.exactOpenBalance;
        reasons.push({ code: "exact_open_balance" });
      }
      if (reference) {
        score += DOCUMENT_POINTS.reference;
        reasons.push({ code: "shared_reference", reference });
      }
      if (shared.length > 0) {
        score += counterpartyPoints(shared.length, DOCUMENT_POINTS);
        reasons.push({ code: "shared_counterparty", tokens: shared });
      }
      if (due.reason) {
        score += due.points;
        reasons.push(due.reason);
      }
      return { ...doc, score, reasons };
    })
    .sort(compareDocuments);

  const proposals: OpenDocumentProposal[] = documents
    .filter((doc) => toUnits(doc.transactionOpen) === target)
    .map((doc) => ({
      openLineIds: [doc.openLineId],
      partyId: doc.partyId,
      partyName: doc.partyName,
      total: fromUnits(target),
      settlement: "exact" as const,
      applied: { [doc.openLineId]: fromUnits(target) },
      onAccount: fromUnits(0n),
      score: doc.score,
      reasons: doc.reasons,
    }));

  // Part payments and overpayments are proposed only where the document
  // itself points at the line — a shared reference, or (for a part payment)
  // the payee's words — so a larger or smaller balance is never offered on
  // amount alone. An overpayment is proposed only up to twice the balance:
  // a line far larger than the document it names is paying something else.
  for (const doc of documents) {
    const open = toUnits(doc.transactionOpen);
    const { reference, shared, due } = evidence.get(doc.openLineId)!;
    const evidenceReasons: MatchReason[] = [];
    let evidencePoints = 0;
    if (reference) {
      evidencePoints += DOCUMENT_POINTS.reference;
      evidenceReasons.push({ code: "shared_reference", reference });
    }
    if (shared.length > 0) {
      evidencePoints += counterpartyPoints(shared.length, DOCUMENT_POINTS);
      evidenceReasons.push({ code: "shared_counterparty", tokens: shared });
    }
    if (due.reason) {
      evidencePoints += due.points;
      evidenceReasons.push(due.reason);
    }
    if (open > target && (reference || shared.length > 0)) {
      proposals.push({
        openLineIds: [doc.openLineId],
        partyId: doc.partyId,
        partyName: doc.partyName,
        total: fromUnits(target),
        settlement: "partial",
        applied: { [doc.openLineId]: fromUnits(target) },
        onAccount: fromUnits(0n),
        score: DOCUMENT_POINTS.partialOpenBalance + evidencePoints,
        reasons: [
          { code: "partial_open_balance", remaining: fromUnits(open - target) },
          ...evidenceReasons,
        ],
      });
    } else if (open < target && reference && target - open <= open) {
      proposals.push({
        openLineIds: [doc.openLineId],
        partyId: doc.partyId,
        partyName: doc.partyName,
        total: fromUnits(target),
        settlement: "overpayment",
        applied: { [doc.openLineId]: fromUnits(open) },
        onAccount: fromUnits(target - open),
        score: DOCUMENT_POINTS.onAccountRemainder + evidencePoints,
        reasons: [
          { code: "on_account_remainder", remainder: fromUnits(target - open) },
          ...evidenceReasons,
        ],
      });
    }
  }

  const groups = new Map<string, RankedOpenDocument[]>();
  for (const doc of documents) {
    if (toUnits(doc.transactionOpen) >= target) continue;
    const key = `${doc.partyId}|${doc.accountId}|${doc.subsidiaryId ?? ""}`;
    const group = groups.get(key) ?? [];
    if (group.length < maxGroupItems) group.push(doc);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const subset of exactSubsets(group, target, maxCombinationSize, 3)) {
      const reasons: MatchReason[] = [{ code: "combined_open_balance", count: subset.length }];
      let score = DOCUMENT_POINTS.combinedOpenBalance;
      const withReference = subset
        .map((doc) => evidence.get(doc.openLineId)!.reference)
        .find((value) => value !== null);
      if (withReference) {
        score += DOCUMENT_POINTS.reference;
        reasons.push({ code: "shared_reference", reference: withReference });
      }
      const shared = evidence.get(subset[0]!.openLineId)!.shared;
      if (shared.length > 0) {
        score += counterpartyPoints(shared.length, DOCUMENT_POINTS);
        reasons.push({ code: "shared_counterparty", tokens: shared });
      }
      const closest = subset
        .map((doc) => evidence.get(doc.openLineId)!.due)
        .filter((due) => due.reason !== null)
        .sort((a, b) => a.distance - b.distance)[0];
      if (closest?.reason) {
        score += closest.points;
        reasons.push(closest.reason);
      }
      const ordered = [...subset].sort(compareDocuments);
      proposals.push({
        openLineIds: ordered.map((doc) => doc.openLineId),
        partyId: ordered[0]!.partyId,
        partyName: ordered[0]!.partyName,
        total: fromUnits(target),
        settlement: "exact",
        applied: Object.fromEntries(
          ordered.map((doc) => [doc.openLineId, fromUnits(toUnits(doc.transactionOpen))]),
        ),
        onAccount: fromUnits(0n),
        score,
        reasons,
      });
    }
  }

  const firstDue = (proposal: OpenDocumentProposal) =>
    proposal.openLineIds
      .map((id) => documents.find((doc) => doc.openLineId === id)?.dueDate ?? "9999-12-31")
      .sort()[0]!;
  // An exact settlement always ranks above a part payment or overpayment.
  const exactFirst = (proposal: OpenDocumentProposal) => (proposal.settlement === "exact" ? 0 : 1);
  proposals.sort(
    (a, b) =>
      exactFirst(a) - exactFirst(b) ||
      b.score - a.score ||
      a.openLineIds.length - b.openLineIds.length ||
      firstDue(a).localeCompare(firstDue(b)) ||
      a.openLineIds.join(",").localeCompare(b.openLineIds.join(",")),
  );
  const shownProposals = proposals.slice(0, options.maxProposals ?? 10);
  // Every document a shown proposal settles stays listed, so the reviewer
  // always sees (and the caller can quote) each balance being settled.
  const proposed = new Set(shownProposals.flatMap((proposal) => proposal.openLineIds));
  const limit = options.maxDocuments ?? 30;
  return {
    proposals: shownProposals,
    documents: documents.filter((doc, index) => index < limit || proposed.has(doc.openLineId)),
  };
}

// ---------------------------------------------------------------------------
// Offset account from history
// ---------------------------------------------------------------------------

export interface OffsetHistoryEntry {
  description: string | null;
  counterpartyRef?: string | null;
  offsetAccountId: string;
  /** Statement date of the confirmed match (ISO). */
  matchedOn: string;
}

/**
 * The offset account of the most recent confirmed match whose statement line
 * names the same payee. `history` must be ordered most recent first. A
 * suggestion only: nothing posts until the reviewer confirms it.
 */
export function suggestOffsetFromHistory(
  line: Pick<StatementLineFacts, "description" | "counterpartyRef">,
  history: readonly OffsetHistoryEntry[],
): { offsetAccountId: string; reasons: MatchReason[] } | null {
  const lineTokens = counterpartyTokens(line.description, line.counterpartyRef);
  if (lineTokens.length === 0) return null;
  for (const entry of history) {
    const entryTokens = counterpartyTokens(entry.description, entry.counterpartyRef);
    if (!payeeTokensMatch(lineTokens, entryTokens)) continue;
    return {
      offsetAccountId: entry.offsetAccountId,
      reasons: [
        {
          code: "history_payee",
          tokens: sharedTokens(lineTokens, entryTokens),
          matchedOn: entry.matchedOn,
        },
      ],
    };
  }
  return null;
}

/**
 * Read stored reasons defensively: rows written before reasons were recorded
 * (or by a future version with new codes) render what is recognizable and
 * drop the rest, never failing the review screen.
 */
export function parseStoredMatchReasons(value: unknown): MatchReason[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(MATCH_REASON_CODES);
  return value.filter(
    (entry): entry is MatchReason =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { code?: unknown }).code === "string" &&
      known.has((entry as { code: string }).code),
  );
}
