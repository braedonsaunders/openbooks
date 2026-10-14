"use client";

import Link from "next/link";
import { ApiResponseError } from "@/lib/api-error";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { promptDialog } from "@/lib/prompt";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Textarea, UrlDrawer } from "@openbooks/ui";
import { ChevronRight } from "lucide-react";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { ReopenDecisionEvidence } from "../../../../../components/reopen-decision-evidence";
import { BASE, Check, Field, MODULES, drawerHref, post } from "./close-setup-shared";
import type { Props, ReopenRow } from "./close-setup-types";

export function ReopenList(props: Props) {
  const t = useTranslations("close.setup");
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t("periods.reopenRequests")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput paramKey="reopenQ" pageParamKey="reopenPage" />
          <Pagination
            basePath={BASE}
            currentParams={props.currentParams}
            total={props.reopenTotal}
            page={props.reopenPage}
            perPage={props.reopenPerPage}
            pageParamKey="reopenPage"
          />
        </div>
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {props.reopenRequests.map((item) => (
            <Link
              key={item.id}
              href={drawerHref(
                props.currentParams,
                "periods",
                "reopen",
                item.id,
              )}
              className="flex items-center justify-between gap-3 py-3 text-sm hover:text-teal-700 dark:hover:text-teal-300"
            >
              <div>
                <span className="font-medium">{item.period_name}</span>
                <span className="text-slate-500">
                  {" "}
                  · {item.book_name} ·{" "}
                  {t(`modules.${item.modules?.[0] ?? "gl"}`)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    item.status === "approved"
                      ? "success"
                      : item.status === "requested"
                        ? "warning"
                        : "outline"
                  }
                >
                  {t(`reopenStates.${item.status}`)}
                </Badge>
                <ChevronRight size={16} />
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReopenDrawer({ row, props }: { row: ReopenRow; props: Props }) {
  const t = useTranslations("close.setup");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "periods", "reopen", null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<
    { kind: string; count: number; examples: string[] }[] | null
  >(null);
  // Decision posture for the viewer: the same scan the approval path
  // enforces, plus whether the engine will demand an independent approver
  // or accept a self-approval attestation. Approve mirrors that decision
  // instead of rendering enabled and refusing on click.
  const [decisionPreview, setDecisionPreview] = useState<{
    ownRequest: boolean;
    independenceRequired: boolean;
    selfApprovalAllowed: boolean;
    eligibleApprovers: string[];
    conflictAcknowledgementAllowed: boolean;
  } | null>(null);
  const [selfAttestation, setSelfAttestation] = useState("");
  const [selfAttested, setSelfAttested] = useState(false);
  useEffect(() => {
    if (row.status !== "requested") return;
    let live = true;
    post({ action: "reopen-conflicts", requestId: row.id }, t("errors.actionFailed"))
      .then((data) => {
        if (!live) return;
        const preview = data as {
          conflicts?: { kind: string; count: number; examples: string[] }[];
          ownRequest?: boolean;
          independenceRequired?: boolean;
          selfApprovalAllowed?: boolean;
          eligibleApprovers?: unknown;
          conflictAcknowledgementAllowed?: boolean;
        };
        setConflicts(Array.isArray(preview.conflicts) ? preview.conflicts : []);
        setDecisionPreview({
          ownRequest: preview.ownRequest === true,
          independenceRequired: preview.independenceRequired === true,
          selfApprovalAllowed: preview.selfApprovalAllowed === true,
          eligibleApprovers: Array.isArray(preview.eligibleApprovers)
            ? preview.eligibleApprovers.filter((name): name is string => typeof name === "string")
            : [],
          conflictAcknowledgementAllowed: preview.conflictAcknowledgementAllowed === true,
        });
      })
      .catch(() => {
        if (!live) return;
        setConflicts([]);
        setDecisionPreview(null);
      });
    return () => {
      live = false;
    };
  }, [row.id, row.status, t]);
  const conflictTotal = (conflicts ?? []).reduce((sum, item) => sum + item.count, 0);
  const conflictExamples = (conflicts ?? [])
    .flatMap((item) => item.examples)
    .slice(0, 3)
    .join(", ");
  // Approve will refuse when the viewer is conflicted and independence
  // applies, or when the viewer requested it and independence applies: in
  // both cases the button stays disabled with the reason. A sole eligible
  // approver deciding their own request attests instead.
  // The preview decides when it loaded; until then (or if it failed) the
  // request row itself says whose request it is, so a requester always sees
  // Withdraw on their own pending request.
  const ownRequest = props.viewerId != null
    ? row.requested_by === props.viewerId
    : (decisionPreview?.ownRequest ?? false);
  // No unconflicted approver exists: a conflicted approver records a
  // conflict acknowledgement instead of leaving the request stuck.
  const conflictAcknowledgement = !ownRequest && (decisionPreview?.conflictAcknowledgementAllowed ?? false);
  const approveBlocked =
    (conflictTotal > 0 || ownRequest) &&
    (decisionPreview?.independenceRequired ?? false) &&
    !conflictAcknowledgement;
  const selfApproval = ownRequest && (decisionPreview?.selfApprovalAllowed ?? false);
  const attests = selfApproval || conflictAcknowledgement;
  const approverNames = decisionPreview?.eligibleApprovers ?? [];
  const ownRequestNote = approverNames.length > 0
    ? t("periods.reopenOwnRequestNamedNote", { approvers: approverNames.join(", ") })
    : t("periods.reopenOwnRequestNote");
  const selfAttestationReady = selfAttested && selfAttestation.trim().length >= 10;
  // Ending acts on the active window. Extending or widening submits a new
  // request whose approval replaces the window; both retain their reasons.
  const [endReason, setEndReason] = useState("");
  const [extendReason, setExtendReason] = useState("");
  // Widening and extending are separate choices: no hours are added unless
  // the operator enters them.
  const [extendHours, setExtendHours] = useState("");
  const [extendModules, setExtendModules] = useState<string[]>([]);
  const includedModules = new Set(row.modules.map((module) => String(module)));
  async function decide(approve: boolean, decisionReason?: string) {
    setBusy(true);
    setActionError(null);
    try {
      await post(
        {
          action: "decide-reopen",
          requestId: row.id,
          approve,
          ...(approve && attests ? { attestation: selfAttestation.trim() } : {}),
          ...(decisionReason !== undefined ? { decisionReason } : {}),
        },
        t("errors.actionFailed"),
      );
      toast.success(
        t(approve ? "messages.reopenApproved" : "messages.reopenRejected"),
      );
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiResponseError
          ? error.message
          : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  // A rejection is an approver's recorded decision and needs a reason;
  // cancelling the prompt posts nothing.
  async function rejectWithReason() {
    const reason = await promptDialog({
      title: t("periods.reopenRejectTitle"),
      message: t("periods.reopenReasonHint"),
      label: t("fields.reason"),
      multiline: true,
      confirmLabel: t("actions.reject"),
    });
    if (reason === null) return;
    await decide(false, reason);
  }
  // The requester withdraws their own pending request with a reason. It is
  // recorded as withdrawn, never as rejected.
  async function withdraw() {
    const reason = await promptDialog({
      title: t("periods.reopenWithdrawTitle"),
      message: t("periods.reopenReasonHint"),
      label: t("fields.reason"),
      multiline: true,
      confirmLabel: t("periods.reopenWithdraw"),
    });
    if (reason === null) return;
    setBusy(true);
    setActionError(null);
    try {
      await post(
        { action: "withdraw-reopen", requestId: row.id, reason },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.reopenWithdrawn"));
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiResponseError
          ? error.message
          : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  async function endReopen() {
    if (endReason.trim().length < 10) {
      const message = t("periods.endReopenReasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await post(
        { action: "reclose-reopen", requestId: row.id, reason: endReason.trim() },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.reopenEnded"));
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiResponseError
          ? error.message
          : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  async function extendReopen() {
    if (extendReason.trim().length < 10) {
      const message = t("periods.extendReopenReasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    const hours = Number(extendHours);
    setBusy(true);
    setActionError(null);
    try {
      const result = await post(
        {
          action: "extend-reopen",
          requestId: row.id,
          reason: extendReason.trim(),
          ...(Number.isInteger(hours) && hours >= 1 ? { additionalHours: hours } : {}),
          ...(extendModules.length > 0 ? { addModules: extendModules } : {}),
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.reopenRequested"));
      router.push(typeof result.requestId === "string"
        ? drawerHref(props.currentParams, "periods", "reopen", result.requestId)
        : closeHref);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiResponseError
          ? error.message
          : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="md"
      title={t("periods.reopenTitle")}
      description={`${row.period_name} · ${row.book_name}`}
      footer={
        row.status === "requested" && props.canReopen ? (
          <div className="flex w-full justify-end gap-2">
            {ownRequest ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void withdraw()}
              >
                {t("periods.reopenWithdraw")}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void rejectWithReason()}
              >
                {t("actions.reject")}
              </Button>
            )}
            <Button
              disabled={busy || approveBlocked || (attests && !selfAttestationReady)}
              title={
                approveBlocked
                  ? ownRequest
                    ? ownRequestNote
                    : t("periods.reopenConflictNotice", { count: conflictTotal, examples: conflictExamples })
                  : attests && !selfAttestationReady
                    ? t("periods.reopenSelfAttestationNeeded")
                    : undefined
              }
              onClick={() => decide(true)}
            >
              {t("actions.approve")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4 p-1">
        {actionError ? (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        ) : null}
        {conflictTotal > 0 ? (
          <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t("periods.reopenConflictNotice", {
              count: conflictTotal,
              examples: conflictExamples,
            })}
          </p>
        ) : null}
        {ownRequest && decisionPreview && !selfApproval ? (
          <p role="note" className="rounded-md border border-slate-300 bg-slate-50 p-2.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {ownRequestNote}
          </p>
        ) : null}
        {attests ? (
          <div className="space-y-2 rounded-md border border-teal-300 bg-teal-50/50 p-3 dark:border-teal-800 dark:bg-teal-950/20">
            <p role="note" className="text-sm text-slate-700 dark:text-slate-200">
              {selfApproval
                ? t("periods.reopenSelfApprovalNotice")
                : t("periods.reopenConflictAcknowledgementNotice", { count: conflictTotal, examples: conflictExamples })}
            </p>
            <Field label={t("periods.reopenSelfAttestationLabel")}>
              <Textarea
                value={selfAttestation}
                onChange={(e) => setSelfAttestation(e.target.value)}
              />
            </Field>
            <Check checked={selfAttested} onChange={setSelfAttested}>
              {t("periods.reopenSelfAttestationConfirm")}
            </Check>
            {!selfAttestationReady ? (
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {t("periods.reopenSelfAttestationNeeded")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div>
          <Label>{t("fields.reason")}</Label>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
            {row.reason}
          </p>
        </div>
        <div>
          <Label>
            {t("periods.requestedBy", { name: row.requester_name })}
          </Label>
        </div>
        <ReopenDecisionEvidence
          source={{
            status: row.status,
            requestedById: row.requested_by,
            approvedById: row.approved_by,
            approvedByName: row.approver_name,
            decisionAction: row.decision_action,
            attestation: row.decision_attestation,
            endActorName: row.end_actor_name,
            endReason: row.end_reason,
          }}
        />
        <Badge
          variant={
            row.status === "approved"
              ? "success"
              : row.status === "requested"
                ? "warning"
                : "outline"
          }
        >
          {t(`reopenStates.${row.status}`)}
        </Badge>
        {row.status === "approved" && typeof row.expires_at === "string" ? (
          <p className="mt-1 text-sm text-slate-500">
            {t("periods.reopenActiveUntil", { date: String(row.expires_at).slice(0, 16).replace("T", " ") })}
          </p>
        ) : null}
        {row.status === "requested" && row.impact_snapshot?.amendment ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t("periods.reopenRequestedUntil", { date: row.impact_snapshot.amendment.expiresAt.slice(0, 16).replace("T", " ") })}
          </p>
        ) : null}
        {row.status === "approved" && props.canReopen ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div>
              <h4 className="font-medium">{t("periods.endReopenTitle")}</h4>
              <p className="text-sm text-slate-500">
                {t("periods.endReopenHint")}
              </p>
            </div>
            <Field label={t("fields.reason")}>
              <Textarea
                value={endReason}
                onChange={(e) => setEndReason(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={busy || endReason.trim().length < 10}
                onClick={endReopen}
              >
                {t("actions.endReopen")}
              </Button>
            </div>
          </div>
        ) : null}
        {row.status === "approved" && props.canReopen ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div>
              <h4 className="font-medium">{t("periods.extendReopenTitle")}</h4>
              <p className="text-sm text-slate-500">
                {t("periods.extendReopenHint")}
              </p>
            </div>
            <Field label={t("periods.extendHoursLabel")}>
              <Input
                aria-label={t("periods.extendHoursLabel")}
                type="number"
                min={0}
                max={168}
                value={extendHours}
                onChange={(e) => setExtendHours(e.target.value)}
              />
            </Field>
            <div className="space-y-1">
              <Label>{t("periods.extendModulesLabel")}</Label>
              {MODULES.filter((module) => !includedModules.has(module)).map((module) => (
                <label key={module} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extendModules.includes(module)}
                    onChange={(e) =>
                      setExtendModules((prev) =>
                        e.target.checked
                          ? [...prev, module]
                          : prev.filter((item) => item !== module),
                      )
                    }
                  />
                  {t(`modules.${module}`)}
                </label>
              ))}
            </div>
            <Field label={t("fields.reason")}>
              <Textarea
                value={extendReason}
                maxLength={500}
                onChange={(e) => setExtendReason(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={busy || extendReason.trim().length < 10 ||
                  (!extendModules.length && Number(extendHours) === 0) ||
                  !Number.isInteger(Number(extendHours)) || Number(extendHours) < 0 || Number(extendHours) > 168}
                onClick={extendReopen}
              >
                {t("actions.extendReopen")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
