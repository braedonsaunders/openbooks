"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { useViewerFormat } from "@/lib/viewer-format";

/** Rebuild rounds started recently for one page; a page that keeps answering
 * stale stops asking. */
const rounds = new Map<string, number[]>();
const MAX_ROUNDS_PER_MINUTE = 3;

/**
 * A module cockpit rendered from a kept projection. When the projection may
 * be out of date the page says when its figures were calculated, asks the
 * server to rebuild it once, and re-renders with the new figures.
 */
export function PageProjectionStatus({
  page,
  params,
  observedAt,
  refreshing,
}: {
  page: string;
  params: Record<string, string>;
  observedAt: string;
  refreshing: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("dashboard");
  const { dateTime } = useViewerFormat();
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    if (!refreshing) return;
    const key = `${page}:${paramsKey}`;
    const now = Date.now();
    const recent = (rounds.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= MAX_ROUNDS_PER_MINUTE) return;
    rounds.set(key, [...recent, now]);
    const controller = new AbortController();
    void fetch("/api/me/page-projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page, params: JSON.parse(paramsKey) }),
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        // A failed rebuild keeps the figures on screen with their
        // calculation time; the next visit asks again.
        if (response.ok) router.refresh();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [page, paramsKey, refreshing, router]);

  if (!refreshing) return null;
  return (
    <span
      role="status"
      className="pointer-events-none fixed top-16 right-6 z-30 inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] text-slate-500 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-900/90 dark:text-slate-400 dark:ring-slate-700/70"
    >
      <RefreshCw size={10} aria-hidden className="shrink-0 animate-spin" />
      {t("spotlight.updated", { time: dateTime(new Date(observedAt), { timeStyle: "short" }) })}
    </span>
  );
}
