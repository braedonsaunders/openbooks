"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, Clock, MapPin, RefreshCw, Send, Undo2, UserMinus, X } from "lucide-react";
import { Badge, Button, Input, Select, cn } from "@openbooks/ui";
import type {
  DispatchBooking,
  DispatchDay,
  DispatchVisitCard,
} from "@openbooks/engine/service/dispatch";
import { promptDialog } from "../../lib/prompt";
import { useDocumentHidden } from "../../lib/use-document-hidden";
import {
  postJson,
  serviceRequest,
  ServiceRequestError,
  type ServiceConflict,
} from "../service/api";
import { plainDecimal } from "../service/format";
import { SchedulingAlert } from "./SchedulingAlert";

/** How often the open board re-reads the day while visible. */
const POLL_MS = 15_000;
const SNAP_MINUTES = 15;
const PX_PER_MINUTE = 1.1;

type Filters = { priority: string; skill: string; area: string; sla: string; q: string };
type Notice = {
  id: number;
  tone: "error" | "success";
  message: string;
  remedy: string | null;
  conflicts?: readonly ServiceConflict[];
};

type DispatchResult = {
  visitId: string;
  visitRevision: number;
  entryId: string | null;
  entryRevision: number | null;
  notices: readonly { status: string; detail: string | null }[];
};

/** One reversible board action: the inverse is replayed with the revisions the action returned. */
type UndoStep =
  | { kind: "assign"; label: string; entryId: string; entryRevision: number; visitRevision: number }
  | {
      kind: "move";
      label: string;
      entryId: string;
      entryRevision: number;
      visitRevision: number;
      workerPartyId: string;
      startsAt: string;
      minutes: number;
    }
  | {
      kind: "unassign";
      label: string;
      visitId: string;
      visitRevision: number;
      workerPartyId: string;
      startsAt: string;
      minutes: number;
    };

type DragPayload =
  | { kind: "card"; visitId: string; revision: number; minutes: number }
  | {
      kind: "booking";
      entryId: string;
      entryRevision: number;
      visitRevision: number;
      minutes: number;
      workerPartyId: string;
      startsAt: string;
    };

