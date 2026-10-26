"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, Drawer, Input, Select, Textarea, cn } from "@openbooks/ui";
import { promptDialog } from "../../lib/prompt";
import { SchedulingAlert } from "./SchedulingAlert";
import {
  SchedulingRequestError,
  actOnOwnShiftRequest,
  ownShiftRequests,
  submitOwnShiftRequest,
  swapCandidates,
  type ShiftRequest,
  type SwapCandidate,
} from "./api";
import type { BoardEntry } from "./model";

type Refusal = { message: string; remedy: string | null };
const refusal = (error: unknown, fallback: string): Refusal => ({
  message: error instanceof Error ? error.message : fallback,
  remedy: error instanceof SchedulingRequestError ? error.remedy : null,
});

function useSpan() {
  const locale = useLocale();
  return useCallback(
    (starts: string, ends: string, zone: string) => {
      const format = new Intl.DateTimeFormat(locale, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      });
      const clock = new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      });
      return `${format.format(new Date(starts))} – ${clock.format(new Date(ends))}`;
    },
    [locale],
  );
}

/** The person's own shift requests and the swaps colleagues offered them; loads once and on every change. */
export function useOwnShiftRequests(enabled: boolean) {
  const t = useTranslations("scheduling");
  const [requests, setRequests] = useState<ShiftRequest[] | null>(null);
  const [problem, setProblem] = useState<Refusal | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setRequests((await ownShiftRequests(t("errors.load"))).requests);
      setProblem(null);
    } catch (error) {
      setProblem(refusal(error, t("errors.load")));
    }
  }, [enabled, t]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    ownShiftRequests(t("errors.load")).then(
      (body) => {
        if (!cancelled) {
          setRequests(body.requests);
          setProblem(null);
        }
      },
      (error: unknown) => !cancelled && setProblem(refusal(error, t("errors.load"))),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, t]);
  return { requests, problem, reload };
}

