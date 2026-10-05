'use client'

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Badge, Button, EmptyState, Select } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "../../../../components/paged-table";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { promptDialog } from "@/lib/prompt";

interface InboundEvent {
  id: string;
  topic: string;
  providerEventId: string;
  verified: boolean;
  status: string;
  attempts: number;
  error: string | null;
  receivedAt: string;
}

const STATUS_VARIANT: Record<string, "success" | "secondary" | "outline" | "destructive" | "warning"> = {
  processed: "success",
  ignored: "secondary",
  pending: "secondary",
  failed: "warning",
  dead: "destructive",
};

const FILTERS = ["all", "pending", "failed", "dead", "processed"] as const;

/**
 * One channel's delivery activity: filterable, searchable, replayable.
 * The filter persists in the URL so a queue row deep-links to its slice.
 */
export function ChannelActivity({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const { dateTime } = useViewerFormat();
  const t = useTranslations("channels");
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    const value = new URLSearchParams(window.location.search).get("eventStatus");
    return (FILTERS as readonly string[]).includes(value ?? "") ? value! : "all";
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return fetch(`/api/channels/${channelId}/events?limit=500`)
      .then(async (res) => {
        if (!res.ok) {
          setLoadError(await readApiErrorMessage(res, t("activity.toast.loadFailed", { status: res.status })));
          setLoading(false);
          return;
        }
        const payload = (await res.json()) as { events: InboundEvent[] };
        setEvents(payload.events);
        setLoadError(null);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(t("activity.toast.loadFailed", { status: "network" }));
        setLoading(false);
      });
  }, [channelId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeFilter(value: string) {
    setFilter(value);
    const url = new URL(window.location.href);
    if (value === "all") url.searchParams.delete("eventStatus");
    else url.searchParams.set("eventStatus", value);
    window.history.replaceState({}, "", url);
  }

  async function replay(eventIds: string[]) {
    if (eventIds.length === 0) return;
    const reason = await promptDialog({
      title: t("activity.replayTitle", { count: eventIds.length }),
      message: t("activity.replayBody"),
      label: t("home.reasonLabel"),
      confirmLabel: t("activity.replayConfirm"),
    });
    if (!reason) return;
    setBusy(true);
    try {
      let replayed = 0;
      for (const eventId of eventIds) {
        const res = await fetch(`/api/channels/${channelId}/events/${eventId}/replay`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t("activity.toast.replayFailed", { status: res.status })));
          break;
        }
        replayed += 1;
      }
      if (replayed > 0) toast.success(t("activity.toast.replayed", { count: replayed }));
      setSelected(new Set());
      await load();
    } catch {
      toast.error(t("activity.toast.replayFailed", { status: "network" }));
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(
    () => (filter === "all" ? events : events.filter((event) => event.status === filter)),
    [events, filter],
  );
  const statusLabel = (s: string) => (t.has(`activity.status.${s}`) ? t(`activity.status.${s}`) : s);

  const columns: PagedColumn<InboundEvent>[] = useMemo(
    () => [
      {
        key: "received",
        header: t("activity.columns.received"),
        cell: (row) => dateTime(new Date(row.receivedAt)),
        search: (row) => `${row.topic} ${row.providerEventId} ${row.error ?? ""}`,
      },
      {
        key: "topic",
        header: t("activity.columns.topic"),
        cell: (row) => (
          <span>
            {row.topic} <span className="text-slate-400">{row.providerEventId}</span>
          </span>
        ),
      },
      {
        key: "status",
        header: t("activity.columns.status"),
        cell: (row) => (
          <Badge variant={STATUS_VARIANT[row.status] ?? "secondary"}>{statusLabel(row.status)}</Badge>
        ),
      },
      {
        key: "error",
        header: t("activity.columns.error"),
        cell: (row) => <span className="text-slate-500">{row.status === "processed" || row.status === "ignored" ? "—" : (row.error ?? "—")}</span>,
      },
      ...(canManage
        ? [
            {
              key: "replay",
              header: "",
              cell: (row: InboundEvent) =>
                row.status === "failed" || row.status === "dead" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void replay([row.id])}>
                    <RotateCcw size={14} /> {t("activity.replayOne")}
                  </Button>
                ) : null,
            } satisfies PagedColumn<InboundEvent>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canManage, busy],
  );

  if (loading) return <p className="text-sm text-slate-500">{t("activity.loading")}</p>;
  if (loadError) {
    return (
      <EmptyState
        title={t("activity.loadFailedTitle")}
        description={loadError}
        action={<Button onClick={() => void load()}>{t("activity.retry")}</Button>}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onChange={(e) => changeFilter(e.target.value)} aria-label={t("activity.filterLabel")}>
          {FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(`activity.filters.${value}`)}
            </option>
          ))}
        </Select>
        {canManage && selected.size > 0 ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void replay([...selected])}>
            <RotateCcw size={14} /> {t("activity.replaySelected", { count: selected.size })}
          </Button>
        ) : null}
      </div>
      <PagedTable
        rows={visible}
        columns={columns}
        pageSize={25}
        searchable
        rowKey={(row) => row.id}
        empty={<EmptyState title={t("activity.emptyTitle")} description={t("activity.emptyBody")} />}
        selection={
          canManage
            ? {
                getId: (row) => row.id,
                selectedIds: selected,
                onToggle: (id) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  }),
                onToggleAll: (ids) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    const every = ids.every((id) => next.has(id));
                    for (const id of ids) {
                      if (every) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  }),
              }
            : undefined
        }
      />
    </div>
  );
}
