"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, ExternalLink, FileUp, RefreshCw, Repeat2 } from "lucide-react";
import { Button, Drawer, Input, Select, cn } from "@openbooks/ui";
import { boardHasCapability } from "@openbooks/engine/schedule-boards/board-types";
import type { ScheduleBoard } from "@openbooks/engine/schedule-boards/boards";
import { APPROVALS_HOME_HREF } from "@openbooks/engine/navigation/approvals-home";
import { DrawerTabStrip } from "../drawer-tab-strip";
import { DateField } from "../date-field";
import { promptDialog } from "../../lib/prompt";
import { confirmDialog } from "../../lib/confirm";
import { SchedulingAlert } from "./SchedulingAlert";
import {
  SchedulingRequestError,
  admitCheckIns,
  assignPattern,
  attendanceDevices,
  boardAssignments,
  boardShiftRequests,
  closeAssignment,
  generateAssignment,
  processAttendance,
  recordPatternException,
  revokePatternException,
  type AttendanceDevice,
  type AttendanceOutcome,
  type GenerationSummary,
  type PatternAssignment,
  type SchedulePattern,
  type ShiftRequest,
} from "./api";
import { parseCheckInCsv, type CheckInCsvProblem, type ParsedCheckIn } from "./check-in-csv";
import type { BoardWindow } from "./model";
import type { BoardController } from "./use-board";

export type RosterTab = "recurring" | "requests" | "attendance";

export interface RosterAccess {
  /** Device attendance is switched on and the actor can read it. */
  readonly attendance: boolean;
  /** The actor can import device check-ins. */
  readonly manageAttendance: boolean;
}

/** The roster tabs a board's type and the organization's features offer. */
export function rosterTabs(
  board: Pick<ScheduleBoard, "boardType">,
  access: RosterAccess,
): RosterTab[] {
  return [
    ...(boardHasCapability(board, "patterns") ? ["recurring" as const] : []),
    ...(boardHasCapability(board, "shift_requests") ? ["requests" as const] : []),
    ...(boardHasCapability(board, "attendance") && access.attendance
      ? ["attendance" as const]
      : []),
  ];
}

function refusal(error: unknown, fallback: string): { message: string; remedy: string | null } {
  return {
    message: error instanceof Error ? error.message : fallback,
    remedy: error instanceof SchedulingRequestError ? error.remedy : null,
  };
}

/**
 * Roster tools for a board whose type declares them: recurring shift
 * assignments, the shift requests employees filed, and device attendance.
 * One tool at a time; every change goes through the board's native commands.
 */
export function RosterDrawer({
  board,
  window: boardWindow,
  controller,
  range,
  today,
  access,
  initialTab,
  onClose,
}: {
  board: ScheduleBoard;
  today: string;
  window: BoardWindow;
  controller: BoardController;
  range: { from: string; through: string };
  access: RosterAccess;
  initialTab: RosterTab;
  onClose: () => void;
}) {
  const t = useTranslations("scheduling");
  const tabs = rosterTabs(board, access);
  const [tab, setTab] = useState<RosterTab>(
    tabs.includes(initialTab) ? initialTab : (tabs[0] ?? "recurring"),
  );
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={t("roster.title")}
      description={board.name}
      subtabs={
        tabs.length > 1 ? (
          <DrawerTabStrip
            tabs={tabs.map((key) => ({ key, label: t(`roster.tabs.${key}`) }))}
            activeKey={tab}
            onSelect={setTab}
            ariaLabel={t("roster.title")}
          />
        ) : undefined
      }
    >
      {tab === "recurring" ? (
        <RecurringPanel board={board} window={boardWindow} controller={controller} today={today} />
      ) : tab === "requests" ? (
        <RequestsPanel boardId={board.id} />
      ) : (
        <AttendancePanel board={board} controller={controller} range={range} access={access} />
      )}
    </Drawer>
  );
}

