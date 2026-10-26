import type {
  EvidenceExcludedLine,
  EvidenceStatement,
  ReconciliationEvidence,
  ReconciliationHistoryEvent,
} from "@openbooks/engine/banking/banking";

/**
 * Display rows for the reconciliation evidence tabs. Pure: every formatter is
 * injected by the loader (locale, currency and business time zone live there),
 * so the mapping stays deterministic and testable without the server runtime.
 * Missing audit values render as an em dash rather than a guessed figure.
 */

export const EVIDENCE_MISSING = "—";

export interface EvidenceFormatters {
  money(value: string): string;
  count(value: number): string;
  civilDate(value: string): string;
  /** ISO 8601 instant from the engine. */
  timestamp(value: string): string;
  source(value: string): string;
  status(value: string): string;
}

export interface ExcludedLineRow {
  id: string;
  postedOn: string;
  amount: string;
  description: string | null;
  reason: string;
  duplicateOf: { postedOn: string; amount: string } | null;
  excludedBy: string | null;
  excludedAt: string | null;
}

export interface StatementEvidenceRow {
  id: string;
  statementDate: string;
  source: string;
  importedAt: string;
  openingBalance: string;
  closingBalance: string;
  windowLines: string;
  matchedLines: string;
  excludedLines: string;
  unmatchedLines: string;
  windowTotal: string;
  /** Excluded lines inside the session window, listed under their statement. */
  excluded: ExcludedLineRow[];
}

interface SessionStateRow {
  throughDate: string;
  statementBalance: string;
  status: string;
}

export type HistoryEventRow =
  | {
      kind: "revalidate_sign_off";
      reason: string;
      throughDate: string;
      statementBalance: string;
      originalSignedOffAt: string;
      reviewedEntries: string;
      evidenceDigest: string;
    }
  | {
      kind: "sign_off";
      evidence: "statement" | "source";
      throughDate: string;
      statementBalance: string;
      matchedJournalLines: string;
      excludedStatementLines: string;
    }
  | {
      kind: "withdraw_sign_off";
      reason: string;
      throughDate: string;
      priorStatementBalance: string;
      priorSignedOffAt: string;
      priorSignedOffBy: string;
      releasedJournalLines: string;
      status: string;
    }
  | {
      kind: "discard";
      throughDate: string;
      statementBalance: string;
      releasedMatches: string;
      releasedStatementLines: string;
    }
  | {
      kind: "confirm_opening";
      amount: string;
      startDate: string;
      reason: string;
    }
  | {
      kind: "session_adjustment";
      before: SessionStateRow | null;
      after: SessionStateRow | null;
    };

export interface HistoryRow {
  at: string;
  actor: string;
  event: HistoryEventRow;
}

function orMissing<T>(value: T | null | undefined, format: (value: T) => string): string {
  return value === null || value === undefined ? EVIDENCE_MISSING : format(value);
}

function sessionState(
  state: { throughDate: string; statementBalance: string | null; status: string | null } | null,
  f: EvidenceFormatters,
): SessionStateRow | null {
  if (!state) return null;
  return {
    throughDate: f.civilDate(state.throughDate),
    statementBalance: orMissing(state.statementBalance, f.money),
    status: orMissing(state.status, f.status),
  };
}

function excludedLineRow(line: EvidenceExcludedLine, f: EvidenceFormatters): ExcludedLineRow {
  return {
    id: line.id,
    postedOn: f.civilDate(line.postedOn),
    amount: f.money(line.amount),
    description: line.description,
    reason: line.exclusionReason,
    duplicateOf: line.possibleDuplicateOf
      ? {
          postedOn: f.civilDate(line.possibleDuplicateOf.postedOn),
          amount: f.money(line.possibleDuplicateOf.amount),
        }
      : null,
    excludedBy: line.excludedByName,
    excludedAt: line.excludedAt ? f.timestamp(line.excludedAt) : null,
  };
}

/**
 * Every supporting statement with its window counts, each carrying its
 * excluded lines. An excluded line that names a statement outside the list
 * would hide evidence, so it refuses instead of being dropped.
 */
