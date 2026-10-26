"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DisclosureSection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { AlertTriangle, Check, Play, RefreshCw, Undo2 } from "lucide-react";
import { useMoney } from "@/components/money-provider";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { promptDialog } from "@/lib/prompt";
import { refusalMessageFromBody } from "../../../lib/api-error";

type Problem = { code: string; message: string; remedy: string };
type JournalKind = "income_statement" | "income_summary" | "balance_sheet" | "opening";
type EntityStatus = "not_generated" | "current" | "stale" | "nothing_to_close" | "blocked";

type PreviewJournal = {
  kind: JournalKind;
  periodName: string;
  postingDate: string;
  debits: string;
  lines: {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    dimensionLabels: { kind: string; segment?: string; label: string }[];
    amount: string;
  }[];
};

type Preview = {
  fiscalYear: {
    fiscalYear: number;
    startsOn: string;
    endsOn: string;
    closingPeriod: { id: string; name: string } | null;
    openingPeriod: { id: string; name: string } | null;
  };
  book: { id: string; name: string };
  policy: {
    effectiveFrom: string;
    closingMethod: "retained_earnings" | "income_summary";
    retainedEarningsAccountName: string | null;
    incomeSummaryAccountName: string | null;
    balanceSheetJournals: boolean;
  } | null;
  problems: Problem[];
  entities: {
    subsidiaryId: string;
    subsidiaryName: string;
    currency: string;
    status: EntityStatus;
    liveSet: { generation: number } | null;
    fiscalYearEarnings: string;
    priorUnclosedEarnings: string;
    journals: PreviewJournal[];
    problems: Problem[];
  }[];
};

type HistoryEntry = {
  setId: string;
  subsidiaryName: string;
  generation: number;
  status: "posted" | "reversed";
  currency: string;
  fiscalYearEarnings: string;
  reason: string;
  generatedAt: string;
  generatedByName: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
  entries: {
    kind: JournalKind;
    entryId: string;
    entryNumber: string;
    reversalEntryId: string | null;
    reversalEntryNumber: string | null;
  }[];
};

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; preview: Preview; history: HistoryEntry[] };

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}));
  return refusalMessageFromBody(data, { fallback }) ?? fallback;
}

const isZero = (value: string) => /^-?0*(\.0*)?$/.test(value.trim());
const isDebit = (value: string) => !value.trim().startsWith("-") && !isZero(value);
const absolute = (value: string) => value.trim().replace(/^-/, "");

const STATUS_VARIANT: Record<EntityStatus, "success" | "warning" | "outline" | "destructive"> = {
  current: "success",
  nothing_to_close: "outline",
  not_generated: "warning",
  stale: "warning",
  blocked: "destructive",
};

/**
 * The year-end close step: what the fiscal year's period-end journals would
 * post per legal entity, why a legal entity is not ready, the action that
 * generates (or withdraws) them with a recorded reason, and the history of
 * every generation and reversal for the year.
 */
