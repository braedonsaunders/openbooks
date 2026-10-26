"use client";

import { useIdentityState } from "@/lib/use-identity-state";
import { ApiResponseError } from "@/lib/api-error";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { toast } from "sonner";
import { isUuid, mergeHref, pickString } from "../../../../../lib/list-params";
import { BASE, MODULES, drawerHref, post } from "./close-setup-shared";
import type { BankingReconAccount, PeriodRow, Props } from "./close-setup-types";

/** Drawer state and close/reopen commands for one fiscal period. */
export function usePeriodDrawerState(row: PeriodRow | undefined, props: Props) {
  const { date, civilDate } = useViewerFormat();
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "periods", "period", null);
  const creating = pickString(props.currentParams.period) === "new";
  const selectedBook =
    props.books.find((book) => book.id === props.selectedBookId) ?? props.books[0];
  const [calendarId, setCalendarId] = useState(
    props.calendarOptions.find((item) => item.is_default)?.id ?? props.calendarOptions[0]?.id ?? "",
  );
  const [year, setYear] = useState(props.fiscalYear);
  const [action, setAction] = useState<{
    module: string;
    state: string;
  } | null>(null);
  // One reason draft per module: opening another module's close starts
  // empty instead of prefilling the previous module's text, and a posted
  // close clears only its own module's draft.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const reason = action ? (reasons[action.module] ?? "") : "";
  function setReason(value: string) {
    if (!action) return;
    const module = action.module;
    setReasons((prev) => ({ ...prev, [module]: value }));
  }
  function clearReason(module: string) {
    setReasons((prev) => {
      if (!(module in prev)) return prev;
      const next = { ...prev };
      delete next[module];
      return next;
    });
  }
  const [includeGl, setIncludeGl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // One-reason close across every module. Overrides stay per module; results
  // stay visible until the panel closes so a partial run is explicit.
  const [closeAll, setCloseAll] = useState(false);
  const [closeAllReason, setCloseAllReason] = useState("");
  // Banking reconciliation coverage for the period, shown whenever a
  // Banking close is on the table. The server still gates the close; this
  // is the operator's read of the same statuses plus the acknowledgement
  // the close requires when any account is unsigned or stale.
  const [bankingAck, setBankingAck] = useState("");
  const bankingClosePending =
    (action?.module === "banking" &&
      (action.state === "closed" || action.state === "soft_closed")) ||
    closeAll;
  const [bankingStatus, setBankingStatus] = useIdentityState<{
    accounts: {
      accountId: string;
      number: string | null;
      name: string;
      status: string;
      throughDate: string | null;
      difference: string | null;
      stale: boolean;
      staleSince: string | null;
      clearedEffect: string | null;
    }[];
    issues: unknown[];
    unmatchedStatementLines: number | null;
  } | null>([bankingClosePending, row?.id, selectedBook?.id], null);
  // Arming the close confirm: the first Confirm click names the module and
  // its consequences (plus live Banking counts) instead of posting, so a
  // tap on the wrong module row can still be cancelled. Resets whenever the
  // pending action changes.
  const [closeArmed, setCloseArmed] = useIdentityState([action?.module, action?.state], false);
  const [bankingUnavailable, setBankingUnavailable] = useIdentityState(
    [bankingClosePending, row?.id, selectedBook?.id],
    false,
  );
  useEffect(() => {
    if (!bankingClosePending || !row || !selectedBook) return;
    let live = true;
    post(
      {
        action: "banking-close-status",
        periodId: row.id,
        bookId: selectedBook.id,
      },
      t("errors.actionFailed"),
    )
      .then((data) => {
        if (!live) return;
        const status = data as {
          accounts?: BankingReconAccount[];
          unmatchedStatementLines?: unknown;
        };
        const accounts = status.accounts;
        setBankingStatus({
          accounts: Array.isArray(accounts) ? (accounts as BankingReconAccount[]) : [],
          issues: [],
          unmatchedStatementLines:
            typeof status.unmatchedStatementLines === "number"
              ? status.unmatchedStatementLines
              : null,
        });
        setBankingUnavailable(false);
      })
      .catch(() => {
        if (!live) return;
        setBankingStatus(null);
        setBankingUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, [bankingClosePending, row, selectedBook, t, setBankingStatus, setBankingUnavailable]);
  // The armed close confirm belongs to one pending module action: changing
  // the module or the target state disarms it.
  // Deep link from a closed-period refusal: ?reopenModule=<module> arms
  // that module's reopen form on open, and ?reopenEntity=<subsidiary>
  // carries the refused entity through the request. Both validate here;
  // anything else opens the plain drawer. One-shot per mount so posting
  // (which clears the action) never re-arms the form.
  const prefillModule = pickString(props.currentParams.reopenModule);
  const reopenPrefillModule = MODULES.includes(prefillModule as (typeof MODULES)[number])
    ? (prefillModule as (typeof MODULES)[number])
    : null;
  const prefillEntity = pickString(props.currentParams.reopenEntity);
  const reopenPrefillEntity = prefillEntity && isUuid(prefillEntity) ? prefillEntity : null;
  const reopenPrefillEntityName = reopenPrefillEntity
    ? (props.subsidiaries.find((item) => item.id === reopenPrefillEntity)?.display_name ??
      props.subsidiaries.find((item) => item.id === reopenPrefillEntity)?.name ??
      reopenPrefillEntity)
    : null;
  const prefillConsumed = useRef(false);
  useEffect(() => {
    if (prefillConsumed.current || action || !reopenPrefillModule) return;
    prefillConsumed.current = true;
    setAction({ module: reopenPrefillModule, state: "reopen" });
  }, [action, reopenPrefillModule]);
  const [closeAllOverrides, setCloseAllOverrides] = useState<Record<string, string>>({});
  const [closeAllResults, setCloseAllResults] = useState<
    { module: string; ok: boolean; error?: string }[] | null
  >(null);
  // One end-window reason draft per active reopen request on this row.
  const [endReasons, setEndReasons] = useState<Record<string, string>>({});
  async function generate() {
    setBusy(true);
    setGenerateError(null);
    try {
      await post(
        { action: "generate-periods", calendarId, fiscalYear: year },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.periodsGenerated"));
      // Build from the base path with the full param set: feeding the
      // tab-bearing drawer href back into mergeHref once produced a second
      // "?" (...?tab=periods?fy=2025). The hardened mergeHref also keeps
      // chained builds safe everywhere else.
      router.push(mergeHref(BASE, props.currentParams, { tab: "periods", period: null, fy: year }));
      router.refresh();
    } catch (error) {
      setGenerateError(
        error instanceof ApiResponseError && error.message
          ? error.message
          : t("errors.actionFailed"),
      );
      toast.error(t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  // A subledger reopen over a closed GL can never be approved, so the form
  // offers to include General ledger up front; the engine still refuses a
  // subledger-only request at creation with the same remedy.
  const offerIncludeGl =
    action?.state === "reopen" &&
    action.module !== "gl" &&
    (row?.locks?.["gl"]?.state ?? "open") === "closed";
  // Live Banking counts for the close confirm, read from the same
  // readiness data as the acknowledgement panel — never a second checker.
  const bankingInProgress =
    bankingStatus?.accounts.filter((account) => account.status === "in_progress").length ?? null;
  const bankingUnmatched = bankingStatus?.unmatchedStatementLines ?? null;
  const bankingConfirmDetail =
    action?.module === "banking" &&
    (action.state === "closed" || action.state === "soft_closed") &&
    bankingStatus !== null &&
    ((bankingInProgress ?? 0) > 0 || (bankingUnmatched ?? 0) > 0)
      ? t("periods.bankingCloseConfirmDetail", {
          inProgress: bankingInProgress ?? 0,
          unmatched: bankingUnmatched ?? 0,
        })
      : null;
  // Closing out of order is allowed but never silent: the armed summary
  // names earlier periods with activity whose same module is still open.
  const earlierOpenPeriods =
    row && action && (action.state === "closed" || action.state === "soft_closed")
      ? props.periods
          .filter(
            (period) =>
              period.calendar_name === row.calendar_name &&
              period.starts_on < row.starts_on &&
              Number(period.entries ?? 0) > 0 &&
              (period.locks?.[action.module]?.state ?? "open") === "open",
          )
          .sort((left, right) => left.starts_on.localeCompare(right.starts_on))
          .map((period) => period.name)
      : [];
  // The first Confirm click arms the summary (module, consequences, live
  // Banking counts); only the second posts. A tap on the wrong module row
  // still cancels here instead of closing the wrong books.
  const actionCloses = action?.state === "closed" || action?.state === "soft_closed";
  function confirmAction() {
    if (actionCloses && !closeArmed) {
      setCloseArmed(true);
      return;
    }
    void apply();
  }
  // A submit that sends nothing must still say why: a dead form with no
  // feedback reads as a broken close. The checks stay inline (not in a
  // helper) so the row and book narrow for the post below.
  async function apply() {
    if (!action) return;
    if (!row || !selectedBook) {
      const message = t("periods.closeUnavailable");
      setActionError(message);
      toast.error(message);
      return;
    }
    if (!reason.trim()) {
      const message = t("periods.reasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if (action.state === "reopen")
        await post(
          {
            action: "request-reopen",
            periodId: row.id,
            bookId: selectedBook.id,
            ...(reopenPrefillEntity ? { subsidiaryId: reopenPrefillEntity } : {}),
            modules:
              action.module === "gl" || !offerIncludeGl
                ? [action.module]
                : includeGl
                  ? [action.module, "gl"]
                  : [action.module],
            reason,
          },
          t("errors.actionFailed"),
          t("periods.requestTimedOut"),
        );
      else
        await post(
          {
            action: "set-lock",
            periodId: row.id,
            bookId: selectedBook.id,
            module: action.module,
            state: action.state,
            reason,
            ...(bankingAck.trim() ? { bankingAcknowledgement: bankingAck.trim() } : {}),
          },
          t("errors.actionFailed"),
          t("periods.requestTimedOut"),
        );
      toast.success(
        t(
          action.state === "reopen"
            ? "messages.reopenRequested"
            : action.state === "open"
              ? "messages.unlockSaved"
              : "messages.lockSaved",
        ),
      );
      const closedModule = action.module;
      setAction(null);
      clearReason(closedModule);
      setIncludeGl(true);
      setBankingAck("");
      // A prefilled request must not re-arm on refresh: consume the deep
      // link once the request posts.
      if (reopenPrefillModule || reopenPrefillEntity)
        router.push(
          mergeHref(BASE, props.currentParams, { reopenModule: null, reopenEntity: null }),
        );
      router.refresh();
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  // One reason closes every module through the native per-module command
  // (GL last, each transition audited). Per-module results stay in the panel:
  // a partial run names the failed module and skips the rest explicitly.
  async function applyCloseAll() {
    if (!row || !selectedBook) {
      const message = t("periods.closeUnavailable");
      setActionError(message);
      toast.error(message);
      return;
    }
    if (!closeAllReason.trim()) {
      const message = t("periods.reasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const overrides = Object.fromEntries(
        Object.entries(closeAllOverrides).filter(([, value]) => value.trim()),
      );
      const data = (await post(
        {
          action: "close-period",
          periodId: row.id,
          bookId: selectedBook.id,
          reason: closeAllReason.trim(),
          ...(Object.keys(overrides).length > 0 ? { moduleReasons: overrides } : {}),
          ...(bankingAck.trim() ? { bankingAcknowledgement: bankingAck.trim() } : {}),
        },
        t("errors.actionFailed"),
        t("periods.requestTimedOut"),
      )) as { ok?: unknown; results?: { module: string; ok: boolean; error?: string }[] };
      const results = Array.isArray(data.results) ? data.results : [];
      setCloseAllResults(results);
      if (data.ok) {
        toast.success(t("messages.closeAllSaved"));
        setCloseAll(false);
        setCloseAllReason("");
        setCloseAllOverrides({});
        setCloseAllResults(null);
        setBankingAck("");
      } else {
        toast.error(t("messages.closeAllPartial"));
      }
      router.refresh();
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  // End one active window from the period row: the same audited
  // reclose-reopen command as the request detail, so a stale window on
  // already-closed modules can be cleared without opening the detail.
  async function endActiveWindow(requestId: string) {
    const windowReason = (endReasons[requestId] ?? "").trim();
    if (windowReason.length < 10) {
      const message = t("periods.endReopenReasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    if (!row || !selectedBook) {
      const message = t("periods.closeUnavailable");
      setActionError(message);
      toast.error(message);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await post(
        { action: "reclose-reopen", requestId, reason: windowReason },
        t("errors.actionFailed"),
        t("periods.requestTimedOut"),
      );
      toast.success(t("messages.reopenEnded"));
      setEndReasons((prev) => {
        if (!(requestId in prev)) return prev;
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      router.refresh();
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  return {
    date,
    civilDate,
    t,
    td,
    router,
    closeHref,
    creating,
    selectedBook,
    calendarId,
    setCalendarId,
    year,
    setYear,
    action,
    setAction,
    reason,
    setReason,
    clearReason,
    includeGl,
    setIncludeGl,
    busy,
    actionError,
    generateError,
    closeAll,
    setCloseAll,
    closeAllReason,
    setCloseAllReason,
    bankingAck,
    setBankingAck,
    bankingStatus,
    closeArmed,
    setCloseArmed,
    bankingUnavailable,
    reopenPrefillEntity,
    reopenPrefillEntityName,
    closeAllOverrides,
    setCloseAllOverrides,
    closeAllResults,
    setCloseAllResults,
    endReasons,
    setEndReasons,
    generate,
    offerIncludeGl,
    bankingConfirmDetail,
    earlierOpenPeriods,
    actionCloses,
    confirmAction,
    applyCloseAll,
    endActiveWindow,
  };
}
