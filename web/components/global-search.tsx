"use client";

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Search, CornerDownLeft, Loader2, X, ArrowUpRight } from "lucide-react";
import { cn, useMediaQuery } from "@openbooks/ui";
import { type SidebarNavGroup } from "./sidebar-nav";
import { relatedPartyHref } from "./related-party-link";
import { ViewTabsContext } from "./module-home/navigation-context";
import { buildPageIndex, searchPages, type PageSearchHit } from "../lib/nav/page-search";
import { readRecents, rememberRecent, writeRecents, type StoredRecent } from "../lib/search-recent";
import { useShortcuts } from "./shortcuts/shortcut-provider";
import {
  useGlobalCreate,
  type GlobalCreateKey,
  type GlobalCreatePermissions,
} from "./global-create-menu";
import { matchedQueryWords, SearchHitContent, type SearchHitView } from "./search-hit-content";
import { SearchChips } from "./search-chips";
import { withoutChip } from "../lib/search-query";
import { formatCivilDate } from "../lib/format";
import { statusLabel } from "../lib/status-label";
import type { RecentRef, SearchGroup, SearchHit, SearchResponse } from "../lib/search-types";

type Hit = SearchHitView;

const NO_CREATE_PERMISSIONS = {} as GlobalCreatePermissions;

/** Record types the preview pane can describe. */
const PREVIEW_TYPES = new Set(["transaction", "contact", "account", "item", "project"]);

/**
 * Whether a typed command names a create action: optional verbs ("new",
 * "create", localized) followed by words that each start a word of the
 * action's label. A verb alone lists every action.
 */
export function matchesCreateAction(
  query: string,
  label: string,
  verbs: readonly string[],
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const verbSet = new Set(verbs.map((verb) => verb.toLowerCase()));
  const rest = words.filter((word) => !verbSet.has(word));
  if (rest.length === 0) return words.length > 0;
  const labelWords = label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return rest.every((word) => labelWords.some((part) => part.startsWith(word)));
}
type Group = { type: string; labelKey: string; hits: Hit[]; more?: boolean };

/** Results that open a page rather than a record drawer over the current page. */
const PAGE_TYPES = new Set<Hit["type"]>(["page", "report", "setting", "help", "dashboard"]);

type Preview = {
  hit: SearchHit;
  fields: { labelKey: string; value: string; kind?: "money" | "date" | "status" | "text" }[];
  lines?: { description: string; amount: string }[];
  lineCount?: number;
};

function pageHit(page: PageSearchHit): Hit {
  return {
    id: page.href,
    type: "page",
    title: page.title,
    subtitle: page.trail.length ? page.trail.join(" › ") : undefined,
    href: page.href,
    iconKey: page.iconKey,
  };
}

/** The results page for a query, optionally opened on one group. */
export function searchResultsHref(q: string, type?: string): string {
  const params = new URLSearchParams({ q });
  if (type) params.set("type", type);
  return `/search?${params.toString()}`;
}