export function PeriodEndJournalsPanel({
  periodId,
  bookId,
  canRun,
}: {
  periodId: string;
  bookId: string;
  canRun: boolean;
}) {
  const t = useTranslations("close.periodEndJournals");
  const router = useRouter();
  const { money } = useMoney();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  const fetchState = useCallback(async (): Promise<LoadState> => {
    try {
      const query = new URLSearchParams({ periodId, bookId });
      const response = await fetch(`/api/close/period-end-journals?${query.toString()}`);
      if (!response.ok)
        return { status: "failed", message: await readError(response, t("loadFailed")) };
      const body = (await response.json()) as { preview: Preview; history: HistoryEntry[] };
      return { status: "ready", preview: body.preview, history: body.history };
    } catch {
      return { status: "failed", message: t("loadFailed") };
    }
  }, [periodId, bookId, t]);

  useEffect(() => {
    let current = true;
    void fetchState().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [fetchState]);

  async function load() {
    setState({ status: "loading" });
    setState(await fetchState());
  }

  async function command(action: "generate" | "reverse") {
    const reason = await promptDialog({
      title: action === "generate" ? t("generateReasonTitle") : t("reverseReasonTitle"),
      message: t("reasonHint"),
      label: t("reasonLabel"),
      multiline: true,
      confirmLabel: action === "generate" ? t("generate") : t("reverse"),
    });
    if (reason === null) return;
    setBusy(true);
    try {
      const response = await fetch("/api/close/period-end-journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, periodId, bookId, reason }),
      });
      if (!response.ok) {
        toast.error(
          await readError(
            response,
            action === "generate" ? t("generateFailed") : t("reverseFailed"),
          ),
        );
        return;
      }
      const result = (await response.json()) as {
        generated?: unknown[];
        unchanged?: unknown[];
        refused?: { subsidiaryName: string; problems: Problem[] }[];
        reversed?: unknown[];
      };
      if (action === "reverse") {
        toast.success(t("reversed", { count: result.reversed?.length ?? 0 }));
      } else if (result.refused && result.refused.length > 0) {
        toast.error(t("partiallyRefused", { count: result.refused.length }), {
          description: result.refused
            .map(
              (entity) =>
                `${entity.subsidiaryName}: ${entity.problems.map((problem) => problem.message).join("; ")}`,
            )
            .join("\n"),
        });
      } else if ((result.generated?.length ?? 0) > 0) {
        toast.success(t("generated", { count: result.generated!.length }));
      } else {
        toast.info(t("unchanged"));
      }
      await load();
      router.refresh();
    } catch {
      toast.error(action === "generate" ? t("generateFailed") : t("reverseFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return <p className="text-sm text-slate-500">{t("loading")}</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {state.message}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw size={14} />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const { preview, history } = state;
  const pending = preview.entities.some(
    (entity) => entity.status === "not_generated" || entity.status === "stale",
  );
  const live = history.some((entry) => entry.status === "posted");
  // Entity refusals are reported per legal entity on generation; only an
  // organization-wide problem (policy, feature, periods) stops the action.
  const blocked = preview.problems.length > 0;
  const year = preview.fiscalYear;

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs text-slate-500">
        {t("scope", {
          year: year.fiscalYear,
          from: year.startsOn,
          to: year.endsOn,
          book: preview.book.name,
        })}
        {year.closingPeriod
          ? ` · ${t("closingPeriod", { period: year.closingPeriod.name })}`
          : null}
        {year.openingPeriod
          ? ` · ${t("openingPeriod", { period: year.openingPeriod.name })}`
          : null}
      </p>
      {preview.policy ? (
        <p className="text-xs text-slate-500">
          {preview.policy.closingMethod === "income_summary"
            ? t("policyIncomeSummary", {
                summary: preview.policy.incomeSummaryAccountName ?? "",
                retained: preview.policy.retainedEarningsAccountName ?? "",
              })
            : t("policyRetainedEarnings", {
                retained: preview.policy.retainedEarningsAccountName ?? "",
              })}
          {preview.policy.balanceSheetJournals ? ` · ${t("policyBalanceSheet")}` : null}
          {" · "}
          {t("policyEffective", { date: preview.policy.effectiveFrom })}
        </p>
      ) : null}
      {preview.problems.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle className="flex items-center gap-2">
            <AlertTriangle size={14} />
            {t("blocked")}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {preview.problems.map((problem) => (
                <li key={problem.code}>
                  {problem.message} — {problem.remedy}
                </li>
              ))}
            </ul>
            {preview.problems.some((problem) => problem.code.startsWith("policy_")) ? (
              <Link
                className="mt-2 inline-block text-sm underline"
                href={"/admin/setup/period-end-journal-policies" as never}
              >
                {t("openPolicy")}
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {preview.entities.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("empty")}</p>
      ) : (
        <div className="space-y-3">
          {preview.entities.map((entity) => (
            <div
              key={entity.subsidiaryId}
              className="space-y-2 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{entity.subsidiaryName}</span>
                <Badge variant={STATUS_VARIANT[entity.status]}>
                  {entity.status === "current" ? <Check size={12} /> : null}
                  {t(`status.${entity.status}`)}
                </Badge>
              </div>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate-500">{t("fiscalYearEarnings")}</dt>
                  <dd className="text-base font-semibold tabular-nums">
                    {money(entity.fiscalYearEarnings, { currency: entity.currency })}
                  </dd>
                </div>
                {!isZero(entity.priorUnclosedEarnings) ? (
                  <div>
                    <dt className="text-xs text-slate-500">{t("priorUnclosedEarnings")}</dt>
                    <dd className="text-base font-semibold tabular-nums">
                      {money(entity.priorUnclosedEarnings, { currency: entity.currency })}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {entity.problems.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">
                  {entity.problems.map((problem) => (
                    <li key={problem.code}>
                      {problem.message} — {problem.remedy}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entity.journals.length > 0 ? (
                <DisclosureSection
                  title={t("review")}
                  summary={t("journals", { count: entity.journals.length })}
                >
                  <div className="space-y-3">
                    {entity.journals.map((journal) => (
                      <div key={journal.kind} className="space-y-1">
                        <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                          {t(`kinds.${journal.kind}`)} · {journal.periodName} ·{" "}
                          {journal.postingDate}
                        </p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("columns.account")}</TableHead>
                              <TableHead>{t("columns.dimensions")}</TableHead>
                              <TableHead className="text-right">{t("columns.debit")}</TableHead>
                              <TableHead className="text-right">{t("columns.credit")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {journal.lines.map((line, index) => (
                              <TableRow key={`${line.accountId}-${index}`}>
                                <TableCell>
                                  {line.accountNumber
                                    ? `${line.accountNumber} · ${line.accountName}`
                                    : line.accountName}
                                </TableCell>
                                <TableCell className="text-xs text-slate-500">
                                  {line.dimensionLabels
                                    .map(
                                      (label) =>
                                        `${label.segment ?? t(`dimensions.${label.kind}`)}: ${label.label}`,
                                    )
                                    .join(" · ")}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {isDebit(line.amount)
                                    ? money(line.amount, { currency: entity.currency })
                                    : null}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {!isDebit(line.amount) && !isZero(line.amount)
                                    ? money(absolute(line.amount), { currency: entity.currency })
                                    : null}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ))}
                  </div>
                </DisclosureSection>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {canRun ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || !pending || blocked}
            onClick={() => void command("generate")}
          >
            <Play size={14} />
            {t("generate")}
          </Button>
          {live ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void command("reverse")}
            >
              <Undo2 size={14} />
              {t("reverse")}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">{t("runPermission")}</p>
      )}
      <DisclosureSection title={t("history")} summary={t("generations", { count: history.length })}>
        {history.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("historyEmpty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.entity")}</TableHead>
                <TableHead>{t("columns.generation")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead>{t("columns.generated")}</TableHead>
                <TableHead>{t("columns.reversed")}</TableHead>
                <TableHead>{t("columns.journals")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((entry) => (
                <TableRow key={entry.setId}>
                  <TableCell>{entry.subsidiaryName}</TableCell>
                  <TableCell className="tabular-nums">{entry.generation}</TableCell>
                  <TableCell>
                    <Badge variant={entry.status === "posted" ? "success" : "outline"}>
                      {t(`setStatus.${entry.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>
                      {t("by", {
                        name: entry.generatedByName ?? t("system"),
                        at: entry.generatedAt.slice(0, 10),
                      })}
                    </div>
                    <div className="text-slate-500">{entry.reason}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {entry.reversedAt ? (
                      <>
                        <div>
                          {t("by", {
                            name: entry.reversedByName ?? t("system"),
                            at: entry.reversedAt.slice(0, 10),
                          })}
                        </div>
                        <div className="text-slate-500">{entry.reversalReason}</div>
                      </>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    <ul className="space-y-0.5">
                      {entry.entries.map((journal) => (
                        <li key={journal.entryId}>
                          <JournalEntryLink className="underline" entryId={journal.entryId}>
                            {journal.entryNumber}
                          </JournalEntryLink>
                          {journal.reversalEntryId ? (
                            <>
                              {" → "}
                              <JournalEntryLink
                                className="underline"
                                entryId={journal.reversalEntryId}
                              >
                                {journal.reversalEntryNumber}
                              </JournalEntryLink>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DisclosureSection>
    </div>
  );
}