/** Ask to release, change or swap one published shift. With no approval Flow configured the request applies at once. */
export function ShiftRequestDrawer({
  entry,
  onClose,
  onSubmitted,
}: {
  entry: BoardEntry;
  onClose: () => void;
  onSubmitted: (request: ShiftRequest) => void;
}) {
  const t = useTranslations("scheduling");
  const span = useSpan();
  const locale = useLocale();
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${entry.startsOn}T00:00:00Z`));
  const [kind, setKind] = useState<"release" | "change" | "swap">("change");
  const [starts, setStarts] = useState(entry.startClock);
  const [ends, setEnds] = useState(entry.endClock);
  const [breakMinutes, setBreakMinutes] = useState(String(entry.breakMinutes));
  const [reason, setReason] = useState("");
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null);
  const [counterpart, setCounterpart] = useState("");
  const [problem, setProblem] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (kind !== "swap" || candidates) return;
    swapCandidates(entry.id, t("errors.load")).then(
      (body) => setCandidates(body.candidates),
      (error: unknown) => setProblem(refusal(error, t("errors.load"))),
    );
  }, [candidates, entry.id, kind, t]);

  const chosen = candidates?.find((candidate) => candidate.entryId === counterpart);
  const ready =
    reason.trim() && (kind !== "change" || (starts && ends)) && (kind !== "swap" || chosen);

  async function submit() {
    setSaving(true);
    setProblem(null);
    try {
      const result = await submitOwnShiftRequest(
        {
          id: key,
          entryId: entry.id,
          expectedRevision: entry.revision,
          kind,
          reason: reason.trim(),
          change:
            kind === "change" ? { starts, ends, breakMinutes: Number(breakMinutes) || 0 } : null,
          counterpartEntryId: kind === "swap" ? chosen!.entryId : null,
          counterpartRevision: kind === "swap" ? chosen!.revision : null,
        },
        t("errors.save"),
      );
      onSubmitted(result.request);
    } catch (error) {
      setProblem(refusal(error, t("errors.save")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t("mine.request.title")}
      description={`${dateLabel} · ${entry.startClock}–${entry.endClock}`}
      headerActions={
        <Button size="sm" onClick={() => void submit()} disabled={saving || !ready}>
          {t("mine.request.submit")}
        </Button>
      }
    >
      <div className="space-y-5">
        <p className="text-xs leading-relaxed text-slate-500">{t("mine.request.explain")}</p>
        {problem ? <SchedulingAlert message={problem.message} remedy={problem.remedy} /> : null}
        <div
          className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800"
          role="radiogroup"
          aria-label={t("mine.request.kind")}
        >
          {(["change", "swap", "release"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium",
                kind === value
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 dark:text-slate-300",
              )}
            >
              {t(`roster.requests.kinds.${value}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">{t(`mine.request.${kind}Explain`)}</p>
        {kind === "change" ? (
          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">{t("drawer.starts")}</span>
              <Input
                type="time"
                value={starts}
                onChange={(event) => setStarts(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">{t("drawer.ends")}</span>
              <Input type="time" value={ends} onChange={(event) => setEnds(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">{t("drawer.break")}</span>
              <Input
                type="number"
                min={0}
                max={240}
                step={5}
                value={breakMinutes}
                onChange={(event) => setBreakMinutes(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {kind === "swap" ? (
          candidates && !candidates.length ? (
            <p className="text-xs text-slate-500">{t("mine.request.noCandidates")}</p>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t("mine.request.swapWith")}
              </span>
              <Select
                value={counterpart}
                disabled={!candidates}
                onChange={(event) => setCounterpart(event.target.value)}
              >
                <option value="">{t("mine.request.pickShift")}</option>
                {candidates?.map((candidate) => (
                  <option key={candidate.entryId} value={candidate.entryId}>
                    {candidate.workerName} ·{" "}
                    {span(candidate.startsAt, candidate.endsAt, candidate.timeZone)}
                    {candidate.targetLabel ? ` · ${candidate.targetLabel}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          )
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {t("roster.reason")}
          </span>
          <Textarea
            value={reason}
            rows={3}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
    </Drawer>
  );
}

/** The person's requests and the swaps offered to them, with withdraw, accept and decline. */
export function OwnRequestsDrawer({
  personPartyId,
  requests,
  problem,
  onChanged,
  onClose,
}: {
  personPartyId: string;
  requests: readonly ShiftRequest[] | null;
  problem: Refusal | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations("scheduling");
  const span = useSpan();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const isOffer = useCallback(
    (request: ShiftRequest) =>
      request.counterpartPartyId === personPartyId && request.status === "awaiting_counterpart",
    [personPartyId],
  );
  // Swaps waiting for this person's answer come first.
  const sorted = useMemo(
    () => [...(requests ?? [])].sort((a, b) => Number(isOffer(b)) - Number(isOffer(a))),
    [requests, isOffer],
  );

  async function act(request: ShiftRequest, action: "withdraw" | "accept" | "decline") {
    let reason: string | undefined;
    if (action !== "withdraw") {
      const answered = await promptDialog({
        title: t(`mine.requests.${action}Title`),
        label: t("roster.reason"),
        multiline: true,
      });
      if (!answered) return;
      reason = answered;
    }
    setBusy(request.id);
    setFailure(null);
    try {
      await actOnOwnShiftRequest(
        request.id,
        { action, expectedRevision: request.revision, reason },
        t("errors.save"),
      );
      await onChanged();
    } catch (error) {
      setFailure(refusal(error, t("errors.save")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Drawer open onClose={onClose} size="md" title={t("mine.requests.title")}>
      <div className="space-y-3">
        {problem ? <SchedulingAlert message={problem.message} remedy={problem.remedy} /> : null}
        {failure ? <SchedulingAlert message={failure.message} remedy={failure.remedy} /> : null}
        {!requests ? (
          <div className="h-32 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />
        ) : !sorted.length ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
            {t("mine.requests.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((request) => {
              const offer = isOffer(request);
              const mine = request.workerPartyId === personPartyId;
              return (
                <li
                  key={request.id}
                  className={cn(
                    "space-y-1 rounded-xl border p-3 text-xs",
                    offer
                      ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"
                      : "border-slate-200 dark:border-slate-800",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {offer
                        ? t("mine.requests.offer", { name: request.workerName })
                        : t(`roster.requests.kinds.${request.kind}`)}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {t(`roster.requests.status.${request.status}`)}
                    </span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">
                    {request.boardName} · {span(request.startsAt, request.endsAt, request.timeZone)}
                  </p>
                  {request.kind === "change" &&
                  request.proposedStartsAt &&
                  request.proposedEndsAt ? (
                    <p className="text-slate-600 dark:text-slate-300">
                      {t("roster.requests.proposed", {
                        span: span(
                          request.proposedStartsAt,
                          request.proposedEndsAt,
                          request.timeZone,
                        ),
                      })}
                    </p>
                  ) : null}
                  {request.kind === "swap" &&
                  request.counterpartStartsAt &&
                  request.counterpartEndsAt ? (
                    <p className="text-slate-600 dark:text-slate-300">
                      {t("roster.requests.swapWith", {
                        name: request.counterpartName ?? "",
                        span: span(
                          request.counterpartStartsAt,
                          request.counterpartEndsAt,
                          request.timeZone,
                        ),
                      })}
                    </p>
                  ) : null}
                  <p className="text-slate-500">{request.reason}</p>
                  {request.releasedWithoutApproval ? (
                    <p className="text-slate-400">{t("roster.requests.noApproval")}</p>
                  ) : null}
                  {request.decisionReason ? (
                    <p className="text-slate-400">
                      {request.decidedByName ? `${request.decidedByName} · ` : ""}
                      {request.decisionReason}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-1">
                    {offer ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={busy === request.id}
                          onClick={() => void act(request, "decline")}
                        >
                          {t("mine.requests.decline")}
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={busy === request.id}
                          onClick={() => void act(request, "accept")}
                        >
                          {t("mine.requests.accept")}
                        </Button>
                      </>
                    ) : mine &&
                      (request.status === "pending" ||
                        request.status === "awaiting_counterpart") ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy === request.id}
                        onClick={() => void act(request, "withdraw")}
                      >
                        {t("mine.requests.withdraw")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