export function GlobalSearch({
  className,
  navGroups,
  recentScope,
  createPermissions,
}: {
  className?: string;
  /** The shell's create permissions: matching create actions run from the search. */
  createPermissions?: GlobalCreatePermissions;
  navGroups: readonly SidebarNavGroup[];
  /** The signed-in user in the current organization; recents never cross either. */
  recentScope: string;
}) {
  const t = useTranslations("shell.globalSearch");
  const tShortcuts = useTranslations("shell.shortcuts.commands");
  const tCreate = useTranslations("shell.globalCreate");
  const { available: createActions, create } = useGlobalCreate(
    createPermissions ?? NO_CREATE_PERMISSIONS,
  );
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [recentHits, setRecentHits] = useState<Hit[] | null>(null);
  const [recentFailed, setRecentFailed] = useState(false);
  const tabGroups = useContext(ViewTabsContext)?.groups;
  const wide = useMediaQuery("(min-width: 1024px)");

  // Pages come from the menu the shell already resolved for this reader, so
  // they answer instantly and never include a page the menu hides.
  const pageIndex = useMemo(() => buildPageIndex(navGroups, tabGroups), [navGroups, tabGroups]);
  const pageQuery = q.trim();
  const searching = pageQuery.length >= 2;
  const pageGroup: Group | null = useMemo(() => {
    if (pageQuery.length < 2) return null;
    const hits = searchPages(pageIndex, pageQuery).map(pageHit);
    return hits.length ? { type: "page", labelKey: "pages", hits } : null;
  }, [pageIndex, pageQuery]);
  // Create actions answer typed commands ("new bill", "invoice") ahead of
  // records, through the same permission-filtered paths as the + menu.
  const actionGroup: Group | null = useMemo(() => {
    if (pageQuery.length < 2 || !createPermissions) return null;
    const verbs = t("createVerbs").split(/\s+/);
    const hits = createActions
      .filter((action) =>
        matchesCreateAction(pageQuery, tCreate(`items.${action.key}` as never), verbs),
      )
      .slice(0, 5)
      .map((action): Hit => ({
        id: action.key,
        type: "action",
        title: t("createAction", { name: tCreate(`items.${action.key}` as never) }),
        href: "",
        iconKey: "plus",
      }));
    return hits.length ? { type: "action", labelKey: "actions", hits } : null;
  }, [createActions, createPermissions, pageQuery, t, tCreate]);
  // A report or setting that is also a menu page shows once, as the page.
  const pageHrefs = new Set(pageGroup?.hits.map((hit) => hit.href) ?? []);
  const serverGroups: Group[] = (res?.groups ?? []).map((group: SearchGroup) => ({
    ...group,
    hits: group.hits.filter((hit) => !(PAGE_TYPES.has(hit.type) && pageHrefs.has(hit.href))),
  }));
  const groups: Group[] = searching
    ? [
        ...(actionGroup ? [actionGroup] : []),
        ...(pageGroup ? [pageGroup] : []),
        ...serverGroups,
      ].filter((group) => group.hits.length > 0)
    : recentHits?.length
      ? [{ type: "recent", labelKey: "recent", hits: recentHits }]
      : [];
  const total = groups.reduce((sum, group) => sum + group.hits.length, 0);
  const flat: Hit[] = groups.flatMap((g) => g.hits);
  const groupStarts = groups.reduce<number[]>(
    (starts, group, index) => [
      ...starts,
      index === 0 ? 0 : starts[index - 1]! + groups[index - 1]!.hits.length,
    ],
    [],
  );
  // Words the server read as structure (a scope, an amount, a date) are not
  // what a hit matched, so only the remaining words are marked.
  const words = useMemo(
    () => matchedQueryWords(pageQuery, res && res.q === pageQuery ? (res.chips ?? []) : []),
    [pageQuery, res],
  );
  const activeHit = flat[active];
  const optionId = (index: number) => `${listId}-option-${index}`;

  // ⌘K / Ctrl+K focuses the search from anywhere, typing included, and "/"
  // does outside text fields. The header can mount more than one search
  // (desktop inline, mobile overlay); only a rendered one takes them.
  const focusSearch = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  };
  const rendered = () => (inputRef.current?.getClientRects().length ?? 0) > 0;
  useShortcuts([
    {
      id: "search",
      label: () => tShortcuts("search"),
      binding: { modifier: "primary", code: "KeyK" },
      scope: "global",
      allowInEditable: true,
      enabled: rendered,
      run: focusSearch,
    },
    {
      id: "search-slash",
      label: () => tShortcuts("search"),
      binding: { character: "/" },
      scope: "global",
      allowInEditable: false,
      enabled: rendered,
      run: focusSearch,
    },
  ]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        !inputRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Reset the results while the query changes, during render (same committed
  // values, no extra render).
  const [prevQ, setPrevQ] = useState(q);
  if (prevQ !== q) {
    setPrevQ(q);
    setActive(0);
    setFailed(false);
    if (q.trim().length < 2) {
      setRes(null);
      setLoading(false);
    } else {
      setLoading(true);
    }
  }

  // Debounced fetch.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        // A failed search is not an empty one: say so rather than showing
        // "no matches" for results that were never looked for.
        if (!r.ok) {
          setRes(null);
          setFailed(true);
          return;
        }
        setRes((await r.json()) as SearchResponse);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setRes(null);
          setFailed(true);
        }
      } finally {
        // A superseded search leaves the indicator to the one replacing it.
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  // Recently opened results, shown when the box opens empty. Pages resolve
  // here from the current menu; everything else resolves on the server under
  // the reader's current permissions, so nothing they can no longer open is
  // listed and every title is current.
  const showRecents = open && !searching;
  useEffect(() => {
    if (!showRecents) return;
    const stored = readRecents(recentScope);
    if (stored.length === 0) return;
    const pagesByHref = new Map(pageIndex.map((page) => [page.href, page]));
    const serverRefs = stored.filter((entry): entry is RecentRef => entry.type !== "page");
    const ctrl = new AbortController();
    (async () => {
      let resolved: SearchHit[] = [];
      if (serverRefs.length > 0) {
        try {
          const r = await fetch("/api/search/recent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refs: serverRefs }),
            signal: ctrl.signal,
          });
          if (r.status === 400) {
            // The stored references are not ones search issues (an older
            // format, or edited storage); forget them rather than resend them.
            writeRecents(
              recentScope,
              stored.filter((entry) => entry.type === "page"),
            );
          } else if (!r.ok) {
            setRecentFailed(true);
          } else {
            resolved = ((await r.json()) as { hits: SearchHit[] }).hits;
            setRecentFailed(false);
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          setRecentFailed(true);
        }
      }
      const byRef = new Map(resolved.map((hit) => [`${hit.type}:${hit.id}`, hit as Hit]));
      setRecentHits(
        stored.flatMap((entry): Hit[] => {
          if (entry.type === "page") {
            const page = pagesByHref.get(entry.id);
            return page ? [pageHit(page)] : [];
          }
          const hit = byRef.get(`${entry.type}:${entry.id}`);
          return hit ? [hit] : [];
        }),
      );
    })();
    return () => ctrl.abort();
  }, [showRecents, recentScope, pageIndex]);

  // The preview beside the active hit, on screens wide enough to show it.
  // Each record's preview is read once per open panel.
  const previews = useRef(new Map<string, Preview | null>());
  const [preview, setPreview] = useState<{ key: string; value: Preview | null } | null>(null);
  const previewKey =
    activeHit && PREVIEW_TYPES.has(activeHit.type) ? `${activeHit.type}:${activeHit.id}` : null;
  const showPreview = wide && open && Boolean(previewKey);
  useEffect(() => {
    if (!showPreview || !previewKey || !activeHit) return;
    const known = previews.current.get(previewKey);
    if (known !== undefined) {
      setPreview({ key: previewKey, value: known });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch("/api/search/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: activeHit.type, id: activeHit.id }),
          signal: ctrl.signal,
        });
        const value = r.ok ? ((await r.json()) as Preview) : null;
        previews.current.set(previewKey, value);
        setPreview({ key: previewKey, value });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPreview({ key: previewKey, value: null });
      }
    }, 90);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [showPreview, previewKey, activeHit]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setRes(null);
    setRecentHits(null);
    setRecentFailed(false);
    previews.current.clear();
    inputRef.current?.blur();
  }, []);

  function go(hit: Hit | undefined, options: { newTab?: boolean } = {}) {
    if (!hit) return;
    if (hit.type === "action") {
      close();
      void create(hit.id as GlobalCreateKey);
      return;
    }
    const entry: StoredRecent =
      hit.type === "page" ? { type: "page", id: hit.href } : { type: hit.type, id: hit.id };
    writeRecents(recentScope, rememberRecent(readRecents(recentScope), entry));
    if (options.newTab) {
      window.open(hit.href, "_blank", "noopener");
      return;
    }
    close();
    if (PAGE_TYPES.has(hit.type)) {
      router.push(hit.href as never);
      return;
    }
    router.push(
      (hit.type === "contact"
        ? relatedPartyHref(pathname, searchParams.toString(), hit.id)
        : hit.href) as never,
      { scroll: false },
    );
  }

  const pickOption = (index: number, newTab: boolean) => go(flat[index], { newTab });
  const seeAllInGroup = (groupIndex: number) => seeAll(groups[groupIndex]?.type);

  function seeAll(type?: string) {
    const term = q.trim();
    if (term.length < 2) return;
    close();
    router.push(searchResultsHref(term, type) as never);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      seeAll();
      return;
    }
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === "Tab" && groups.length > 1 && open) {
      // Tab moves between groups, so long result lists stay quick to cross.
      e.preventDefault();
      const current = groupStarts.findLastIndex((start) => start <= active);
      const next = (current + (e.shiftKey ? -1 : 1) + groups.length) % groups.length;
      setActive(groupStarts[next] ?? 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[active], { newTab: e.metaKey || e.ctrlKey });
    }
  }

  const showPanel = open && (searching || total > 0 || (showRecents && recentFailed));
  const chips = searching && res && res.q === pageQuery ? (res.chips ?? []) : [];
  return (
    <div className={cn("relative", className)}>
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400 dark:text-slate-500"
        />
        <input
          ref={inputRef}
          value={q}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && activeHit ? optionId(active) : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t("placeholder")}
          aria-label={t("ariaLabel")}
          className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-16 pl-9 text-sm text-slate-900 transition-colors placeholder:text-slate-400 hover:border-slate-300 focus:border-teal-400 focus:bg-white focus:ring-2 focus:ring-teal-500/20 focus:outline-none dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-teal-500 dark:focus:bg-slate-900"
        />
        <div className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center gap-1">
          {loading ? (
            <Loader2 size={14} className="animate-spin text-slate-400" />
          ) : q ? (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setRes(null);
                setFailed(false);
                inputRef.current?.focus();
              }}
              className="pointer-events-auto rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label={t("clear")}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600 sm:inline dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      {showPanel ? (
        <div
          ref={panelRef}
          className={cn(
            "absolute top-[calc(100%+6px)] left-0 z-50 flex max-h-[72vh] w-full min-w-[22rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900",
            // With the preview beside it the panel grows leftward from the
            // field's right edge, so it stays on screen.
            showPreview && "lg:right-0 lg:left-auto lg:w-[min(56rem,calc(100vw-2rem))]",
          )}
        >
          <SearchChips
            chips={chips}
            onRemove={(chip) => {
              setQ(withoutChip(q, chip));
              inputRef.current?.focus();
            }}
            className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-3 py-2 dark:border-slate-800"
          />
          <div className="flex min-h-0 flex-1">
            <div
              id={listId}
              role="listbox"
              aria-label={t("ariaLabel")}
              className="app-scroll min-h-0 min-w-0 flex-1 overflow-y-auto p-1.5"
            >
              {total > 0 ? (
                groups.map((group, groupIndex) => (
                  <div
                    key={group.type}
                    role="group"
                    aria-label={t(`groups.${group.labelKey}` as never)}
                    className="mb-1 last:mb-0"
                  >
                    <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
                      <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                        {t(`groups.${group.labelKey}` as never)}
                      </span>
                      {searching && group.more ? (
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => seeAllInGroup(groupIndex)}
                          className="text-[11px] font-medium text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {t("seeAllGroup")}
                        </button>
                      ) : null}
                    </div>
                    {group.hits.map((hit, hitIndex) => {
                      const myIdx = (groupStarts[groupIndex] ?? 0) + hitIndex;
                      const isActive = myIdx === active;
                      return (
                        <div
                          key={`${hit.type}-${hit.id}`}
                          id={optionId(myIdx)}
                          role="option"
                          aria-selected={isActive}
                          onMouseEnter={() => setActive(myIdx)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickOption(myIdx, e.metaKey || e.ctrlKey || e.button === 1);
                          }}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                            isActive
                              ? "bg-teal-50 dark:bg-teal-950/50"
                              : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
                          )}
                        >
                          <SearchHitContent hit={hit} words={words} active={isActive} />
                          {isActive ? (
                            <CornerDownLeft
                              size={13}
                              className="shrink-0 text-teal-500 dark:text-teal-400"
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : loading ? (
                <div aria-busy="true" className="space-y-1 p-1">
                  {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                      <span className="h-7 w-7 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
                      <span className="flex-1 space-y-1.5">
                        <span className="block h-3 w-2/5 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
                        <span className="block h-2.5 w-3/5 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
                      </span>
                    </div>
                  ))}
                  <span className="sr-only">{t("searching")}</span>
                </div>
              ) : failed || (!searching && recentFailed) ? (
                <div
                  role="alert"
                  className="px-3 py-6 text-center text-sm text-amber-700 dark:text-amber-300"
                >
                  {searching ? t("failed") : t("recentFailed")}
                </div>
              ) : (
                <div className="px-3 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                  <p>{t("noMatches", { query: q.trim() })}</p>
                  <SearchTips className="mt-3" />
                </div>
              )}
            </div>
            {showPreview ? (
              <SearchPreviewPane
                preview={preview && preview.key === previewKey ? preview.value : undefined}
                hit={activeHit}
                onOpen={(newTab) => go(activeHit, { newTab })}
              />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>
                <kbd className="font-sans">↑↓</kbd> {t("navigate")}
              </span>
              {groups.length > 1 ? (
                <span>
                  <kbd className="font-sans">tab</kbd> {t("nextGroup")}
                </span>
              ) : null}
              <span>
                <kbd className="font-sans">↵</kbd> {t("open")}
              </span>
              <span className="hidden sm:inline">
                <kbd className="font-sans">⌘↵</kbd> {t("newTab")}
              </span>
              <span>
                <kbd className="font-sans">esc</kbd> {t("close")}
              </span>
            </span>
            {searching ? (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => seeAll()}
                className="inline-flex shrink-0 items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                {t("seeAll")} <kbd className="font-sans">⇧↵</kbd>
              </button>
            ) : null}
          </div>
          <span className="sr-only" aria-live="polite">
            {searching && !loading ? t("resultCount", { count: total }) : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Ways to ask, shown when nothing matched. */
export function SearchTips({ className }: { className?: string }) {
  const t = useTranslations("shell.globalSearch.tips");
  const examples = ["number", "amount", "range", "period", "status", "exact"] as const;
  return (
    <div className={cn("mx-auto max-w-sm text-left", className)}>
      <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
        {t("title")}
      </p>
      <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        {examples.map((example) => (
          <li key={example} className="flex items-baseline gap-2">
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {t(`${example}.example`)}
            </code>
            <span className="text-slate-500 dark:text-slate-400">{t(`${example}.label`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The active hit's facts, beside the results on wide screens. */
function SearchPreviewPane({
  preview,
  hit,
  onOpen,
}: {
  /** undefined while loading; null when the record has no preview. */
  preview: Preview | null | undefined;
  hit: Hit | undefined;
  onOpen: (newTab: boolean) => void;
}) {
  const t = useTranslations("shell.globalSearch.preview");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  if (!hit) return null;
  const value = (field: Preview["fields"][number]) =>
    field.kind === "date"
      ? formatCivilDate(field.value, locale)
      : field.kind === "status"
        ? statusLabel(
            field.value,
            (key) => tCommon(key as never),
            (key) => tCommon.has(key as never),
          )
        : field.value;
  return (
    <aside
      aria-label={t("label")}
      className="app-scroll hidden w-80 shrink-0 overflow-y-auto border-l border-slate-100 bg-slate-50/60 p-4 lg:block dark:border-slate-800 dark:bg-slate-950/40"
    >
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{hit.title}</p>
      {hit.subtitle ? (
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hit.subtitle}</p>
      ) : null}
      {hit.amount ? (
        <p className="mt-2 font-mono text-lg text-slate-900 tabular-nums dark:text-slate-100">
          {hit.amount}
        </p>
      ) : null}
      {preview === undefined ? (
        <div className="mt-4 space-y-2" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="h-3 animate-pulse rounded bg-slate-200/70 dark:bg-slate-800"
            />
          ))}
        </div>
      ) : preview ? (
        <>
          <dl className="mt-4 space-y-1.5 text-xs">
            {preview.fields.map((field) => (
              <div key={field.labelKey} className="flex justify-between gap-3">
                <dt className="shrink-0 text-slate-500 dark:text-slate-400">
                  {t(`fields.${field.labelKey}` as never)}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 truncate text-right text-slate-800 dark:text-slate-200",
                    field.kind === "money" && "font-mono tabular-nums",
                  )}
                  title={value(field)}
                >
                  {value(field)}
                </dd>
              </div>
            ))}
          </dl>
          {preview.lines?.length ? (
            <div className="mt-4">
              <p className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {t("lines")}
              </p>
              <ul className="space-y-1 text-xs">
                {preview.lines.map((line, index) => (
                  <li key={index} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                      {line.description}
                    </span>
                    <span className="shrink-0 font-mono text-slate-600 tabular-nums dark:text-slate-400">
                      {line.amount}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.lineCount && preview.lineCount > preview.lines.length ? (
                <p className="mt-1 text-[11px] text-slate-400">
                  {t("moreLines", { count: preview.lineCount - preview.lines.length })}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpen(false)}
          className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700"
        >
          {t("open")}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
        >
          {t("openNewTab")} <ArrowUpRight size={12} />
        </button>
      </div>
    </aside>
  );
}
