/**
 * Banking: statement parsing (OFX / CSV) → import with dedupe → auto/manual
 * matching against posted journal lines → reconciliation sign-off.
 * Reversed originals remain ledger history for financial reports, but are not
 * eligible for bank matching; matching may use only the current posted entry.
 *
 * Statement lines are the immutable imported truth (bank's perspective,
 * signed). Matching connects them to unreconciled journal lines on the same
 * reconcilable account; sign-off stamps `reconciled_at`/`reconciliation_id`
 * on the matched journal lines (a metadata-only update the kernel's
 * `jl_guard` trigger explicitly allows on posted lines).
 */

export { BankingError, normalizeExternalAccountId, BANK_STATEMENT_PARSER_VERSION, SYSTEM_ACTOR_ID } from "./banking-core"
export type { ParsedStatementLine, ParsedStatement, StatementSource, StatementSourceContent, StatementSourceEvidence, BankingContext, CsvMapping, SkippedStatementRowCode, SkippedStatementRow } from "./banking-core"
export { decodeStatementSourceText } from "./statement-encoding"
export { parseOfx } from "./statement-parsers/ofx"
export { parseCsvRows, parseCsvDate, parseCsv } from "./statement-parsers/csv"
export { parseCamt053 } from "./statement-parsers/camt053"
export { parseBai2 } from "./statement-parsers/bai2"
export { parseMt940 } from "./statement-parsers/mt940"
export { requireBankAccountInScope } from "./reconcilable-account"
export { normalizeFingerprintText, filterDuplicateStatementLines, statementSourceSha256, importStatement } from "./statement-import"
export type { FlaggedStatementLine, ImportResult } from "./statement-import"
export { startReconciliation, reconciliationBookId, reconciliationTotals, adjustReconciliation, discardReconciliation, markReconciled } from "./reconciliation"
export type { ReconciliationTotals } from "./reconciliation"
export { autoMatch, createMatchWithJournal, createMatch, unmatchStatementLine, excludeStatementLine, clearPossibleDuplicateFlag, excludePossibleDuplicates, restoreStatementLine } from "./matching"
export type { AutoMatchResult } from "./matching"
export { SOURCE_EVIDENCE_POLICY_CODE, sourceEvidencePolicyActive, applySourceLineEvidence, refreshSourceReconciliationState, signOffFromSourceEvidence } from "./source-evidence"
export type { SourceClearedLineEvidence, SourceClearedEntryEvidence, SourceAccountEvidenceState, SourceSignOffOutcome } from "./source-evidence"
