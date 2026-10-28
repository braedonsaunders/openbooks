"use client";

import { useLocale, useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { cn } from "@openbooks/ui";
import { NavIcon } from "./sidebar-nav";
import { formatCivilDate } from "../lib/format";
import { statusLabel } from "../lib/status-label";
import type { SearchBadge, SearchHit } from "../lib/search-types";

/** A hit as either surface renders it: records, pages and create actions. */
export type SearchHitView = Omit<SearchHit, "type"> & {
  type: SearchHit["type"] | "page" | "action";
};

/**
 * Mark every occurrence of each query word in `text`, case-insensitively.
 * Overlapping matches merge, so "inv" and "invoice" never split one mark.
 */
export function highlightWords(text: string, words: readonly string[]): React.ReactNode {
  const needles = words.map((word) => word.toLowerCase()).filter((word) => word.length > 0);
  if (!text || needles.length === 0) return text;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const needle of needles) {
    let at = lower.indexOf(needle);
    while (at >= 0) {
      marks.push([at, at + needle.length]);
      at = lower.indexOf(needle, at + needle.length);
    }
  }
  if (marks.length === 0) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const mark of marks) {
    const last = merged[merged.length - 1];
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([...mark]);
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="bg-transparent font-semibold text-teal-700 dark:text-teal-300">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * The words of a query a hit can have matched: the text outside the chips
 * the server read as structure (a scope, an amount, a date or a status).
 */
export function matchedQueryWords(
  q: string,
  chips: readonly { start: number; end: number }[],
): string[] {
  let text = q;
  for (const chip of [...chips].sort((a, b) => b.start - a.start))
    text = `${text.slice(0, chip.start)} ${text.slice(chip.end)}`;
  return queryHighlightWords(text);
}

/** The words of a query to mark, without operators or punctuation. */
export function queryHighlightWords(q: string): string[] {
  return q
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length >= 2);
}

/**
 * The row body shared by the header panel and the results page: icon,
 * title, badge, why it matched, its date and amount.
 */
export function SearchHitContent({
  hit,
  words,
  active = false,
  dense = true,
}: {
  hit: SearchHitView;
  words: readonly string[];
  active?: boolean;
  dense?: boolean;
}) {
  const t = useTranslations("shell.globalSearch");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const badgeLabel = (badge: SearchBadge) =>
    badge.kind === "role"
      ? tCommon(`labels.${badge.value}` as never)
      : statusLabel(
          badge.value,
          (key) => tCommon(key as never),
          (key) => tCommon.has(key as never),
        );
  const match = hit.match
    ? hit.match.kind === "line"
      ? t("match.line", { text: hit.match.text })
      : t(`match.${hit.match.kind}` as never, { amount: hit.match.amount } as never)
    : null;
  const secondary = [hit.subtitle, match].filter(Boolean).join(" · ");
  return (
    <>
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-md",
          dense ? "h-7 w-7" : "h-8 w-8",
          active
            ? "bg-white text-teal-600 dark:bg-slate-900 dark:text-teal-300"
            : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
        )}
        aria-hidden="true"
      >
        {hit.type === "action" ? <Plus size={15} /> : <NavIcon iconKey={hit.iconKey} size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-slate-900 dark:text-slate-100">
            {highlightWords(hit.title, words)}
          </span>
          {hit.badge ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {badgeLabel(hit.badge)}
            </span>
          ) : null}
        </span>
        {secondary ? (
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {highlightWords(secondary, words)}
          </span>
        ) : null}
      </span>
      {hit.date ? (
        <span className="hidden shrink-0 text-xs text-slate-400 tabular-nums sm:inline dark:text-slate-500">
          {formatCivilDate(hit.date, locale)}
        </span>
      ) : null}
      {hit.amount ? (
        <span className="shrink-0 font-mono text-xs text-slate-600 tabular-nums dark:text-slate-300">
          {hit.amount}
        </span>
      ) : null}
    </>
  );
}
