"use client";

// Contextual approval controls for the record flyout:
// when a document is pending_approval, the viewer sees green Approve + Reject
// buttons if the record-state API says they can decide the flow gate, or a
// subtle "Pending with {names}" chip when they cannot. Reject always collects a
// reason through the shared promptDialog. A 409 (someone else decided first)
// toasts and refreshes instead of erroring.
//
// The record-state fetch is shared with <ApprovalHistory> via
// useRecordApprovalState below: every mounted hook refetches when
// refreshApprovalState() fires after a decision.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { TriangleAlert, Users } from "lucide-react";
import { readApiErrorMessage } from "../lib/api-error";
import { promptDialog } from "../lib/prompt";
import type { RecordApprovalState } from "../app/api/flows/record-state/route";
import { documentActionAvailable } from "../lib/document-action-availability";

export type { RecordApprovalState };

/**
 * The document surface's Withdraw inputs: the record id, its lifecycle status,
 * and the viewer's grants on the kind (create = submit grant, approve = the
 * grant the withdraw route checks for a submission the viewer did not make).
 */
export interface ApprovalWithdrawSurface {
  documentId: string;
  status: string;
  canCreate: boolean;
  canApprove: boolean;
}

// --- shared record-state store ----------------------------------------------

const listeners = new Set<() => void>();

/** Re-fetch every mounted useRecordApprovalState hook (post-decision). */
export function refreshApprovalState() {
  for (const l of listeners) l();
}

export interface RecordApprovalLoad {
  /** Last good record state; null while loading or when no load ever succeeded. */
  state: RecordApprovalState | null;
  /**
   * Named load failure (F1-11). Set when the fetch fails AND whenever a
   * refresh fails — but a refresh failure keeps the last good state, so
   * live controls never vanish under the operator. Cleared on success.
   */
  loadError: string | null;
  /** Re-run the load (the named remedy for loadError). */
  reload: () => void;
  /**
   * The server answered that this caller has no approval state for the
   * record (404: no read access, outside scope, or no longer exists). That is
   * not a load failure to retry: approval surfaces render nothing, and an
   * Approvals tab shows its empty body.
   */
  unavailable: boolean;
}

function isRecordApprovalState(value: unknown): value is RecordApprovalState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>,
    approval = record.approvalState;
  if (!approval || typeof approval !== "object") return false;
  const state = approval as Record<string, unknown>;
  if (
    typeof state.status !== "string" ||
    !Array.isArray(state.pendingWith) ||
    !state.pendingWith.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.name === "string" &&
        typeof entry.since === "string",
    )
  )
    return false;
  const action = state.myActions;
  if (
    action !== null &&
    (!action ||
      typeof action !== "object" ||
      typeof (action as Record<string, unknown>).gateId !== "string" ||
      typeof (action as Record<string, unknown>).signatureRequired !== "boolean")
  )
    return false;
  return (
    Array.isArray(record.history) &&
    typeof record.canRetry === "boolean" &&
    (record.failedRun === null ||
      (!!record.failedRun &&
        typeof record.failedRun === "object" &&
        typeof (record.failedRun as Record<string, unknown>).id === "string"))
  );
}