const STATUS_TONE: Record<string, string> = {
  scheduled:
    "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100",
  dispatched:
    "border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-100",
  en_route:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100",
  on_site:
    "border-teal-400 bg-teal-50 text-teal-900 dark:border-teal-700 dark:bg-teal-950/50 dark:text-teal-100",
  completed:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100",
  unable_to_complete:
    "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-100",
};
const PRIORITY_VARIANT: Record<string, "destructive" | "warning" | "secondary" | "outline"> = {
  urgent: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

/** The day's axis: the board's working day (or the engine's 06:00–20:00 fallback), widened to hold bookings near it. */
function dayAxis(day: DispatchDay): { start: number; end: number; fallback: boolean } {
  const start = Date.parse(day.displayWindow.startsAt);
  const end = Date.parse(day.displayWindow.endsAt);
  const starts = day.bookings
    .map((booking) => Date.parse(booking.startsAt))
    .filter((value) => value > start - 6 * 3600_000);
  const ends = day.bookings
    .map((booking) => Date.parse(booking.endsAt))
    .filter((value) => value < end + 6 * 3600_000);
  return {
    start: Math.min(start, ...starts),
    end: Math.max(end, ...ends),
    fallback: day.workingWindow === null,
  };
}

export function DispatchView({
  boardId,
  date,
  onOpenVisit,
}: {
  boardId: string;
  date: string;
  onOpenVisit: (visitId: string) => void;
}) {
  const t = useTranslations("service.dispatch");
  const tService = useTranslations("service");
  const locale = useLocale();
  const hidden = useDocumentHidden();
  const [day, setDay] = useState<DispatchDay | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; remedy: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    priority: "",
    skill: "",
    area: "",
    sla: "any",
    q: "",
  });
  const [notices, setNotices] = useState<Notice[]>([]);
  const [undo, setUndo] = useState<UndoStep[]>([]);
  const [hover, setHover] = useState<{ partyId: string; minute: number } | null>(null);
  const drag = useRef<DragPayload | null>(null);
  const seq = useRef(0);
  const noticeSeq = useRef(0);

  const notify = useCallback((notice: Omit<Notice, "id">) => {
    const id = ++noticeSeq.current;
    setNotices((current) => [...current.slice(-3), { ...notice, id }]);
    if (notice.tone === "success")
      setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 3500);
  }, []);

  const load = useCallback(async () => {
    const request = ++seq.current;
    const params = new URLSearchParams({ board: boardId, date });
    if (filters.priority) params.append("priority", filters.priority);
    if (filters.skill) params.set("skill", filters.skill);
    if (filters.area) params.set("area", filters.area);
    if (filters.sla !== "any") params.set("sla", filters.sla);
    if (filters.q.trim()) params.set("q", filters.q.trim());
    try {
      const next = await serviceRequest<DispatchDay>(
        `/api/service/dispatch?${params}`,
        undefined,
        t("errors.load"),
      );
      if (request !== seq.current) return;
      setDay(next);
      setLoadError(null);
    } catch (error) {
      if (request !== seq.current) return;
      setLoadError({
        message: error instanceof Error ? error.message : t("errors.load"),
        remedy: error instanceof ServiceRequestError ? error.remedy : null,
      });
    }
  }, [boardId, date, filters, t]);

  // Live updates: the board re-reads on a short interval while the page is
  // visible, and once immediately whenever it becomes visible again.
  useEffect(() => {
    if (hidden) return;
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [hidden, load]);

  const axis = useMemo(() => (day ? dayAxis(day) : null), [day]);
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: day?.timeZone ?? "UTC",
      }),
    [locale, day?.timeZone],
  );
  const bookingsByTech = useMemo(() => {
    const map = new Map<string, DispatchBooking[]>();
    for (const booking of day?.bookings ?? [])
      map.set(booking.workerPartyId, [...(map.get(booking.workerPartyId) ?? []), booking]);
    return map;
  }, [day]);

  /** Send a board command; warnings ask for an override reason and retry, blocking conflicts refuse. */
  const command = useCallback(
    async (
      url: string,
      body: Record<string, unknown>,
      label: string,
    ): Promise<DispatchResult | null> => {
      setBusy(true);
      try {
        let overrideReason: string | null = null;
        for (;;) {
          try {
            const result = await postJson<DispatchResult>(
              url,
              overrideReason ? { ...body, overrideReason } : body,
              t("errors.save"),
            );
            const failed = result.notices?.find((notice) => notice.status === "failed");
            notify({ tone: "success", message: label, remedy: null });
            if (failed)
              notify({ tone: "error", message: t("notices.noticeFailed"), remedy: failed.detail });
            return result;
          } catch (error) {
            if (
              error instanceof ServiceRequestError &&
              error.conflicts.length &&
              !overrideReason &&
              error.conflicts.every((conflict) => conflict.severity === "warn")
            ) {
              const reason = await promptDialog({
                title: t("override.title"),
                message: error.conflicts
                  .map((conflict) => `• ${t(`conflicts.${conflict.code}`)}`)
                  .join("\n"),
                label: t("override.reason"),
                confirmLabel: t("override.confirm"),
              });
              if (!reason) return null;
              overrideReason = reason;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        notify({
          tone: "error",
          message: error instanceof Error ? error.message : t("errors.save"),
          remedy: error instanceof ServiceRequestError ? error.remedy : null,
          conflicts: error instanceof ServiceRequestError ? error.conflicts : undefined,
        });
        return null;
      } finally {
        setBusy(false);
        void load();
      }
    },
    [load, notify, t],
  );

  const assign = useCallback(
    async (
      visit: { visitId: string; revision: number; minutes: number },
      workerPartyId: string,
      startsAt: string,
    ) => {
      const result = await command(
        "/api/service/dispatch/assign",
        {
          boardId,
          visitId: visit.visitId,
          expectedRevision: visit.revision,
          workerPartyId,
          startsAt,
          minutes: visit.minutes,
        },
        t("notices.assigned"),
      );
      if (result?.entryId && result.entryRevision !== null)
        setUndo((stack) => [
          ...stack.slice(-19),
          {
            kind: "assign",
            label: t("history.assign"),
            entryId: result.entryId!,
            entryRevision: result.entryRevision!,
            visitRevision: result.visitRevision,
          },
        ]);
    },
    [boardId, command, t],
  );

  const move = useCallback(
    async (
      payload: Extract<DragPayload, { kind: "booking" }>,
      workerPartyId: string,
      startsAt: string,
    ) => {
      if (payload.workerPartyId === workerPartyId && payload.startsAt === startsAt) return;
      const result = await command(
        "/api/service/dispatch/move",
        {
          boardId,
          entryId: payload.entryId,
          expectedEntryRevision: payload.entryRevision,
          expectedVisitRevision: payload.visitRevision,
          workerPartyId,
          startsAt,
          minutes: payload.minutes,
        },
        t("notices.moved"),
      );
      if (result?.entryId && result.entryRevision !== null) {
        setUndo((stack) => [
          ...stack.slice(-19),
          {
            kind: "move",
            label: t("history.move"),
            entryId: result.entryId!,
            entryRevision: result.entryRevision!,
            visitRevision: result.visitRevision,
            workerPartyId: payload.workerPartyId,
            startsAt: payload.startsAt,
            minutes: payload.minutes,
          },
        ]);
      }
    },
    [boardId, command, t],
  );

  const unassign = useCallback(
    async (booking: DispatchBooking) => {
      if (!booking.visit) return;
      const result = await command(
        "/api/service/dispatch/unassign",
        {
          boardId,
          entryId: booking.entryId,
          expectedEntryRevision: booking.revision,
          expectedVisitRevision: booking.visit.revision,
        },
        t("notices.unassigned"),
      );
      if (result) {
        const minutes = Math.round(
          (Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60000,
        );
        setUndo((stack) => [
          ...stack.slice(-19),
          {
            kind: "unassign",
            label: t("history.unassign"),
            visitId: booking.visit!.visitId,
            visitRevision: result.visitRevision,
            workerPartyId: booking.workerPartyId,
            startsAt: booking.startsAt,
            minutes,
          },
        ]);
      }
    },
    [boardId, command, t],
  );

  const sendVisit = useCallback(
    async (visit: DispatchVisitCard) => {
      await command(
        "/api/service/dispatch/send",
        { boardId, visitId: visit.visitId, expectedRevision: visit.revision },
        t("notices.dispatched"),
      );
    },
    [boardId, command, t],
  );

  const undoLast = useCallback(async () => {
    const step = undo.at(-1);
    if (!step) return;
    setUndo((stack) => stack.slice(0, -1));
    if (step.kind === "assign") {
      await command(
        "/api/service/dispatch/unassign",
        {
          boardId,
          entryId: step.entryId,
          expectedEntryRevision: step.entryRevision,
          expectedVisitRevision: step.visitRevision,
          reason: t("history.undoReason"),
        },
        t("notices.undone"),
      );
    } else if (step.kind === "move") {
      await command(
        "/api/service/dispatch/move",
        {
          boardId,
          entryId: step.entryId,
          expectedEntryRevision: step.entryRevision,
          expectedVisitRevision: step.visitRevision,
          workerPartyId: step.workerPartyId,
          startsAt: step.startsAt,
          minutes: step.minutes,
          overrideReason: t("history.undoReason"),
        },
        t("notices.undone"),
      );
    } else {
      await command(
        "/api/service/dispatch/assign",
        {
          boardId,
          visitId: step.visitId,
          expectedRevision: step.visitRevision,
          workerPartyId: step.workerPartyId,
          startsAt: step.startsAt,
          minutes: step.minutes,
          overrideReason: t("history.undoReason"),
        },
        t("notices.undone"),
      );
    }
  }, [boardId, command, t, undo]);

  function minuteAt(event: DragEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, (event.clientY - rect.top) / PX_PER_MINUTE);
    return Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
  }

  function onDrop(event: DragEvent<HTMLDivElement>, partyId: string) {
    event.preventDefault();
    setHover(null);
    const payload = drag.current;
    drag.current = null;
    if (!payload || !axis || !day?.canDispatch) return;
    const startsAt = new Date(axis.start + minuteAt(event) * 60000).toISOString();
    if (payload.kind === "card")
      void assign(
        { visitId: payload.visitId, revision: payload.revision, minutes: payload.minutes },
        partyId,
        startsAt,
      );
    else void move(payload, partyId, startsAt);
  }

  if (!day || !axis) {
    return loadError ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <SchedulingAlert message={loadError.message} remedy={loadError.remedy} />
        <Button variant="outline" onClick={() => void load()}>
          {t("retry")}
        </Button>
      </div>
    ) : (
      <div
        aria-busy="true"
        className="flex-1 animate-pulse rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
      />
    );
  }

  const totalMinutes = Math.max(60, Math.round((axis.end - axis.start) / 60000));
  const hours = Array.from(
    { length: Math.floor(totalMinutes / 60) + 1 },
    (_, index) => axis.start + index * 3600_000,
  );
  const nowOffset = (Date.now() - axis.start) / 60000;

  return (
    <div className="flex min-h-0 flex-1 gap-3" data-dispatch-board>
      {/* Unscheduled queue */}
      <aside
        className="flex w-72 shrink-0 flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
        aria-label={t("queue.title")}
      >
        <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t("queue.title")} <span className="text-slate-400">{day.queue.length}</span>
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => void load()}
              aria-label={t("refresh")}
              title={t("freshness", { time: time.format(new Date(day.readAt)) })}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input
            value={filters.q}
            onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder={t("queue.search")}
            aria-label={t("queue.search")}
            className="h-8 text-xs"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={filters.priority}
              onChange={(event) =>
                setFilters((current) => ({ ...current, priority: event.target.value }))
              }
              aria-label={t("queue.priority")}
              className="h-8 text-xs"
            >
              <option value="">{t("queue.anyPriority")}</option>
              {(["urgent", "high", "normal", "low"] as const).map((value) => (
                <option key={value} value={value}>
                  {tService(`priority.${value}`)}
                </option>
              ))}
            </Select>
            <Select
              value={filters.sla}
              onChange={(event) =>
                setFilters((current) => ({ ...current, sla: event.target.value }))
              }
              aria-label={t("queue.sla")}
              className="h-8 text-xs"
            >
              {(["any", "breached", "due_today", "due_soon"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`queue.slaOptions.${value}`)}
                </option>
              ))}
            </Select>
            <Select
              value={filters.skill}
              onChange={(event) =>
                setFilters((current) => ({ ...current, skill: event.target.value }))
              }
              aria-label={t("queue.skill")}
              className="h-8 text-xs"
            >
              <option value="">{t("queue.anySkill")}</option>
              {day.qualifications.map((qualification) => (
                <option key={qualification.id} value={qualification.id}>
                  {qualification.name}
                </option>
              ))}
            </Select>
            <Select
              value={filters.area}
              onChange={(event) =>
                setFilters((current) => ({ ...current, area: event.target.value }))
              }
              aria-label={t("queue.area")}
              className="h-8 text-xs"
            >
              <option value="">{t("queue.anyArea")}</option>
              {day.areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {day.queue.length === 0 ? (
            <li className="p-4 text-center text-xs text-slate-500">{t("queue.empty")}</li>
          ) : (
            day.queue.map((card) => (
              <li key={card.visitId}>
                <div
                  role="button"
                  tabIndex={0}
                  draggable={day.canDispatch}
                  onDragStart={(event) => {
                    drag.current = {
                      kind: "card",
                      visitId: card.visitId,
                      revision: card.revision,
                      minutes: card.estimatedMinutes,
                    };
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", card.visitId);
                  }}
                  onClick={() => onOpenVisit(card.visitId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onOpenVisit(card.visitId);
                  }}
                  className={cn(
                    "cursor-pointer rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm transition hover:border-teal-400 dark:border-slate-700 dark:bg-slate-900",
                    day.canDispatch && "cursor-grab active:cursor-grabbing",
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-semibold text-slate-900 dark:text-slate-100">
                      {card.number} · {card.sequence}
                    </span>
                    <Badge variant={PRIORITY_VARIANT[card.priority] ?? "secondary"}>
                      {tService(`priority.${card.priority}`)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-slate-700 dark:text-slate-200">{card.title}</p>
                  <p className="truncate text-slate-500">{card.customerName}</p>
                  {card.address ? (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-slate-500">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {card.address}
                    </p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="h-3 w-3" />
                      {t("minutes", { count: card.estimatedMinutes })}
                    </span>
                    {card.kind === "assessment" ? (
                      <span>· {tService("visitKind.assessment")}</span>
                    ) : null}
                    {card.slaDueAt ? (
                      <span
                        className={cn(
                          Date.parse(card.slaDueAt) < Date.now() && "font-semibold text-rose-600",
                        )}
                      >
                        ·{" "}
                        {t("dueBy", {
                          time: new Intl.DateTimeFormat(locale, {
                            dateStyle: "short",
                            timeStyle: "short",
                            timeZone: day.timeZone,
                          }).format(new Date(card.slaDueAt)),
                        })}
                      </span>
                    ) : null}
                  </div>
                  {card.requiredQualifications.length ? (
                    <p className="mt-1 truncate text-[11px] text-slate-500">
                      {card.requiredQualifications
                        .map((qualification) => qualification.name)
                        .join(", ")}
                    </p>
                  ) : null}
                </div>
              </li>
            ))
          )}
        </ul>
      </aside>

      {/* Technician columns on a time axis */}
      <section
        className="flex min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
        aria-label={t("board")}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs dark:border-slate-800">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(
              new Date(`${day.date}T00:00:00Z`),
            )}
          </span>
          <span className="text-slate-400">
            {t("freshness", { time: time.format(new Date(day.readAt)) })}
          </span>
          {busy ? <span className="text-slate-400">{t("saving")}</span> : null}
          <div className="ml-auto flex items-center gap-1">
            {day.canDispatch ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={!undo.length || busy}
                onClick={() => void undoLast()}
                title={undo.at(-1)?.label}
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t("undo")}
              </Button>
            ) : null}
          </div>
        </div>
        {axis.fallback ? (
          <div className="px-3 pt-2">
            <SchedulingAlert
              tone="warning"
              message={t("noWorkingDay")}
              remedy={t("noWorkingDayRemedy")}
            />
          </div>
        ) : null}
        {!day.canDispatch ? (
          <div className="px-3 pt-2">
            <SchedulingAlert tone="info" message={t("readOnly")} />
          </div>
        ) : null}
        {day.technicians.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">{t("noTechnicians")}</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-w-max">
              <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
                <div className="sticky top-0 z-10 h-14 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950" />
                <div className="relative" style={{ height: totalMinutes * PX_PER_MINUTE }}>
                  {hours.map((hour, index) => (
                    <span
                      key={hour}
                      className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-slate-400"
                      style={{ top: index * 60 * PX_PER_MINUTE }}
                    >
                      {time.format(new Date(hour))}
                    </span>
                  ))}
                </div>
              </div>
              {day.technicians.map((technician) => {
                const own = bookingsByTech.get(technician.partyId) ?? [];
                const onLeave = technician.absences.length > 0;
                const missing = (card: { requiredQualifications: readonly { id: string }[] }) =>
                  card.requiredQualifications.some(
                    (q) => !technician.qualificationTypeIds.includes(q.id),
                  );
                return (
                  <div
                    key={technician.partyId}
                    className="w-52 shrink-0 border-r border-slate-100 dark:border-slate-800"
                  >
                    <div className="sticky top-0 z-10 h-14 border-b border-slate-200 bg-white px-2 py-1.5 dark:border-slate-800 dark:bg-slate-950">
                      <p className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                        {technician.name}
                      </p>
                      <p className="truncate text-[11px] text-slate-500">
                        {onLeave ? (
                          <span className="font-medium text-rose-600">
                            {t("onLeave", { type: technician.absences[0]!.leaveTypeName })}
                          </span>
                        ) : technician.scheduledDay === false ? (
                          t("dayOff")
                        ) : technician.scheduledHours ? (
                          t("scheduledHours", { hours: plainDecimal(technician.scheduledHours) })
                        ) : (
                          (technician.jobTitle ?? "")
                        )}
                      </p>
                    </div>
                    <div
                      className={cn(
                        "relative",
                        onLeave && "bg-rose-50/60 dark:bg-rose-950/20",
                        technician.scheduledDay === false &&
                          !onLeave &&
                          "bg-slate-50 dark:bg-slate-900/60",
                      )}
                      style={{ height: totalMinutes * PX_PER_MINUTE }}
                      onDragOver={(event) => {
                        if (!day.canDispatch) return;
                        event.preventDefault();
                        setHover({ partyId: technician.partyId, minute: minuteAt(event) });
                      }}
                      onDragLeave={() =>
                        setHover((current) =>
                          current?.partyId === technician.partyId ? null : current,
                        )
                      }
                      onDrop={(event) => onDrop(event, technician.partyId)}
                      aria-label={t("column", { name: technician.name })}
                    >
                      {hours.map((hour, index) => (
                        <div
                          key={hour}
                          className="absolute inset-x-0 border-t border-slate-100 dark:border-slate-800/70"
                          style={{ top: index * 60 * PX_PER_MINUTE }}
                        />
                      ))}
                      {nowOffset > 0 && nowOffset < totalMinutes ? (
                        <div
                          className="absolute inset-x-0 z-[5] border-t-2 border-rose-400"
                          style={{ top: nowOffset * PX_PER_MINUTE }}
                        />
                      ) : null}
                      {hover?.partyId === technician.partyId && drag.current ? (
                        <div
                          className="pointer-events-none absolute inset-x-1 z-[6] rounded-md border-2 border-dashed border-teal-500 bg-teal-50/70 px-1 text-[10px] text-teal-800 dark:bg-teal-950/50 dark:text-teal-100"
                          style={{
                            top: hover.minute * PX_PER_MINUTE,
                            height: drag.current.minutes * PX_PER_MINUTE,
                          }}
                        >
                          {time.format(new Date(axis.start + hover.minute * 60000))}
                          {drag.current.kind === "card" &&
                          missing(
                            day.queue.find(
                              (card) =>
                                card.visitId === (drag.current as { visitId: string }).visitId,
                            ) ?? { requiredQualifications: [] },
                          ) ? (
                            <span className="ml-1 font-semibold text-rose-600">
                              {t("conflicts.qualification")}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {own.map((booking) => {
                        const top = Math.max(
                          0,
                          (Date.parse(booking.startsAt) - axis.start) / 60000,
                        );
                        const height = Math.max(
                          18,
                          ((Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60000) *
                            PX_PER_MINUTE,
                        );
                        const visit = booking.visit;
                        const minutes = Math.round(
                          (Date.parse(booking.endsAt) - Date.parse(booking.startsAt)) / 60000,
                        );
                        const movable = Boolean(
                          day.canDispatch &&
                          visit &&
                          booking.boardId === boardId &&
                          (visit.status === "scheduled" || visit.status === "dispatched"),
                        );
                        return (
                          <div
                            key={booking.entryId}
                            draggable={movable}
                            onDragStart={(event) => {
                              if (!visit) return;
                              drag.current = {
                                kind: "booking",
                                entryId: booking.entryId,
                                entryRevision: booking.revision,
                                visitRevision: visit.revision,
                                minutes,
                                workerPartyId: booking.workerPartyId,
                                startsAt: booking.startsAt,
                              };
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", booking.entryId);
                            }}
                            className={cn(
                              "group absolute inset-x-1 z-[4] overflow-hidden rounded-md border px-1.5 py-1 text-[11px] shadow-sm",
                              visit
                                ? (STATUS_TONE[visit.status] ?? STATUS_TONE.scheduled)
                                : "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
                              movable && "cursor-grab active:cursor-grabbing",
                            )}
                            style={{ top: top * PX_PER_MINUTE, height }}
                            title={
                              visit
                                ? `${visit.number} · ${visit.title} — ${visit.customerName}`
                                : `${booking.boardName}: ${booking.label}`
                            }
                          >
                            {visit ? (
                              <>
                                <button
                                  type="button"
                                  className="block w-full truncate text-left font-semibold"
                                  onClick={() => onOpenVisit(visit.visitId)}
                                >
                                  {time.format(new Date(booking.startsAt))} {visit.number}
                                </button>
                                <p className="truncate">{visit.customerName}</p>
                                <p className="truncate opacity-80">
                                  {tService(`visitStatus.${visit.status}`)}
                                </p>
                                {day.canDispatch && booking.boardId === boardId ? (
                                  <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                                    {visit.status === "scheduled" ? (
                                      <button
                                        type="button"
                                        className="rounded bg-white/80 p-0.5 dark:bg-black/40"
                                        onClick={() => void sendVisit(visit)}
                                        aria-label={t("send")}
                                        title={t("send")}
                                      >
                                        <Send className="h-3 w-3" />
                                      </button>
                                    ) : null}
                                    {visit.status === "scheduled" ||
                                    visit.status === "dispatched" ? (
                                      <button
                                        type="button"
                                        className="rounded bg-white/80 p-0.5 dark:bg-black/40"
                                        onClick={() => void unassign(booking)}
                                        aria-label={t("unassign")}
                                        title={t("unassign")}
                                      >
                                        <UserMinus className="h-3 w-3" />
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <p className="truncate">
                                {booking.boardName} · {booking.label}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2"
        aria-live="polite"
      >
        {notices.map((notice) => (
          <div
            key={notice.id}
            className={cn(
              "pointer-events-auto rounded-lg border p-3 text-sm shadow-lg",
              notice.tone === "error"
                ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
                : "border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-100",
            )}
          >
            <div className="flex items-start gap-2">
              {notice.tone === "error" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : null}
              <div className="min-w-0 flex-1">
                <p>{notice.message}</p>
                {notice.conflicts?.length ? (
                  <ul className="mt-1 list-disc pl-4 text-xs">
                    {notice.conflicts.map((conflict, index) => (
                      <li key={index}>{t(`conflicts.${conflict.code}`)}</li>
                    ))}
                  </ul>
                ) : null}
                {notice.remedy ? <p className="mt-1 text-xs opacity-80">{notice.remedy}</p> : null}
              </div>
              <button
                type="button"
                onClick={() =>
                  setNotices((current) => current.filter((item) => item.id !== notice.id))
                }
                aria-label={t("dismiss")}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