export function formatStatementEvidence(
  evidence: Pick<ReconciliationEvidence, "statements" | "excludedLines">,
  f: EvidenceFormatters,
): StatementEvidenceRow[] {
  const byStatement = new Map<string, ExcludedLineRow[]>();
  for (const line of evidence.excludedLines) {
    const rows = byStatement.get(line.statementId) ?? [];
    rows.push(excludedLineRow(line, f));
    byStatement.set(line.statementId, rows);
  }
  const statementIds = new Set(evidence.statements.map((statement) => statement.id));
  for (const statementId of byStatement.keys()) {
    if (!statementIds.has(statementId)) {
      throw new Error(
        "Excluded statement line belongs to a statement outside the reconciliation evidence",
      );
    }
  }
  return evidence.statements.map((statement: EvidenceStatement) => ({
    id: statement.id,
    statementDate: f.civilDate(statement.statementDate),
    source: f.source(statement.source),
    importedAt: f.timestamp(statement.importedAt),
    openingBalance: orMissing(statement.openingBalance, f.money),
    closingBalance: orMissing(statement.closingBalance, f.money),
    windowLines: f.count(statement.windowLines),
    matchedLines: f.count(statement.matchedLines),
    excludedLines: f.count(statement.excludedLines),
    unmatchedLines: f.count(statement.unmatchedLines),
    windowTotal: f.money(statement.windowTotal),
    excluded: byStatement.get(statement.id) ?? [],
  }));
}

function historyEventRow(
  event: ReconciliationHistoryEvent,
  f: EvidenceFormatters,
): HistoryEventRow {
  switch (event.kind) {
    case "revalidate_sign_off":
      return {
        kind: "revalidate_sign_off",
        reason: orMissing(event.reason, (value) => value),
        throughDate: orMissing(event.throughDate, f.civilDate),
        statementBalance: orMissing(event.statementBalance, f.money),
        originalSignedOffAt: orMissing(event.originalSignedOffAt, f.timestamp),
        reviewedEntries: orMissing(event.reviewedEntries, f.count),
        evidenceDigest: orMissing(event.evidenceDigest, (value) => value),
      };
    case "sign_off":
      return {
        kind: "sign_off",
        evidence: event.evidenceKind,
        throughDate: orMissing(event.throughDate, f.civilDate),
        statementBalance: orMissing(event.statementBalance, f.money),
        matchedJournalLines: orMissing(event.matchedJournalLines, f.count),
        excludedStatementLines: orMissing(event.excludedStatementLines, f.count),
      };
    case "withdraw_sign_off":
      return {
        kind: "withdraw_sign_off",
        reason: orMissing(event.reason, (value) => value),
        throughDate: orMissing(event.throughDate, f.civilDate),
        priorStatementBalance: orMissing(event.priorStatementBalance, f.money),
        priorSignedOffAt: orMissing(event.priorSignedOffAt, f.timestamp),
        priorSignedOffBy: orMissing(event.priorSignedOffByName, (value) => value),
        releasedJournalLines: orMissing(event.releasedJournalLines, f.count),
        status: orMissing(event.status, f.status),
      };
    case "discard":
      return {
        kind: "discard",
        throughDate: orMissing(event.throughDate, f.civilDate),
        statementBalance: orMissing(event.statementBalance, f.money),
        releasedMatches: orMissing(event.releasedMatches, f.count),
        releasedStatementLines: orMissing(event.releasedStatementLines, f.count),
      };
    case "confirm_opening":
      return {
        kind: "confirm_opening",
        amount: orMissing(event.amount, f.money),
        startDate: orMissing(event.startDate, f.civilDate),
        reason: orMissing(event.reason, (value) => value),
      };
    case "session_adjustment":
      return {
        kind: "session_adjustment",
        before: sessionState(event.before, f),
        after: sessionState(event.after, f),
      };
  }
}

/** The governed history in the order the engine recorded it. */
export function formatHistory(
  events: readonly ReconciliationHistoryEvent[],
  f: EvidenceFormatters,
): HistoryRow[] {
  return events.map((event) => ({
    at: f.timestamp(event.at),
    actor: event.actorName ?? EVIDENCE_MISSING,
    event: historyEventRow(event, f),
  }));
}