export function useRecordApprovalState(subjectKind: string, subjectId: string): RecordApprovalLoad {
  const t = useTranslations("common");
  const [state, setState] = useState<RecordApprovalState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/flows/record-state?subjectKind=${encodeURIComponent(subjectKind)}&subjectId=${encodeURIComponent(subjectId)}`,
        );
        // Check the status BEFORE parsing (F1-11): the old shape mapped
        // every refusal to null and swallowed the catch, so state stayed
        // null and the approval UI vanished silently. A non-JSON error
        // body surfaces the translated fallback with its status, never a
        // SyntaxError; a JSON refusal surfaces the server's named message.
        if (res.status === 404) {
          if (!cancelled) {
            setState(null);
            setUnavailable(true);
            setLoadError(null);
          }
          return;
        }
        if (!res.ok) {
          const status = res.status;
          const named = await readApiErrorMessage(res, t("feedback.loadFailed"));
          // A bare machine code ("not_found", "invalid_subject") is never
          // operator copy: show the translated load failure with its status.
          const message = /^[a-z][a-z0-9_]*$/.test(named)
            ? await readApiErrorMessage(new Response(null, { status }), t("feedback.loadFailed"))
            : named;
          if (!cancelled) setLoadError(message);
          return;
        }
        const data = (await res.json().catch(() => null)) as RecordApprovalState | null;
        if (!cancelled) {
          if (isRecordApprovalState(data)) {
            setState(data);
            setUnavailable(false);
            setLoadError(null);
          } else {
            setState(null);
            setUnavailable(false);
            setLoadError(t("feedback.loadFailed"));
          }
        }
      } catch {
        if (!cancelled) setLoadError(t("feedback.loadFailed"));
      }
    };
    load();
    listeners.add(load);
    return () => {
      cancelled = true;
      listeners.delete(load);
    };
  }, [subjectKind, subjectId, t]);

  const reload = useCallback(() => {
    setLoadError(null);
    refreshApprovalState();
  }, []);

  return { state, loadError, reload, unavailable };
}

// --- header controls ----------------------------------------------------------

export function ApprovalActions({
  subjectKind,
  subjectId,
  submitApprovalHref,
  submitApprovalBody,
  submitApprovalMethod = "POST",
  submissionStatuses = ["pending"],
  withdraw,
  decisionDisabled = false,
}: {
  subjectKind: string;
  subjectId: string;
  /** A changed canonical record requires withdrawal and fresh review. */
  decisionDisabled?: boolean;
  /**
   * POST endpoint that submits a never-submitted record into its current
   * flow (for records created before the flow existed). Passed only by
   * surfaces that own such a path — the row stays quiet without it.
   */
  submitApprovalHref?: string;
  submitApprovalMethod?: "POST" | "PATCH";
  submitApprovalBody?: Record<string, unknown>;
  /** Native pending lifecycle states admitted by this subject’s submit command. */
  submissionStatuses?: readonly string[];
  /**
   * Native "Withdraw submission" recall for document surfaces. Passed only
   * by surfaces whose kind routes withdrawals through the documents action
   * route. The button renders only where the shared document action rule
   * offers withdraw for this viewer, so strangers never see an action that
   * would refuse them.
   */
  withdraw?: ApprovalWithdrawSurface;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const { state, loadError, reload, unavailable } = useRecordApprovalState(subjectKind, subjectId);
  const [busy, setBusy] = useState(false);
  const deciding = useRef(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const decisionNotice = notice ? (
    <span
      role={notice.kind === "error" ? "alert" : "status"}
      className={
        notice.kind === "error"
          ? "text-sm text-red-700 dark:text-red-300"
          : "text-sm text-emerald-700 dark:text-emerald-300"
      }
    >
      {notice.message}
    </span>
  ) : null;

  const decide = useCallback(
    async (decision: "approved" | "rejected") => {
      const my = state?.approvalState.myActions;
      if (!my?.gateId || deciding.current || decisionDisabled) return;
      deciding.current = true;
      setBusy(true);
      setNotice(null);
      try {
        let comment: string | undefined, signature: string | undefined;
        if (decision === "rejected") {
          const reason = await promptDialog({
            title: t("approvalFlow.rejectTitle"),
            label: t("approvalFlow.rejectReasonLabel"),
            confirmLabel: t("actions.reject"),
          });
          if (!reason) return;
          comment = reason;
        } else if (my.signatureRequired) {
          const signed = await promptDialog({
            title: t("approvalFlow.signTitle"),
            label: t("approvalFlow.signLabel"),
            confirmLabel: t("actions.approve"),
          });
          if (!signed?.trim()) return;
          signature = signed.trim();
        }
        const res = await fetch("/api/flows/gates/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gateId: my.gateId, decision, comment, signature }),
        });
        if (!res.ok) {
          const message = await readApiErrorMessage(res, t("approvalFlow.decisionFailed"));
          setNotice({ kind: "error", message });
          toast.error(message);
          return;
        }
        const data = (await res.json().catch(() => null)) as { resumed?: unknown } | null;
        const message = t(
          data?.resumed === null ? "approvalFlow.waitingOthers" : "approvalFlow.decisionRecorded",
        );
        setNotice({ kind: "success", message });
        toast.success(message);
      } catch {
        const message = t("approvalFlow.decisionFailed");
        setNotice({ kind: "error", message });
        toast.error(message);
      } finally {
        deciding.current = false;
        setBusy(false);
        refreshApprovalState();
        router.refresh();
      }
    },
    [state, router, t, decisionDisabled],
  );

  const retryRun = useCallback(async () => {
    const run = state?.failedRun;
    if (!run || deciding.current) return;
    deciding.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/flows/runs/${run.id}/retry`, { method: "POST" });
      if (!res.ok) toast.error(await readApiErrorMessage(res, t("approvalFlow.retryFailed")));
      else toast.success(t("approvalFlow.retried"));
    } catch {
      toast.error(t("approvalFlow.retryFailed"));
    } finally {
      deciding.current = false;
      setBusy(false);
      refreshApprovalState();
      router.refresh();
    }
  }, [state, router, t]);

  const submitForApproval = useCallback(async () => {
    if (!submitApprovalHref || deciding.current) return;
    deciding.current = true;
    setBusy(true);
    try {
      const res = await fetch(submitApprovalHref, {
        method: submitApprovalMethod,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitApprovalBody ?? {}),
      });
      if (!res.ok) toast.error(await readApiErrorMessage(res, t("approvalFlow.submitFailed")));
      else toast.success(t("approvalFlow.submitted"));
    } catch {
      toast.error(t("approvalFlow.submitFailed"));
    } finally {
      deciding.current = false;
      setBusy(false);
      refreshApprovalState();
      router.refresh();
    }
  }, [submitApprovalHref, submitApprovalBody, submitApprovalMethod, router, t]);

  // The submitter's own recall of a submission still awaiting decision
  // (or a holder of the kind's approve grant): collect the mandatory reason,
  // withdraw through the documents action route, then refresh the approval
  // state so the drawer shows the draft again.
  const commandWithdrawHref = state?.canWithdrawCommand
    ? `/api/flows/commands/${encodeURIComponent(subjectKind)}/${encodeURIComponent(subjectId)}/withdraw`
    : null;
  const withdrawDocumentId = withdraw?.documentId;
  const withdrawSubmission = useCallback(async () => {
    if (!withdrawDocumentId && !commandWithdrawHref) return;
    const reason = await promptDialog({
      title: t("approvalFlow.withdrawTitle"),
      label: t("approvalFlow.withdrawReasonLabel"),
      confirmLabel: t("actions.withdrawSubmission"),
    });
    if (!reason) return;
    setBusy(true);
    try {
      const res = await fetch(commandWithdrawHref ?? "/api/documents/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          commandWithdrawHref
            ? { reason }
            : { action: "withdraw", documentId: withdrawDocumentId, reason },
        ),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("approvalFlow.withdrawFailed")));
      } else {
        toast.success(
          t(commandWithdrawHref ? "approvalFlow.commandWithdrawn" : "approvalFlow.withdrawn"),
        );
      }
    } catch {
      toast.error(t("approvalFlow.withdrawFailed"));
    } finally {
      setBusy(false);
    }
    refreshApprovalState();
    router.refresh();
  }, [withdrawDocumentId, commandWithdrawHref, router, t]);

  const showWithdraw =
    !!commandWithdrawHref ||
    (!!withdraw &&
      !!state &&
      state.approvalState.status === "pending_approval" &&
      documentActionAvailable("withdraw", {
        status: withdraw.status,
        directPost: false,
        canCreate: withdraw.canCreate,
        canPost: withdraw.canApprove,
        submittedByViewer: state.submittedByViewer,
      }));

  const withdrawButton = showWithdraw ? (
    <Button variant="outline" disabled={busy} onClick={withdrawSubmission}>
      {t("actions.withdrawSubmission")}
    </Button>
  ) : null;

  const showRetry = !!state?.failedRun && !!state?.canRetry;
  // A record the engine never saw (no run, hence no live gate and no failed
  // run) with a status still claiming it awaits approval: offer the surface's
  // submit path. neverSubmitted already implies the gate/run absences; the
  // status check keeps the button off records that are not awaiting anything.
  const showSubmit =
    !!submitApprovalHref &&
    !!state &&
    submissionStatuses.includes(state.approvalState.status) &&
    !state.approvalState.myActions &&
    state.approvalState.pendingWith.length === 0 &&
    !state.failedRun;
  // A failed record-state load with nothing to show (F1-11): name the
  // failure and offer the remedy inline instead of vanishing. A refresh
  // failure over last-good state keeps the live controls above.
  if (!state && unavailable) return null;
  if (!state && loadError) {
    return (
      <span className="inline-flex max-w-72 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={loadError}>
          {loadError}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            reload();
            setBusy(false);
          }}
          className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
        >
          {t("actions.retry")}
        </button>
      </span>
    );
  }
  if (
    !state ||
    (!state.approvalState.myActions &&
      state.approvalState.pendingWith.length === 0 &&
      !showRetry &&
      !showSubmit &&
      !showWithdraw)
  )
    return null;

  // A failed run strands the record with no live gate: offer a
  // retry that re-drives the stored trigger through the current graph. It
  // renders beside a stale pending chip when one lingers, never instead of
  // live Approve/Reject buttons.
  const retryButton = showRetry ? (
    <Button
      variant="outline"
      disabled={busy}
      onClick={retryRun}
      title={state?.failedRun?.error ?? undefined}
    >
      {t("approvalFlow.retryRun")}
    </Button>
  ) : null;

  if (state.approvalState.myActions) {
    return (
      <>
        <Button
          disabled={busy || decisionDisabled}
          aria-busy={busy}
          onClick={() => decide("approved")}
          className="bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800"
        >
          {t("actions.approve")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || decisionDisabled}
          aria-busy={busy}
          onClick={() => decide("rejected")}
        >
          {t("actions.reject")}
        </Button>
        {withdrawButton}
        {decisionNotice}
      </>
    );
  }

  if (notice)
    return (
      <>
        {decisionNotice}
        {withdrawButton}
      </>
    );

  // Separation of duties resolved in advance: a gate that reaches this
  // viewer but blocks them as submitter/maker renders "Awaiting another
  // approver" — never an Approve that refuses on click. The generic
  // "Pending with" chip below stays for viewers who were never assigned.
  if (!state.approvalState.myActions && state.approvalState.awaitingAnotherApprover) {
    return (
      <>
        <span
          className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          title={t("approvalFlow.awaitingAnother")}
        >
          <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("approvalFlow.awaitingAnother")}</span>
        </span>
        {withdrawButton}
        {retryButton}
      </>
    );
  }

  if (state.approvalState.pendingWith.length > 0) {
    const names = state.approvalState.pendingWith.map((p) => p.name).join(", ");
    return (
      <>
        <span
          className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
          title={t("approvalFlow.pendingWith", { names })}
        >
          <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("approvalFlow.pendingWith", { names })}</span>
        </span>
        {withdrawButton}
        {retryButton}
      </>
    );
  }

  // No live gate and no failed run here (see showSubmit above): the only
  // remaining button is the never-submitted submit, if this surface owns one.
  return (
    <>
      {withdrawButton}
      {retryButton}
      {showSubmit ? (
        <Button variant="outline" disabled={busy} onClick={submitForApproval}>
          {t("approvalFlow.submitRun")}
        </Button>
      ) : null}
    </>
  );
}
