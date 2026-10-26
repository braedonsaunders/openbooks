"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { useViewerFormat } from "@/lib/viewer-format";

/** Tile groups served from an older projection, gathered for one rebuild. */
const pending = new Map<string, readonly string[]>();
let flush: ReturnType<typeof setTimeout> | null = null;
let refreshPage: (() => void) | null = null;
/** Rebuild rounds started recently; a page that keeps answering stale stops asking. */
const rounds: number[] = [];
const MAX_ROUNDS_PER_MINUTE = 3;

async function rebuildPending() {
  flush = null;
  const groups = [...pending.values()];
  pending.clear();
  const now = Date.now();
  while (rounds.length > 0 && now - rounds[0]! > 60_000) rounds.shift();
  if (groups.length === 0 || rounds.length >= MAX_ROUNDS_PER_MINUTE) return;
  rounds.push(now);
  try {
    const response = await fetch("/api/me/dashboard/projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groups }),
      cache: "no-store",
    });
    // A failed rebuild keeps the figures on screen with their calculation
    // time; the next visit asks again.
    if (response.ok) refreshPage?.();
  } catch {
    // Same: the shown projection stays, labelled with when it was calculated.
  }
}

/**
 * A dashboard tile rendered from a kept projection. When the projection may
 * be out of date the tile shows when its figures were calculated, the page
 * asks the server to rebuild every such tile group once, and re-renders with
 * the new figures when they are ready.
 */
export function ProjectionFrame({
  group,
  observedAt,
  refreshing,
  children,
}: {
  group: readonly string[];
  observedAt: string;
  refreshing: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("dashboard");
  const { dateTime } = useViewerFormat();
  const groupKey = group.join(",");

  useEffect(() => {
    if (!refreshing) return;
    refreshPage = () => router.refresh();
    pending.set(groupKey, groupKey.split(","));
    flush ??= setTimeout(() => void rebuildPending(), 50);
  }, [refreshing, groupKey, router]);

  return (
    <div className="relative h-full">
      {children}
      {refreshing ? (
        <span
          className="pointer-events-none absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-white/85 px-1.5 py-0.5 text-[10px] text-slate-500 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-900/85 dark:text-slate-400 dark:ring-slate-700/70"
          title={t("spotlight.updated", {
            time: dateTime(new Date(observedAt), { dateStyle: "medium", timeStyle: "short" }),
          })}
        >
          <RefreshCw size={9} aria-hidden className="shrink-0 animate-spin" />
          {t("spotlight.updated", { time: dateTime(new Date(observedAt), { timeStyle: "short" }) })}
        </span>
      ) : null}
    </div>
  );
}
