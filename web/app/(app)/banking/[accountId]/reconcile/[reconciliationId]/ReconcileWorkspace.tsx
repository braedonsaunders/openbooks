"use client";

import { sum } from "@openbooks/engine/money/money";
import { useMoney } from "@/components/money-provider";
import type { MoneyValue } from "@/lib/money-format";
import { readApiErrorMessage } from "@/lib/api-error";
import type { Dispatch, SetStateAction } from "react";
import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ApprovalActions, refreshApprovalState } from "@/components/approval-actions";
import { Ban, CheckCheck, Link2, Pencil, RotateCcw, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@openbooks/ui";
import { SearchInput } from "../../../../../../components/search-input";
import { Pagination } from "../../../../../../components/pagination";
import { SortTh } from "../../../../../../components/sortable-th";
import { confirmDialog } from "../../../../../../lib/confirm";
import { promptDialog } from "../../../../../../lib/prompt";
import { isZeroAmount } from "./DifferenceBadge";
import { canonicalDecimal } from "../../../../../../lib/exact-decimal";
import { useDirtyClose } from "../../../../../../lib/use-dirty-close";
import { NeutralHistoryReview } from "./NeutralHistoryReview";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { DateField } from "@/components/date-field";

type Search = Record<string, string | string[] | undefined>;
interface PaneParams {
  q: string | undefined;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  perPage: number;
}

interface StmtRow {
  id: string;
  posted_on: string;
  amount: string;
  description: string | null;
  counterparty_ref: string | null;
  possible_duplicate_of: string | null;
  dup_posted_on: string | null;
  dup_amount: string | null;
}
interface GlRow {
  id: string;
  posting_date: string;
  entry_number: string;
  amount: string;
  memo: string | null;
  party: string | null;
}
interface MatchedRow {
  id: string;
  statement_line_id: string;
  matched_by: "auto" | "manual" | "rule";
  confidence: string | null;
  stmt_date: string;
  stmt_amount: string;
  stmt_description: string | null;
  entry_number: string;
  gl_date: string;
  gl_amount: string;
  gl_memo: string | null;
}

interface GlClearing {
  group_id: string;
  lines: number;
  entries: string | null;
  total: string;
}

interface StaleLateEntry {
  entryNumber: string;
  postingDate: string;
  amount: string;
  postedBy: string | null;
  postedAt: string | null;
}

interface StaleReversedEntry {
  entryNumber: string;
  postingDate: string;
  amount: string;
  reversal: string | null;
}

interface Staleness {
  reviewed?: boolean;
  reviewedHref?: string | null;
  reviewedText?: string | null;
  badge: string;
  effect: string;
  late: StaleLateEntry[];
  reversed: StaleReversedEntry[];
}
interface ReconciliationActionResult {
  status?: "signed_off" | "pending_approval";
  error?: string;
  matched?: number;
  highConfidence?: number;
  mediumConfidence?: number;
  journalLinesReconciled?: number;
}

interface SignOffBlocker {
  id: string;
  postedOn: string;
  amount: string;
  description: string | null;
  possibleDuplicateOf: string | null;
  possibleDuplicateOfPostedOn: string | null;
  possibleDuplicateOfAmount: string | null;
}

interface OpeningConfirmationState {
  amount: string;
  startDate: string;
  reason: string;
  confirmedAt: string;
  confirmedByName: string | null;
}

interface OpeningPositionState {
  isFirst: boolean;
  statementOpening: string | null;
  coverageStart: string | null;
  bookBalance: string;
  confirmation: OpeningConfirmationState | null;
  carryApplies: boolean;
  carryStart: string | null;
}

// The blockers endpoint returns the engine's camelCase SignOffBlocker;
// normalize once so the list below never renders a blank date.
function blockerPostedOn(line: SignOffBlocker & { posted_on?: string }): string {
  return line.postedOn ?? line.posted_on ?? "";
}

const selectedRow = "bg-teal-50 dark:bg-teal-950/40";

function useScopedSelection<T>(
  scope: string,
  initialValue: T,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [stored, setStored] = useState<{ scope: string; value: T }>(() => ({
    scope,
    value: initialValue,
  }));
  const value = stored.scope === scope ? stored.value : initialValue;
  const setValue: Dispatch<SetStateAction<T>> = (next) =>
    setStored((current) => {
      const previous = current.scope === scope ? current.value : initialValue;
      return {
        scope,
        value: typeof next === "function" ? (next as (value: T) => T)(previous) : next,
      };
    });
  return [value, setValue];
}

// Known matched_by enum values — unknown values render verbatim.
const MATCHED_BY_KEYS = ["auto", "manual", "rule"];

/**
 * Two-pane matching workspace: unmatched bank statement lines (left) against
 * unreconciled posted GL lines (right). Click a bank line, tick 1..n GL lines,
 * Match. Sign-off unlocks only at a 0.00 difference.
 */
type ReconcileWorkspaceProps = {
  basePath: string;
  accountPath: string;
  currentParams: Search;
  reconciliation: {
    id: string;
    status: string;
    throughDate: string;
    statementBalance: string;
    currency: string;
  };
  difference: string;
  canReconcile: boolean;
  canReviewSignOff?: boolean;
  stmtRows: StmtRow[];
  stmtTotal: number;
  stmtOutstandingTotal: string;
  stmtParams: PaneParams;
  glRows: GlRow[];
  glTotal: number;
  glOutstandingTotal: string;
  glParams: PaneParams;
  matchedRows: MatchedRow[];
  matchedTotal: number;
  mParams: PaneParams;
  glClearings?: GlClearing[];
  stale?: Staleness | null;
  priorEffects?: string[];
  opening?: OpeningPositionState | null;
};

export function ReconcileWorkspace(props: ReconcileWorkspaceProps) {
  return <ReconcileWorkspaceForId key={props.reconciliation.id} {...props} />;
}

function ReconcileWorkspaceForId({
  basePath,
  accountPath,
  currentParams,
  reconciliation,
  difference,
  canReconcile,
  canReviewSignOff = canReconcile,
  stmtRows,
  stmtTotal,
  stmtOutstandingTotal,
  stmtParams,
  glRows,
  glTotal,
  glOutstandingTotal,
  glParams,
  matchedRows,
  matchedTotal,
  mParams,
  glClearings = [],
  stale = null,
  priorEffects = [],
  opening = null,
}: ReconcileWorkspaceProps) {
  const { money: formatMoney } = useMoney(reconciliation.currency);
  const money = (value: MoneyValue) => formatMoney(value, { maximumFractionDigits: 4 });
  const t = useTranslations("banking.workspace");
  const tMatch = useTranslations("banking.match");
  const tBanking = useTranslations("banking");
  const tStale = useTranslations("banking.stale");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // A refused sign-off that only fires a transient toast reads as "nothing
  // happened" once it dismisses: the typed refusal persists as a workspace
  // alert with the blocking lines beside it, cleared by the next success.
  const [signOffError, setSignOffError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ lines: SignOffBlocker[]; total: number } | null>(null);
  // A refused opening confirmation that only fires a transient toast reads as
  // "nothing happened" once it dismisses — the typed refusal persists as a
  // workspace alert beside the opening form, cleared by the next success.
  const [openingError, setOpeningError] = useState<string | null>(null);
  const subjectKey = reconciliation.id;
  const selectionKey = JSON.stringify([
    subjectKey,
    stmtParams.q,
    stmtParams.sort,
    stmtParams.dir,
    stmtParams.page,
    stmtParams.perPage,
    glParams.q,
    glParams.sort,
    glParams.dir,
    glParams.page,
    glParams.perPage,
  ]);
  const [selectedStmts, setSelectedStmts] = useScopedSelection<Set<string>>(
    selectionKey,
    new Set(),
  );
  const [selectedGl, setSelectedGl] = useScopedSelection<Set<string>>(selectionKey, new Set());
  const [adjustOpen, setAdjustOpen] = useState(false);
  const adjustThroughDateId = useId();
  const adjustStatementBalanceId = useId();
  // A first reconciliation from a balance-less statement names its opening
  // explicitly: the amount starts at the book balance carried in — the only
  // value the service will accept — and the reason is the audit trail.
  const [openingAmount, setOpeningAmount] = useState(() => opening?.bookBalance ?? "");
  const [openingReason, setOpeningReason] = useState("");
  const openingAmountId = useId();
  const openingReasonId = useId();
  const [throughDate, setThroughDate] = useState(reconciliation.throughDate);
  const [statementBalance, setStatementBalance] = useState(() => reconciliation.statementBalance);
  const closeAdjust = () => {
    setAdjustOpen(false);
    setThroughDate(reconciliation.throughDate);
    setStatementBalance(reconciliation.statementBalance);
  };
  const adjustCloseGuard = useDirtyClose({
    dirty:
      throughDate !== reconciliation.throughDate ||
      statementBalance !== reconciliation.statementBalance,
    busy,
    onClose: closeAdjust,
    message: tCommon("feedback.unsavedChanges"),
    confirmLabel: tCommon("confirm.discardChanges"),
  });

  const signedOff = reconciliation.status === "signed_off";
  const zero = isZeroAmount(difference);
  const readOnly = signedOff || !canReconcile;

  const stmtSelectionSum = useMemo(
    () => sum(stmtRows.filter((r) => selectedStmts.has(r.id)).map((r) => r.amount)),
    [stmtRows, selectedStmts],
  );
  const glSelectionSum = useMemo(
    () => sum(glRows.filter((r) => selectedGl.has(r.id)).map((r) => r.amount)),
    [glRows, selectedGl],
  );

  async function call(
    method: string,
    url: string,
    body?: unknown,
    onError?: (message: string) => void,
  ): Promise<ReconciliationActionResult | null> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      // Refusals read through the shared helper so message, remedy and code
      // render instead of a bare fallback; the success body parses after the
      // ok check and never lets the read itself throw.
      if (!res.ok) {
        const message = await readApiErrorMessage(res, tBanking("errors.requestFailed"));
        if (onError) onError(message);
        else toast.error(message);
        return null;
      }
      // A success moves the session: any persisted refusal is stale.
      setSignOffError(null);
      setBlockers(null);
      setOpeningError(null);
      return (await res.json().catch(() => null)) as ReconciliationActionResult | null;
    } catch {
      const message = tBanking("errors.requestFailed");
      if (onError) onError(message);
      else toast.error(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadBlockers() {
    // Supplementary read beside the persisted refusal: its own failure must
    // never toast or wedge — the refusal already shows without the list.
    try {
      const res = await fetch(`/api/banking/reconciliations/${reconciliation.id}/blockers`);
      const data = (await res.json().catch(() => null)) as {
        lines?: SignOffBlocker[];
        total?: number;
      } | null;
      if (res.ok && Array.isArray(data?.lines)) {
        setBlockers({
          lines: data.lines,
          total: typeof data.total === "number" ? data.total : data.lines.length,
        });
      }
    } catch {
      // ignore: the refusal alert stands on its own
    }
  }

  async function runAutoMatch() {
    const data = await call("POST", `/api/banking/reconciliations/${reconciliation.id}/auto-match`);
    if (!data) return;
    if (data.matched === 0) toast.info(t("noAutoMatches"));
    else
      toast.success(
        t("autoMatchedToast", {
          count: data.matched ?? 0,
          high: data.highConfidence ?? 0,
          medium: data.mediumConfidence ?? 0,
        }),
      );
    router.refresh();
  }

  async function matchSelected() {
    if (selectedStmts.size === 0 || selectedGl.size === 0) return;
    const data = await call("POST", `/api/banking/reconciliations/${reconciliation.id}/matches`, {
      statementLineIds: [...selectedStmts],
      journalLineIds: [...selectedGl],
    });
    if (!data) return;
    toast.success(t("matchedToast"));
    setSelectedStmts(new Set());
    setSelectedGl(new Set());
    router.refresh();
  }

  async function clearSelected() {
    // GL-only offsetting lines with no bank counterpart clear as a zero-sum
    // group — no statement selection required.
    if (selectedStmts.size > 0 || selectedGl.size === 0) return;
    const data = await call(
      "POST",
      `/api/banking/reconciliations/${reconciliation.id}/gl-clearing`,
      {
        journalLineIds: [...selectedGl],
      },
    );
    if (!data) return;
    toast.success(t("clearedToast"));
    setSelectedGl(new Set());
    router.refresh();
  }

  async function confirmOpening() {
    // The refusal reads through the shared helper like every other
    // workspace mutation, and persists beside the opening form: a
    // confirmation the ledger does not prove keeps its typed message with
    // its remedy on screen instead of failing silently once the toast
    // dismisses.
    setOpeningError(null);
    const data = await call(
      "POST",
      `/api/banking/reconciliations/${reconciliation.id}/opening`,
      {
        openingBalance: openingAmount,
        reason: openingReason.trim(),
      },
      (message) => {
        setOpeningError(message);
        toast.error(message);
      },
    );
    if (!data) return;
    toast.success(t("openingConfirmedToast", { amount: money(openingAmount) }));
    setOpeningReason("");
    router.refresh();
  }

  async function unmatchClearing(groupId: string) {
    const data = await call(
      "DELETE",
      `/api/banking/reconciliations/${reconciliation.id}/gl-clearing?groupId=${groupId}`,
    );
    if (!data) return;
    toast.success(t("unmatchedToast"));
    router.refresh();
  }

  async function unmatch(statementLineId: string) {
    const data = await call(
      "DELETE",
      `/api/banking/reconciliations/${reconciliation.id}/matches?statementLineId=${statementLineId}`,
    );
    if (!data) return;
    toast.success(t("unmatchedToast"));
    router.refresh();
  }

  async function signOff() {
    const ok = await confirmDialog({
      message: t("signOffConfirm"),
    });
    if (!ok) return;
    setSignOffError(null);
    setBlockers(null);
    const data = await call(
      "POST",
      `/api/banking/reconciliations/${reconciliation.id}/sign-off`,
      undefined,
      (message) => {
        setSignOffError(message);
        toast.error(message);
      },
    );
    if (!data) {
      // List the lines the refusal counts, with dates, amounts and links —
      // a bare "N line(s) remain unmatched" names no actionable row.
      await loadBlockers();
      return;
    }
    if (data.status === "pending_approval") toast.info(tCommon("approvalFlow.submitted"));
    else if (typeof data.journalLinesReconciled === "number")
      toast.success(t("signedOffToast", { count: data.journalLinesReconciled }));
    refreshApprovalState();
    router.refresh();
  }

  async function withdrawSignOff() {
    const reason = await promptDialog({
      title: t("withdrawSignOffTitle"),
      message: t("withdrawSignOffMessage"),
      label: t("withdrawSignOffReason"),
      multiline: true,
      confirmLabel: t("withdrawSignOff"),
    });
    if (!reason) return;
    // A refusal (a later session to discard first, Banking closed) stays on
    // screen beside the sign-off, not only in a transient toast.
    const data = await call(
      "POST",
      `/api/banking/reconciliations/${reconciliation.id}/withdraw-sign-off`,
      { reason },
      (message) => {
        setSignOffError(message);
        toast.error(message);
      },
    );
    if (!data) return;
    toast.success(t("withdrawnToast"));
    router.refresh();
  }

  async function excludeStatementLine(id: string) {
    const reason = await promptDialog({
      title: tMatch("excludeReasonTitle"),
      label: tMatch("excludeReasonLabel"),
      placeholder: tMatch("excludeReasonPlaceholder"),
      confirmLabel: tMatch("exclude"),
    });
    if (!reason) return;
    const data = await call("PATCH", `/api/banking/statement-lines/${id}`, {
      action: "exclude",
      reason,
    });
    if (!data) return;
    toast.success(tMatch("excludedToast"));
    router.refresh();
  }

  // A flagged line is excluded with the duplicated line named in the reason,
  // so the audit trail says what it duplicates. The reviewer may edit the
  // prefilled reason before confirming.
  async function excludeDuplicate(line: StmtRow) {
    const description = (line.description ?? "").trim().slice(0, 200);
    const reason = await promptDialog({
      title: tMatch("excludeReasonTitle"),
      label: tMatch("excludeReasonLabel"),
      confirmLabel: tMatch("exclude"),
      initialValue:
        line.dup_posted_on && line.dup_amount
          ? t("excludeDuplicateReason", {
              date: line.dup_posted_on,
              amount: line.dup_amount,
              description: description || "—",
            })
          : t("excludeDuplicateReasonGeneric"),
    });
    if (!reason) return;
    const data = await call("PATCH", `/api/banking/statement-lines/${line.id}`, {
      action: "exclude",
      reason,
    });
    if (!data) return;
    toast.success(tMatch("excludedToast"));
    if (blockers) await loadBlockers();
    router.refresh();
  }

  async function clearDuplicate(id: string) {
    const ok = await confirmDialog({ message: tMatch("clearDuplicateConfirm") });
    if (!ok) return;
    const data = await call("PATCH", `/api/banking/statement-lines/${id}`, {
      action: "clear-duplicate",
    });
    if (!data) return;
    toast.success(tMatch("clearedDuplicateToast"));
    if (blockers) await loadBlockers();
    router.refresh();
  }

  async function discard() {
    const ok = await confirmDialog({
      message: t("discardConfirm"),
      tone: "danger",
    });
    if (!ok) return;
    const data = await call("DELETE", `/api/banking/reconciliations/${reconciliation.id}`);
    if (!data) return;
    toast.success(t("discardedToast"));
    router.push(accountPath);
    router.refresh();
  }

  async function saveAdjust() {
    const data = await call("PATCH", `/api/banking/reconciliations/${reconciliation.id}`, {
      throughDate,
      statementBalance,
    });
    if (!data) return;
    toast.success(t("updatedToast"));
    setAdjustOpen(false);
    router.refresh();
  }

  const paneTitle = "text-sm font-semibold text-slate-900 dark:text-slate-100";

  return (
    <div className="space-y-6">
      {signedOff ? (
        <Alert variant="success">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">{t("signedOffAlert")}</span>
            {canReconcile ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={withdrawSignOff}>
                {t("withdrawSignOff")}
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : (
        canReconcile && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy} onClick={runAutoMatch}>
              <Wand2 size={15} /> {t("autoMatch")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setAdjustOpen(true)}>
              <Pencil size={15} /> {t("adjust")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={discard}
              className="text-red-600 dark:text-red-400"
            >
              <Trash2 size={15} /> {t("discardSession")}
            </Button>
            <span className="flex-1" />
            {selectedStmts.size > 0 || selectedGl.size > 0 ? (
              <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                {t("selectionSummary", {
                  bank: money(stmtSelectionSum),
                  gl: money(glSelectionSum),
                })}
              </span>
            ) : null}
            <Button
              disabled={busy || selectedStmts.size === 0 || selectedGl.size === 0}
              onClick={matchSelected}
            >
              <Link2 size={15} /> {t("matchSelected")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || selectedStmts.size > 0 || selectedGl.size === 0}
              onClick={clearSelected}
              title={t("clearSelectedTitle")}
            >
              {t("clearSelected")}
            </Button>
            <ApprovalActions
              subjectKind="bank_reconciliation_sign_off"
              subjectId={reconciliation.id}
            />
            <Button
              disabled={busy || !zero}
              onClick={signOff}
              title={zero ? undefined : t("signOffDisabledTitle")}
            >
              <CheckCheck size={15} /> {t("signOff")}
            </Button>
          </div>
        )
      )}

      {/* -------- opening position: first reconciliation, balance-less statement -------- */}
      {/* -------- opening position: first reconciliation, balance-less statement -------- */}
      {!signedOff && canReconcile && opening?.isFirst && !opening.statementOpening ? (
        opening.confirmation && opening.carryApplies ? (
          <Alert variant="success">
            {t("openingConfirmedNote", {
              amount: money(opening.confirmation.amount),
              reason: opening.confirmation.reason,
            })}
          </Alert>
        ) : (
          <section
            className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800"
            aria-label={t("openingTitle")}
          >
            <div className="space-y-1">
              <h2 className={paneTitle}>{t("openingTitle")}</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {t("openingDescription")}
              </p>
              <p className="text-sm tabular-nums">
                {t("openingBookBalance", {
                  date: opening.coverageStart ?? reconciliation.throughDate,
                })}
                : <span className="font-medium">{money(opening.bookBalance)}</span>
              </p>
              {opening.confirmation && !opening.carryApplies ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t("openingStaleNote")}
                </p>
              ) : null}
              {openingError ? (
                <div
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                >
                  <p>{openingError}</p>
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={openingAmountId}>{t("openingAmountLabel")}</Label>
                <Input
                  id={openingAmountId}
                  disabled={busy}
                  inputMode="decimal"
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  className="text-right tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={openingReasonId}>{t("openingReasonLabel")}</Label>
                <Input
                  id={openingReasonId}
                  disabled={busy}
                  value={openingReason}
                  placeholder={t("openingReasonPlaceholder")}
                  onChange={(e) => setOpeningReason(e.target.value)}
                />
              </div>
            </div>
            <Button
              disabled={
                busy ||
                canonicalDecimal(openingAmount, 4) === null ||
                openingReason.trim().length < 5
              }
              onClick={confirmOpening}
            >
              {t("openingConfirm")}
            </Button>
          </section>
        )
      ) : null}

      {stale ? (
        <Alert variant={stale.reviewed ? "info" : "warning"}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={stale.reviewed ? "success" : "warning"}>{stale.badge}</Badge>
            <span className="font-medium tabular-nums">{stale.effect}</span>
          </div>
          {stale.late.length > 0 ? (
            <div className="mt-3 space-y-1">
              <p className="font-medium">{tStale("lateTitle")}</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tBanking("labels.entry")}</TableHead>
                    <TableHead>{tCommon("labels.date")}</TableHead>
                    <TableHead className="text-right">{tCommon("labels.amount")}</TableHead>
                    <TableHead>{tStale("postedBy")}</TableHead>
                    <TableHead>{tStale("postedAt")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stale.late.map((entry) => (
                    <TableRow key={entry.entryNumber}>
                      <TableCell className="font-medium">{entry.entryNumber}</TableCell>
                      <TableCell>{entry.postingDate}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(entry.amount)}
                      </TableCell>
                      <TableCell>{entry.postedBy ?? "—"}</TableCell>
                      <TableCell>{entry.postedAt ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {stale.reversed.length > 0 ? (
            <div className="mt-3 space-y-1">
              <p className="font-medium">{tStale("reversedTitle")}</p>
              <ul className="list-disc pl-5">
                {stale.reversed.map((entry) => (
                  <li key={entry.entryNumber}>
                    {entry.entryNumber} · {entry.postingDate} · {money(entry.amount)}
                    {entry.reversal ? ` · ${entry.reversal}` : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {stale.reviewed && stale.reviewedHref ? (
            <p className="mt-2">
              <Link href={stale.reviewedHref} className="underline">
                {stale.reviewedText}
              </Link>
            </p>
          ) : (
            <p className="mt-2">{tStale("remedy")}</p>
          )}
          {canReviewSignOff && signedOff && !stale.reviewed && stale.reversed.length === 0 ? (
            <NeutralHistoryReview
              key={reconciliation.id}
              reconciliationId={reconciliation.id}
              disabled={busy}
            />
          ) : null}
        </Alert>
      ) : null}

      {!signedOff && priorEffects.length > 0 ? (
        <Alert variant="info">
          <ul className="list-disc pl-5">
            {priorEffects.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {signOffError ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{signOffError}</p>
          {blockers && blockers.lines.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium">{t("blockingLines")}</p>
              <ul className="list-disc pl-5">
                {blockers.lines.map((line) => (
                  <li key={line.id}>
                    <a className="underline" href={`#stmt-line-${line.id}`}>
                      {blockerPostedOn(line)} · {money(line.amount)} · {line.description ?? "—"}
                    </a>
                    {line.possibleDuplicateOf ? (
                      <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
                        <Badge variant="warning">{tMatch("possibleDuplicateBadge")}</Badge>
                        <span className="text-xs text-slate-600 dark:text-slate-400">
                          {tMatch("possibleDuplicateOf", {
                            date: line.possibleDuplicateOfPostedOn ?? "",
                            amount: money((line.possibleDuplicateOfAmount ?? "0") as MoneyValue),
                          })}
                        </span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {blockers.total > blockers.lines.length ? (
                <p>
                  {t("moreBlockingLines", { shown: blockers.lines.length, total: blockers.total })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* -------- opening position: first reconciliation, balance-less statement -------- */}
        {/* -------- opening position: first reconciliation, balance-less statement -------- */}
        <section className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cn(paneTitle, "mr-auto")}>
              {t("bankLinesTitle")}{" "}
              <span className="font-normal text-slate-500 dark:text-slate-400">
                {t("bankLinesCount", { count: stmtTotal })}
              </span>
            </h2>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {t("outstandingTotal", { total: money(stmtOutstandingTotal) })}
            </span>
            <SearchInput
              placeholder={t("searchBankLines")}
              paramKey="stmtQ"
              pageParamKey="stmtPage"
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {!readOnly ? <TableHead className="w-8" /> : null}
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="date"
                  sort={stmtParams.sort}
                  dir={stmtParams.dir}
                  sortParamKey="stmtSort"
                  dirParamKey="stmtDir"
                  pageParamKey="stmtPage"
                >
                  {tCommon("labels.date")}
                </SortTh>
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="description"
                  sort={stmtParams.sort}
                  dir={stmtParams.dir}
                  sortParamKey="stmtSort"
                  dirParamKey="stmtDir"
                  pageParamKey="stmtPage"
                >
                  {tCommon("labels.description")}
                </SortTh>
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="amount"
                  sort={stmtParams.sort}
                  dir={stmtParams.dir}
                  sortParamKey="stmtSort"
                  dirParamKey="stmtDir"
                  pageParamKey="stmtPage"
                  align="right"
                >
                  {tCommon("labels.amount")}
                </SortTh>
                {!readOnly ? (
                  <TableHead>
                    <span className="sr-only">{tMatch("exclude")}</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stmtRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={readOnly ? 3 : 5}
                    className="text-center text-slate-500 dark:text-slate-400"
                  >
                    {stmtParams.q ? t("noBankLinesSearch") : t("allBankLinesMatched")}
                  </TableCell>
                </TableRow>
              ) : (
                stmtRows.map((l) => {
                  const selected = selectedStmts.has(l.id);
                  const toggleStmt = () =>
                    setSelectedStmts((current) => {
                      const next = new Set(current);
                      if (next.has(l.id)) next.delete(l.id);
                      else next.add(l.id);
                      return next;
                    });
                  return (
                    <InteractiveTableRow
                      key={l.id}
                      id={`stmt-line-${l.id}`}
                      aria-label={t("selectBankLineAria", {
                        date: l.posted_on,
                        amount: money(l.amount),
                      })}
                      className={cn(
                        !readOnly && "cursor-pointer",
                        selected && selectedRow,
                        "scroll-mt-24",
                      )}
                      onClick={readOnly ? undefined : toggleStmt}
                    >
                      {!readOnly ? (
                        <TableCell className="w-8">
                          <input
                            type="checkbox"
                            aria-label={t("selectBankLineAria", {
                              date: l.posted_on,
                              amount: money(l.amount),
                            })}
                            checked={selected}
                            onChange={toggleStmt}
                            onClick={(e) => e.stopPropagation()}
                            className="accent-teal-700"
                          />
                        </TableCell>
                      ) : null}
                      <TableCell className="whitespace-nowrap">{l.posted_on}</TableCell>
                      <TableCell className="max-w-[16rem]">
                        <div className="truncate">
                          {l.description ?? "—"}
                          {l.counterparty_ref ? (
                            <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                              {l.counterparty_ref}
                            </span>
                          ) : null}
                        </div>
                        {l.possible_duplicate_of ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <Badge variant="warning">{tMatch("possibleDuplicateBadge")}</Badge>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">
                              {tMatch("possibleDuplicateOf", {
                                date: l.dup_posted_on ?? "",
                                amount: money((l.dup_amount ?? "0") as MoneyValue),
                              })}
                            </span>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                      {!readOnly ? (
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          {l.possible_duplicate_of ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => excludeDuplicate(l)}
                              >
                                {t("excludeDuplicate")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                title={t("clearDuplicate")}
                                onClick={() => clearDuplicate(l.id)}
                              >
                                <RotateCcw size={14} />
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              title={tMatch("exclude")}
                              onClick={() => excludeStatementLine(l.id)}
                            >
                              <Ban size={14} />
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </InteractiveTableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <Pagination
            basePath={basePath}
            currentParams={currentParams}
            total={stmtTotal}
            page={stmtParams.page}
            perPage={stmtParams.perPage}
            pageParamKey="stmtPage"
          />
        </section>

        {/* -------- opening position: first reconciliation, balance-less statement -------- */}
        <section className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cn(paneTitle, "mr-auto")}>
              {t("ledgerLinesTitle")}{" "}
              <span className="font-normal text-slate-500 dark:text-slate-400">
                {t("ledgerLinesCount", { count: glTotal })}
              </span>
            </h2>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {t("outstandingTotal", { total: money(glOutstandingTotal) })}
            </span>
            <SearchInput placeholder={t("searchGlLines")} paramKey="glQ" pageParamKey="glPage" />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {!readOnly ? <TableHead className="w-8" /> : null}
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="date"
                  sort={glParams.sort}
                  dir={glParams.dir}
                  sortParamKey="glSort"
                  dirParamKey="glDir"
                  pageParamKey="glPage"
                >
                  {tCommon("labels.date")}
                </SortTh>
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="entry"
                  sort={glParams.sort}
                  dir={glParams.dir}
                  sortParamKey="glSort"
                  dirParamKey="glDir"
                  pageParamKey="glPage"
                >
                  {tBanking("labels.entry")}
                </SortTh>
                <TableHead>{tCommon("labels.memo")}</TableHead>
                <SortTh
                  basePath={basePath}
                  currentParams={currentParams}
                  column="amount"
                  sort={glParams.sort}
                  dir={glParams.dir}
                  sortParamKey="glSort"
                  dirParamKey="glDir"
                  pageParamKey="glPage"
                  align="right"
                >
                  {tCommon("labels.amount")}
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {glRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={readOnly ? 4 : 5}
                    className="text-center text-slate-500 dark:text-slate-400"
                  >
                    {glParams.q ? t("noGlLinesSearch") : t("allGlLinesReconciled")}
                  </TableCell>
                </TableRow>
              ) : (
                glRows.map((l) => {
                  const selected = selectedGl.has(l.id);
                  const toggle = () =>
                    setSelectedGl((prev) => {
                      const next = new Set(prev);
                      if (next.has(l.id)) next.delete(l.id);
                      else next.add(l.id);
                      return next;
                    });
                  return (
                    <InteractiveTableRow
                      key={l.id}
                      aria-label={t("selectGlLineAria", {
                        entry: l.entry_number,
                        amount: money(l.amount),
                      })}
                      className={cn(!readOnly && "cursor-pointer", selected && selectedRow)}
                      onClick={readOnly ? undefined : toggle}
                    >
                      {!readOnly ? (
                        <TableCell className="w-8">
                          <input
                            type="checkbox"
                            aria-label={t("selectGlLineAria", {
                              entry: l.entry_number,
                              amount: money(l.amount),
                            })}
                            checked={selected}
                            onChange={toggle}
                            onClick={(e) => e.stopPropagation()}
                            className="accent-teal-700"
                          />
                        </TableCell>
                      ) : null}
                      <TableCell className="whitespace-nowrap">{l.posting_date}</TableCell>
                      <TableCell className="font-mono text-[13px]">{l.entry_number}</TableCell>
                      <TableCell className="max-w-[14rem] truncate">
                        {l.memo ?? l.party ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                    </InteractiveTableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <Pagination
            basePath={basePath}
            currentParams={currentParams}
            total={glTotal}
            page={glParams.page}
            perPage={glParams.perPage}
            pageParamKey="glPage"
          />
        </section>
      </div>

      {/* -------- opening position: first reconciliation, balance-less statement -------- */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={cn(paneTitle, "mr-auto")}>
            {t("matchedTitle")}{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">
              {t("matchedCount", { count: matchedTotal })}
            </span>
          </h2>
          <SearchInput placeholder={t("searchMatches")} paramKey="mQ" pageParamKey="mPage" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <SortTh
                basePath={basePath}
                currentParams={currentParams}
                column="date"
                sort={mParams.sort}
                dir={mParams.dir}
                sortParamKey="mSort"
                dirParamKey="mDir"
                pageParamKey="mPage"
              >
                {t("columns.bankDate")}
              </SortTh>
              <TableHead>{t("columns.bankDescription")}</TableHead>
              <TableHead className="text-right">{t("columns.bankAmount")}</TableHead>
              <TableHead>{tBanking("labels.entry")}</TableHead>
              <TableHead>{t("columns.glMemo")}</TableHead>
              <TableHead className="text-right">{t("columns.glAmount")}</TableHead>
              <SortTh
                basePath={basePath}
                currentParams={currentParams}
                column="by"
                sort={mParams.sort}
                dir={mParams.dir}
                sortParamKey="mSort"
                dirParamKey="mDir"
                pageParamKey="mPage"
              >
                {t("columns.matchedBy")}
              </SortTh>
              {!readOnly ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matchedRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={readOnly ? 7 : 8}
                  className="text-center text-slate-500 dark:text-slate-400"
                >
                  {mParams.q ? t("noMatchesSearch") : t("noMatchesYet")}
                </TableCell>
              </TableRow>
            ) : (
              matchedRows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap">{m.stmt_date}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">
                    {m.stmt_description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.stmt_amount)}</TableCell>
                  <TableCell className="font-mono text-[13px]">{m.entry_number}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">{m.gl_memo ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.gl_amount)}</TableCell>
                  <TableCell>
                    <Badge variant={m.matched_by === "auto" ? "default" : "secondary"}>
                      {MATCHED_BY_KEYS.includes(m.matched_by)
                        ? tBanking(`matchedBy.${m.matched_by}`)
                        : m.matched_by}
                      {m.confidence ? ` · ${Number(m.confidence).toFixed(1)}` : ""}
                    </Badge>
                  </TableCell>
                  {!readOnly ? (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => unmatch(m.statement_line_id)}
                      >
                        {t("unmatch")}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <Pagination
          basePath={basePath}
          currentParams={currentParams}
          total={matchedTotal}
          page={mParams.page}
          perPage={mParams.perPage}
          pageParamKey="mPage"
        />
      </section>

      {/* -------- opening position: first reconciliation, balance-less statement -------- */}
      {glClearings.length > 0 ? (
        <section className="space-y-2">
          <h2 className={cn(paneTitle, "mr-auto")}>
            {t("clearingsTitle")}{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">
              {t("clearingsCount", { count: glClearings.length })}
            </span>
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tBanking("labels.entry")}</TableHead>
                <TableHead className="text-right">{tCommon("labels.lines")}</TableHead>
                <TableHead className="text-right">{tCommon("labels.amount")}</TableHead>
                {!readOnly ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {glClearings.map((g) => (
                <TableRow key={g.group_id}>
                  <TableCell className="font-mono text-[13px]">{g.entries ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.lines}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(g.total)}</TableCell>
                  {!readOnly ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => unmatchClearing(g.group_id)}
                      >
                        {t("unmatch")}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {/* -------- adjust drawer -------- */}
      <Drawer
        open={adjustOpen}
        onClose={adjustCloseGuard.close}
        size="sm"
        title={t("adjustTitle")}
        description={t("adjustDescription")}
        headerActions={
          <>
            <Button variant="outline" disabled={busy} onClick={adjustCloseGuard.close}>
              {tCommon("actions.cancel")}
            </Button>
            <Button
              disabled={busy || !throughDate || canonicalDecimal(statementBalance, 4) === null}
              onClick={saveAdjust}
            >
              {tCommon("actions.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={adjustThroughDateId}>{tBanking("labels.reconcileThrough")}</Label>
            <DateField
              id={adjustThroughDateId}
              disabled={busy}
              value={throughDate}
              onChange={(value) => setThroughDate(value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={adjustStatementBalanceId}>{tBanking("labels.statementBalance")}</Label>
            <Input
              id={adjustStatementBalanceId}
              disabled={busy}
              inputMode="decimal"
              value={statementBalance}
              onChange={(e) => setStatementBalance(e.target.value)}
              className="text-right tabular-nums"
            />
          </div>
        </div>
      </Drawer>
    </div>
  );
}
