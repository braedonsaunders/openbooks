"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import type { HistoryRow, StatementEvidenceRow } from "./evidence-format";
import { EVIDENCE_MISSING } from "./evidence-format";

const paneTitle = "text-sm font-semibold text-slate-900 dark:text-slate-100";

/** Column count of the statement table, for the excluded-line sub-rows. */
const STATEMENT_COLUMNS = 11;

/**
 * Every bank statement that supports the session's balance. Excluded lines
 * inside the session window sit directly under their statement, so each one
 * stays visibly scoped to the statement that carries it.
 */
export function SupportingStatements({
  accountPath,
  sourceEvidence,
  windowStart,
  throughDate,
  statements,
}: {
  accountPath: string;
  sourceEvidence: boolean;
  windowStart: string | null;
  throughDate: string;
  statements: StatementEvidenceRow[];
}) {
  const t = useTranslations("banking.reconcileEvidence");
  return (
    <section className="space-y-3" aria-labelledby="reconcile-statements-title">
      <div className="space-y-1">
        <h2 id="reconcile-statements-title" className={paneTitle}>
          {t("statements.title")}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {windowStart
            ? t("statements.windowAfter", { start: windowStart, end: throughDate })
            : t("statements.windowThrough", { end: throughDate })}
        </p>
      </div>
      {statements.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {sourceEvidence ? t("statements.sourceEmpty") : t("statements.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("statements.columns.date")}</TableHead>
                <TableHead>{t("statements.columns.source")}</TableHead>
                <TableHead>{t("statements.columns.imported")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.opening")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.closing")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.lines")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.matched")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.excluded")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.unmatched")}</TableHead>
                <TableHead className="text-right">{t("statements.columns.total")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("statements.columns.open")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.map((statement) => (
                <StatementRows key={statement.id} accountPath={accountPath} statement={statement} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function StatementRows({
  accountPath,
  statement,
}: {
  accountPath: string;
  statement: StatementEvidenceRow;
}) {
  const t = useTranslations("banking.reconcileEvidence");
  return (
    <>
      <TableRow>
        <TableCell className="font-medium tabular-nums">{statement.statementDate}</TableCell>
        <TableCell>{statement.source}</TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{statement.importedAt}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.openingBalance}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.closingBalance}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.windowLines}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.matchedLines}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.excludedLines}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.unmatchedLines}</TableCell>
        <TableCell className="text-right tabular-nums">{statement.windowTotal}</TableCell>
        <TableCell className="text-right">
          <Link
            href={`${accountPath}?statement=${statement.id}`}
            className="text-sm font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
          >
            {t("statements.columns.open")}
          </Link>
        </TableCell>
      </TableRow>
      {statement.excluded.map((line) => (
        <TableRow key={line.id} className="bg-amber-50/60 dark:bg-amber-950/20">
          <TableCell colSpan={STATEMENT_COLUMNS}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1 text-sm">
              <Badge variant="warning">{t("statements.excludedBadge")}</Badge>
              <span className="tabular-nums">{line.postedOn}</span>
              <span className="font-medium tabular-nums">{line.amount}</span>
              <span className="min-w-0 break-words">{line.description ?? EVIDENCE_MISSING}</span>
              <span>{t("statements.reason", { reason: line.reason })}</span>
              {line.duplicateOf ? (
                <span className="text-slate-600 dark:text-slate-300">
                  {t("statements.duplicateOf", {
                    date: line.duplicateOf.postedOn,
                    amount: line.duplicateOf.amount,
                  })}
                </span>
              ) : null}
              {line.excludedAt ? (
                <span className="text-slate-600 dark:text-slate-300">
                  {line.excludedBy
                    ? t("statements.excludedByAt", { name: line.excludedBy, at: line.excludedAt })
                    : t("statements.excludedAt", { at: line.excludedAt })}
                </span>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/**
 * The session's governed history, oldest first: sign-offs, withdrawals,
 * opening confirmations, session adjustments, and discards on the same bank
 * account. Each row names the balance it recorded so a reviewer can follow
 * why the signed figure changed.
 */
export function ReconcileHistory({ rows }: { rows: HistoryRow[] }) {
  const t = useTranslations("banking.reconcileEvidence");
  return (
    <section className="space-y-3" aria-labelledby="reconcile-history-title">
      <div className="space-y-1">
        <h2 id="reconcile-history-title" className={paneTitle}>
          {t("history.title")}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("history.description")}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("history.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("history.columns.when")}</TableHead>
                <TableHead>{t("history.columns.event")}</TableHead>
                <TableHead>{t("history.columns.by")}</TableHead>
                <TableHead>{t("history.columns.details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={`${row.at}-${index}`}>
                  <TableCell className="whitespace-nowrap tabular-nums">{row.at}</TableCell>
                  <TableCell className="font-medium">
                    <HistoryEventLabel kind={row.event.kind} />
                  </TableCell>
                  <TableCell>{row.actor}</TableCell>
                  <TableCell className="min-w-64 whitespace-normal text-sm">
                    <HistoryDetail row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function HistoryEventLabel({ kind }: { kind: HistoryRow["event"]["kind"] }) {
  const t = useTranslations("banking.reconcileEvidence");
  return <>{t(`history.events.${kind}`)}</>;
}

function HistoryDetail({ row }: { row: HistoryRow }) {
  const t = useTranslations("banking.reconcileEvidence");
  const event = row.event;
  switch (event.kind) {
    case "revalidate_sign_off":
      return (
        <div className="space-y-1">
          <p>{t("history.revalidationReason", { reason: event.reason })}</p>
          <p>
            {t("history.revalidationBasis", {
              date: event.throughDate,
              balance: event.statementBalance,
              entries: event.reviewedEntries,
              original: event.originalSignedOffAt,
            })}
          </p>
          <p className="break-all font-mono text-xs">{event.evidenceDigest}</p>
        </div>
      );
    case "sign_off":
      return (
        <span>
          {event.evidence === "source"
            ? t("history.signOffSource", {
                balance: event.statementBalance,
                date: event.throughDate,
                matched: event.matchedJournalLines,
              })
            : t("history.signOffStatement", {
                balance: event.statementBalance,
                date: event.throughDate,
                matched: event.matchedJournalLines,
                excluded: event.excludedStatementLines,
              })}
        </span>
      );
    case "withdraw_sign_off":
      return (
        <div className="space-y-1">
          <p>{t("history.withdrawReason", { reason: event.reason })}</p>
          <p>
            {t("history.withdrawPrior", {
              balance: event.priorStatementBalance,
              at: event.priorSignedOffAt,
              by: event.priorSignedOffBy,
            })}
          </p>
          <p className="text-slate-600 dark:text-slate-300">
            {t("history.withdrawReleased", {
              count: event.releasedJournalLines,
              status: event.status,
            })}
          </p>
        </div>
      );
    case "discard":
      return (
        <span>
          {t("history.discardDetail", {
            date: event.throughDate,
            balance: event.statementBalance,
            matches: event.releasedMatches,
            lines: event.releasedStatementLines,
          })}
        </span>
      );
    case "confirm_opening":
      return (
        <span>
          {t("history.confirmDetail", {
            amount: event.amount,
            date: event.startDate,
            reason: event.reason,
          })}
        </span>
      );
    case "session_adjustment":
      return (
        <span>
          {t("history.adjustDetail", {
            beforeDate: event.before?.throughDate ?? EVIDENCE_MISSING,
            afterDate: event.after?.throughDate ?? EVIDENCE_MISSING,
            beforeBalance: event.before?.statementBalance ?? EVIDENCE_MISSING,
            afterBalance: event.after?.statementBalance ?? EVIDENCE_MISSING,
          })}
        </span>
      );
  }
}