function GenerationNote({ summary }: { summary: GenerationSummary }) {
  const t = useTranslations("scheduling");
  return (
    <span>
      {t("roster.recurring.generated", {
        created: summary.created,
        revised: summary.revised,
        removed: summary.removed,
        kept: summary.kept,
        through: summary.through,
      })}
    </span>
  );
}

function RecurringPanel({
  board,
  window: boardWindow,
  controller,
  today,
}: {
  board: ScheduleBoard;
  window: BoardWindow;
  controller: BoardController;
  today: string;
}) {
  const t = useTranslations("scheduling");
  const locale = useLocale();
  const [assignments, setAssignments] = useState<PatternAssignment[] | null>(null);
  const [patterns, setPatterns] = useState<SchedulePattern[]>([]);
  const [problem, setProblem] = useState<{ message: string; remedy: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    workerPartyId: "",
    patternId: "",
    effectiveFrom: boardWindow.from,
    effectiveTo: "",
    reason: "",
  });
  const [choices, setChoices] = useState<Record<string, { starts: string; ends: string }>>({});
  const canManage = boardWindow.canManage;

  const load = useCallback(
    () =>
      boardAssignments(board.id, t("errors.load")).then(
        (body) => {
          setAssignments(body.assignments);
          setPatterns(body.patterns);
          setProblem(null);
        },
        (error: unknown) => setProblem(refusal(error, t("errors.load"))),
      ),
    [board.id, t],
  );
  useEffect(() => {
    let cancelled = false;
    boardAssignments(board.id, t("errors.load")).then(
      (body) => {
        if (cancelled) return;
        setAssignments(body.assignments);
        setPatterns(body.patterns);
        setProblem(null);
      },
      (error: unknown) => !cancelled && setProblem(refusal(error, t("errors.load"))),
    );
    return () => {
      cancelled = true;
    };
  }, [board.id, t]);

  async function act(
    key: string,
    work: () => Promise<{ generation?: GenerationSummary } | GenerationSummary | void>,
  ) {
    setBusy(key);
    try {
      const result = await work();
      const summary =
        result && "generation" in result
          ? result.generation
          : result && "created" in result
            ? result
            : null;
      if (summary)
        controller.notify(
          "success",
          t("roster.recurring.generated", {
            created: summary.created,
            revised: summary.revised,
            removed: summary.removed,
            kept: summary.kept,
            through: summary.through,
          }),
        );
      await Promise.all([load(), controller.reload()]);
    } catch (error) {
      const refused = refusal(error, t("errors.save"));
      controller.notify("error", refused.message, refused.remedy);
    } finally {
      setBusy(null);
    }
  }

  const reasonFor = (title: string) =>
    promptDialog({ title, label: t("roster.reason"), multiline: true });
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );
  const day = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const instant = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: board.timeZone,
    }).format(new Date(value));

  async function create() {
    const reason = draft.reason.trim();
    await act("create", () =>
      assignPattern(
        board.id,
        {
          id: crypto.randomUUID(),
          patternId: draft.patternId,
          workerPartyId: draft.workerPartyId,
          effectiveFrom: draft.effectiveFrom,
          effectiveTo: draft.effectiveTo || null,
          reason,
        },
        t("errors.save"),
      ),
    );
    setAdding(false);
    setDraft((current) => ({ ...current, workerPartyId: "", reason: "" }));
  }

  async function end(assignment: PatternAssignment) {
    const effectiveTo = await promptDialog({
      title: t("roster.recurring.endTitle", { name: assignment.workerName }),
      message: t("roster.recurring.endExplain"),
      kind: "date",
      businessToday: today,
    });
    if (!effectiveTo) return;
    const reason = await reasonFor(t("roster.recurring.endTitle", { name: assignment.workerName }));
    if (reason)
      await act(assignment.id, () =>
        closeAssignment(
          assignment.id,
          { action: "end", expectedRevision: assignment.revision, effectiveTo, reason },
          t("errors.save"),
        ),
      );
  }

  async function cancel(assignment: PatternAssignment) {
    if (
      !(await confirmDialog({
        title: t("roster.recurring.cancelTitle", { name: assignment.workerName }),
        message: t("roster.recurring.cancelExplain"),
        tone: "danger",
      }))
    )
      return;
    const reason = await reasonFor(
      t("roster.recurring.cancelTitle", { name: assignment.workerName }),
    );
    if (reason)
      await act(assignment.id, () =>
        closeAssignment(
          assignment.id,
          { action: "cancel", expectedRevision: assignment.revision, reason },
          t("errors.save"),
        ),
      );
  }

  async function omit(assignment: PatternAssignment) {
    const pattern = patterns.find((candidate) => candidate.id === assignment.patternId);
    const occursOn = await promptDialog({
      title: t("roster.recurring.omitTitle"),
      message: t("roster.recurring.omitExplain"),
      kind: "date",
      businessToday: today,
    });
    if (!occursOn) return;
    const slots = pattern?.slots ?? [];
    const slot =
      slots.length > 1
        ? await promptDialog({
            title: t("roster.recurring.omitTitle"),
            label: t("roster.recurring.slot"),
            options: slots.map((candidate, index) => ({
              value: String(index),
              label: t("roster.recurring.slotLabel", {
                day: candidate.position + 1,
                starts: candidate.starts,
                ends: candidate.ends,
              }),
            })),
          })
        : "0";
    if (slot === null) return;
    const reason = await reasonFor(t("roster.recurring.omitTitle"));
    if (reason)
      await act(assignment.id, () =>
        recordPatternException(
          assignment.id,
          { kind: "omit", occursOn, slotIndex: Number(slot), reason },
          t("errors.save"),
        ),
      );
  }

  async function select(assignment: PatternAssignment, occursOn: string, slotIndex: number) {
    const key = `${assignment.id}|${occursOn}|${slotIndex}`;
    const chosen = choices[key];
    if (!chosen?.starts || !chosen.ends) return;
    const reason = await reasonFor(t("roster.recurring.chooseTitle"));
    if (reason)
      await act(key, () =>
        recordPatternException(
          assignment.id,
          {
            kind: "select_instant",
            occursOn,
            slotIndex,
            startsAt: chosen.starts,
            endsAt: chosen.ends,
            reason,
          },
          t("errors.save"),
        ),
      );
  }

  async function revoke(assignment: PatternAssignment, exceptionId: string) {
    const reason = await reasonFor(t("roster.recurring.revokeTitle"));
    if (reason)
      await act(exceptionId, () => revokePatternException(exceptionId, reason, t("errors.save")));
  }

  if (problem && !assignments)
    return (
      <SchedulingAlert message={problem.message} remedy={problem.remedy}>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          {t("toolbar.retry")}
        </Button>
      </SchedulingAlert>
    );
  if (!assignments)
    return <div className="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-slate-500">{t("roster.recurring.explain")}</p>
        {canManage && !adding ? (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => setAdding(true)}
            disabled={!patterns.length}
          >
            <Repeat2 className="mr-1.5 h-4 w-4" />
            {t("roster.recurring.assign")}
          </Button>
        ) : null}
      </div>
      {!patterns.length ? (
        <SchedulingAlert
          tone="info"
          message={t("roster.recurring.noPatterns")}
          remedy={t("roster.recurring.noPatternsRemedy")}
        />
      ) : null}
      {adding ? (
        <section className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t("roster.recurring.person")}
              </span>
              <Select
                value={draft.workerPartyId}
                onChange={(event) => setDraft({ ...draft, workerPartyId: event.target.value })}
              >
                <option value="">{t("roster.recurring.pickPerson")}</option>
                {boardWindow.rows.map((row) => (
                  <option key={row.subjectId} value={row.subjectId}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t("roster.recurring.pattern")}
              </span>
              <Select
                value={draft.patternId}
                onChange={(event) => setDraft({ ...draft, patternId: event.target.value })}
              >
                <option value="">{t("roster.recurring.pickPattern")}</option>
                {patterns.map((pattern) => (
                  <option key={pattern.id} value={pattern.id}>
                    {pattern.code} · {pattern.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t("roster.recurring.from")}
              </span>
              <DateField
                value={draft.effectiveFrom}
                onChange={(value) => setDraft({ ...draft, effectiveFrom: value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t("roster.recurring.to")}
              </span>
              <DateField
                value={draft.effectiveTo}
                onChange={(value) => setDraft({ ...draft, effectiveTo: value })}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {t("roster.reason")}
            </span>
            <Input
              value={draft.reason}
              maxLength={2000}
              onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {t("newBoard.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void create()}
              disabled={
                busy === "create" ||
                !draft.workerPartyId ||
                !draft.patternId ||
                !draft.effectiveFrom ||
                !draft.reason.trim()
              }
            >
              {t("roster.recurring.assign")}
            </Button>
          </div>
        </section>
      ) : null}
      {!assignments.length ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
          {t("roster.recurring.empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {assignments.map((assignment) => {
            const problems = assignment.lastGeneration?.problems ?? [];
            const failures = assignment.lastGeneration?.failures ?? [];
            const active = assignment.status === "active";
            return (
              <li
                key={assignment.id}
                className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {assignment.workerName}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {assignment.patternCode} · {assignment.patternName} ·{" "}
                      {assignment.effectiveTo
                        ? t("roster.recurring.window", {
                            from: day(assignment.effectiveFrom),
                            to: day(assignment.effectiveTo),
                          })
                        : t("roster.recurring.openWindow", { from: day(assignment.effectiveFrom) })}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t(`roster.recurring.status.${assignment.status}`)}
                      {assignment.generatedThrough
                        ? ` · ${t("roster.recurring.generatedThrough", { date: day(assignment.generatedThrough) })}`
                        : ""}
                    </p>
                  </div>
                  {canManage && active ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy === assignment.id}
                        onClick={() =>
                          void act(assignment.id, () =>
                            generateAssignment(assignment.id, t("errors.save")),
                          )
                        }
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" />
                        {t("roster.recurring.generate")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy === assignment.id}
                        onClick={() => void omit(assignment)}
                      >
                        {t("roster.recurring.omit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy === assignment.id}
                        onClick={() => void end(assignment)}
                      >
                        {t("roster.recurring.end")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-red-600"
                        disabled={busy === assignment.id}
                        onClick={() => void cancel(assignment)}
                      >
                        {t("roster.recurring.cancel")}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {assignment.lastGeneration ? (
                  <p className="text-xs text-slate-500">
                    <GenerationNote summary={assignment.lastGeneration} />
                  </p>
                ) : null}
                {failures.map((failure) => (
                  <SchedulingAlert
                    key={`${failure.occursOn}|${failure.slotIndex}`}
                    message={`${day(failure.occursOn)} · ${failure.message}`}
                    remedy={failure.remedy}
                  />
                ))}
                {problems.map((item) => {
                  const key = `${assignment.id}|${item.occursOn}|${item.slotIndex}`;
                  const chosen = choices[key] ?? { starts: "", ends: "" };
                  const repeated = item.startChoices.length > 1 || item.endChoices.length > 1;
                  return (
                    <SchedulingAlert
                      key={key}
                      tone="warning"
                      message={`${day(item.occursOn)} · ${item.message}`}
                      remedy={item.remedy}
                    >
                      {canManage && active && repeated ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {[
                            ["starts", item.startChoices],
                            ["ends", item.endChoices],
                          ].map(([side, options]) => (
                            <Select
                              key={side as string}
                              className="h-7 w-44 text-xs"
                              aria-label={t(`roster.recurring.${side as "starts" | "ends"}`)}
                              value={chosen[side as "starts" | "ends"]}
                              onChange={(event) =>
                                setChoices({
                                  ...choices,
                                  [key]: { ...chosen, [side as string]: event.target.value },
                                })
                              }
                            >
                              <option value="">
                                {t(`roster.recurring.${side as "starts" | "ends"}`)}
                              </option>
                              {(options as typeof item.startChoices).map((choice) => (
                                <option key={choice.instant} value={choice.instant}>
                                  {instant(choice.instant)} ({choice.offset})
                                </option>
                              ))}
                            </Select>
                          ))}
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={!chosen.starts || !chosen.ends || busy === key}
                            onClick={() => void select(assignment, item.occursOn, item.slotIndex)}
                          >
                            {t("roster.recurring.useTimes")}
                          </Button>
                        </div>
                      ) : null}
                    </SchedulingAlert>
                  );
                })}
                {assignment.exceptions.length ? (
                  <ul className="space-y-1 border-t border-slate-100 pt-2 text-xs dark:border-slate-900">
                    {assignment.exceptions.map((exception) => (
                      <li key={exception.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-slate-600 dark:text-slate-300">
                          {exception.kind === "omit"
                            ? t("roster.recurring.omitted", { date: day(exception.occursOn) })
                            : t("roster.recurring.selected", {
                                date: day(exception.occursOn),
                                starts: instant(exception.startsAt!),
                                ends: instant(exception.endsAt!),
                              })}
                          <span className="text-slate-400"> · {exception.reason}</span>
                        </span>
                        {canManage && active ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 px-2 text-xs"
                            disabled={busy === exception.id}
                            onClick={() => void revoke(assignment, exception.id)}
                          >
                            {t("roster.recurring.revoke")}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RequestsPanel({ boardId }: { boardId: string }) {
  const t = useTranslations("scheduling");
  const locale = useLocale();
  const [status, setStatus] = useState<"open" | "all">("open");
  const [requests, setRequests] = useState<ShiftRequest[] | null>(null);
  const [problem, setProblem] = useState<{ message: string; remedy: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    boardShiftRequests(boardId, status, t("errors.load")).then(
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
  }, [boardId, status, t]);
  const span = (starts: string, ends: string, zone: string) => {
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
  };
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-slate-500">{t("roster.requests.explain")}</p>
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value as "open" | "all")}
          className="h-8 w-32 shrink-0 text-xs"
          aria-label={t("roster.requests.show")}
        >
          <option value="open">{t("roster.requests.open")}</option>
          <option value="all">{t("roster.requests.all")}</option>
        </Select>
      </div>
      {problem ? <SchedulingAlert message={problem.message} remedy={problem.remedy} /> : null}
      {!requests ? (
        <div className="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />
      ) : !requests.length ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
          {t("roster.requests.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {requests.map((item) => (
            <li
              key={item.id}
              className="space-y-1 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.workerName} · {t(`roster.requests.kinds.${item.kind}`)}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-medium",
                    item.status === "pending" || item.status === "awaiting_counterpart"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                      : item.status === "approved"
                        ? "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300",
                  )}
                >
                  {t(`roster.requests.status.${item.status}`)}
                </span>
              </div>
              <p className="text-slate-600 dark:text-slate-300">
                {span(item.startsAt, item.endsAt, item.timeZone)}
              </p>
              {item.kind === "change" && item.proposedStartsAt && item.proposedEndsAt ? (
                <p className="text-slate-600 dark:text-slate-300">
                  {t("roster.requests.proposed", {
                    span: span(item.proposedStartsAt, item.proposedEndsAt, item.timeZone),
                  })}
                </p>
              ) : null}
              {item.kind === "swap" &&
              item.counterpartName &&
              item.counterpartStartsAt &&
              item.counterpartEndsAt ? (
                <p className="text-slate-600 dark:text-slate-300">
                  {t("roster.requests.swapWith", {
                    name: item.counterpartName,
                    span: span(item.counterpartStartsAt, item.counterpartEndsAt, item.timeZone),
                  })}
                </p>
              ) : null}
              <p className="text-slate-500">{item.reason}</p>
              {item.releasedWithoutApproval ? (
                <p className="text-slate-400">{t("roster.requests.noApproval")}</p>
              ) : null}
              {item.decidedByName ? (
                <p className="text-slate-400">
                  {t("roster.requests.decidedBy", { name: item.decidedByName })}
                  {item.decisionReason ? ` · ${item.decisionReason}` : ""}
                </p>
              ) : null}
              {item.status === "pending" && item.flowGated ? (
                <Link
                  href={APPROVALS_HOME_HREF}
                  className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t("roster.requests.openApprovals")}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function csvProblem(t: ReturnType<typeof useTranslations>, problem: CheckInCsvProblem): string {
  switch (problem.code) {
    case "empty":
      return t("roster.attendance.csv.empty");
    case "missing_column":
      return t("roster.attendance.csv.missingColumn", { column: problem.column });
    case "duplicate":
      return t("roster.attendance.csv.duplicate", { line: problem.line, first: problem.firstLine });
    default:
      return t(`roster.attendance.csv.${problem.code}`, { line: problem.line });
  }
}

function AttendancePanel({
  board,
  controller,
  range,
  access,
}: {
  board: ScheduleBoard;
  controller: BoardController;
  range: { from: string; through: string };
  access: RosterAccess;
}) {
  const t = useTranslations("scheduling");
  const [outcomes, setOutcomes] = useState<AttendanceOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<AttendanceDevice[] | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [file, setFile] = useState<{
    name: string;
    events: ParsedCheckIn[];
    problems: CheckInCsvProblem[];
    batchId: string;
    eventIds: string[];
  } | null>(null);
  const [completeThrough, setCompleteThrough] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<{ message: string; remedy: string | null } | null>(null);

  useEffect(() => {
    if (!access.manageAttendance) return;
    let cancelled = false;
    attendanceDevices(t("errors.load")).then(
      (body) => {
        if (cancelled) return;
        setDevices(body.devices);
        setDeviceId((current) => current || body.devices[0]?.id || "");
      },
      (error: unknown) => !cancelled && setProblem(refusal(error, t("errors.load"))),
    );
    return () => {
      cancelled = true;
    };
  }, [access.manageAttendance, t]);

  async function observe() {
    setBusy(true);
    try {
      setOutcomes(
        (await processAttendance(board.id, range.from, range.through, t("errors.save"))).outcomes,
      );
      await controller.reload();
    } catch (error) {
      const refused = refusal(error, t("errors.save"));
      controller.notify("error", refused.message, refused.remedy);
    } finally {
      setBusy(false);
    }
  }

  async function read(selected: File | undefined) {
    if (!selected) {
      setFile(null);
      return;
    }
    const parsed = parseCheckInCsv(await selected.text());
    // One request key per file read, so retrying the same import replays it instead of admitting it twice.
    setFile({
      name: selected.name,
      ...parsed,
      batchId: crypto.randomUUID(),
      eventIds: parsed.events.map(() => crypto.randomUUID()),
    });
  }

  // The watermark is an instant: the operator enters it in the device's own time zone with its offset.
  const watermark = completeThrough.trim()
    ? (() => {
        const parsed = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(
          completeThrough.trim(),
        )
          ? new Date(completeThrough.trim().replace(" ", "T"))
          : null;
        return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
      })()
    : null;

  async function admit() {
    if (!file || !deviceId || watermark === undefined) return;
    setBusy(true);
    try {
      const result = await admitCheckIns(
        deviceId,
        {
          id: file.batchId,
          completeThrough: watermark,
          reason: reason.trim(),
          sourceEvidence: { source: file.name, rows: file.events.length },
          events: file.events.map((event, index) => ({ ...event, id: file.eventIds[index]! })),
        },
        t("errors.save"),
      );
      controller.notify(
        "success",
        t("roster.attendance.admitted", {
          count: result.batch.eventCount,
          replayed: result.batch.replayedEventIds.length,
        }),
      );
      setOutcomes(result.outcomes);
      setFile(null);
      setReason("");
      await controller.reload();
    } catch (error) {
      const refused = refusal(error, t("errors.save"));
      controller.notify("error", refused.message, refused.remedy);
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const tally = { present: 0, absent: 0, waiting_for_sync: 0, voided: 0, refused: 0 };
    for (const outcome of outcomes ?? [])
      if (outcome.ok) tally[outcome.status]++;
      else tally.refused++;
    return tally;
  }, [outcomes]);
  const device = devices?.find((candidate) => candidate.id === deviceId);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <CalendarClock className="h-3.5 w-3.5" />
          {t("roster.attendance.observeTitle")}
        </h3>
        <p className="text-xs leading-relaxed text-slate-500">
          {t("roster.attendance.observeExplain", { from: range.from, through: range.through })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void observe()} disabled={busy}>
            {t("roster.attendance.observe")}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link
              href={`/reports/attendance-exceptions?board=${encodeURIComponent(board.id)}&from=${range.from}&to=${range.through}`}
            >
              {t("roster.attendance.report")}
              <ExternalLink className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
        {outcomes ? (
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {t("roster.attendance.summary", {
              present: counts.present,
              absent: counts.absent,
              waiting: counts.waiting_for_sync,
              refused: counts.refused,
            })}
          </p>
        ) : null}
        {outcomes
          ?.flatMap((outcome) => (outcome.ok ? [] : [outcome]))
          .slice(0, 5)
          .map((outcome) => (
            <SchedulingAlert
              key={outcome.entryId}
              message={outcome.message}
              remedy={outcome.remedy}
            />
          ))}
      </section>

      {access.manageAttendance ? (
        <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <FileUp className="h-3.5 w-3.5" />
            {t("roster.attendance.importTitle")}
          </h3>
          <p className="text-xs leading-relaxed text-slate-500">
            {t("roster.attendance.importExplain")}
          </p>
          {problem ? <SchedulingAlert message={problem.message} remedy={problem.remedy} /> : null}
          {devices && !devices.length ? (
            <SchedulingAlert
              tone="info"
              message={t("roster.attendance.noDevices")}
              remedy={t("roster.attendance.noDevicesRemedy")}
            />
          ) : null}
          {devices?.length ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    {t("roster.attendance.device")}
                  </span>
                  <Select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
                    {devices.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.code} · {candidate.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    {t("roster.attendance.file")}
                  </span>
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => void read(event.target.files?.[0])}
                  />
                </label>
                <label className="col-span-2 space-y-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    {t("roster.attendance.completeThrough")}
                  </span>
                  <Input
                    value={completeThrough}
                    placeholder="2026-03-08T18:00-05:00"
                    onChange={(event) => setCompleteThrough(event.target.value)}
                  />
                  <span className="block text-[11px] text-slate-400">
                    {t("roster.attendance.completeThroughHelp", { zone: device?.timeZone ?? "" })}
                  </span>
                </label>
                <label className="col-span-2 space-y-1">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    {t("roster.reason")}
                  </span>
                  <Input
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              </div>
              {watermark === undefined ? (
                <SchedulingAlert
                  message={t("roster.attendance.badWatermark")}
                  remedy={t("roster.attendance.completeThroughHelp", {
                    zone: device?.timeZone ?? "",
                  })}
                />
              ) : null}
              {file ? (
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  {t("roster.attendance.parsed", {
                    count: file.events.length,
                    problems: file.problems.length,
                  })}
                </p>
              ) : null}
              {file?.problems.slice(0, 8).map((item, index) => (
                <SchedulingAlert
                  key={index}
                  message={csvProblem(t, item)}
                  remedy={t("roster.attendance.csv.remedy")}
                />
              ))}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void admit()}
                  disabled={
                    busy ||
                    !file ||
                    !file.events.length ||
                    file.problems.length > 0 ||
                    !deviceId ||
                    watermark === undefined ||
                    !reason.trim()
                  }
                >
                  {t("roster.attendance.admit")}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
