"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button, EmptyState } from "@openbooks/ui";
import { RecordTabs } from "../../../components/module-home/record-tabs";
import { SearchInput } from "../../../components/search-input";
import { SearchChips } from "../../../components/search-chips";
import { SearchTips, searchResultsHref } from "../../../components/global-search";
import { matchedQueryWords, SearchHitContent } from "../../../components/search-hit-content";
import { withoutChip } from "../../../lib/search-query";
import type { SearchChip, SearchHit, SearchType } from "../../../lib/search-types";
import type { SearchResultsTab } from "../../../lib/search-results";

/** The results page body: query box, reading chips, one tab per group, a page of hits. */
export function SearchResults({
  q,
  chips,
  tabs,
  active,
  hits,
  page,
  more,
}: {
  q: string;
  chips: SearchChip[];
  tabs: SearchResultsTab[];
  active: SearchType | null;
  hits: SearchHit[];
  page: number;
  more: boolean;
}) {
  const t = useTranslations("shell.globalSearch");
  const router = useRouter();
  const words = matchedQueryWords(q, chips);
  const pageHref = (target: number) => {
    const href = searchResultsHref(q, active ?? undefined);
    return target > 1 ? `${href}&page=${target}` : href;
  };
  const activeTab = tabs.find((tab) => tab.type === active);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        <SearchInput placeholder={t("placeholder")} size="md" className="max-w-2xl" />
        <SearchChips
          chips={chips}
          onRemove={(chip) =>
            router.push(searchResultsHref(withoutChip(q, chip), active ?? undefined) as never)
          }
          className="flex flex-wrap items-center gap-1.5"
        />
      </div>
      {q.trim().length < 2 ? (
        <EmptyState
          icon={<Search size={20} />}
          title={t("results.noQueryTitle")}
          description={t("results.noQueryDescription")}
          action={<SearchTips />}
        />
      ) : tabs.length === 0 ? (
        <EmptyState
          icon={<Search size={20} />}
          title={t("results.emptyTitle")}
          description={t("noMatches", { query: q.trim() })}
          action={<SearchTips />}
        />
      ) : (
        <RecordTabs
          label={t("results.tabsLabel")}
          active={active ?? tabs[0]!.type}
          tabs={tabs.map((tab) => ({
            key: tab.type,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {t(`groups.${tab.labelKey}` as never)}
                <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500 tabular-nums dark:bg-slate-800 dark:text-slate-400">
                  {tab.more ? t("results.countMore", { count: tab.count }) : tab.count}
                </span>
              </span>
            ),
          }))}
          onChange={(type) => router.push(searchResultsHref(q, type) as never)}
        >
          {hits.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              {t("results.emptyGroup", {
                group: activeTab ? t(`groups.${activeTab.labelKey}` as never) : "",
              })}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {hits.map((hit) => (
                <li key={`${hit.type}-${hit.id}`}>
                  <Link
                    href={hit.href as never}
                    className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-slate-50 focus-visible:bg-teal-50 focus-visible:outline-none dark:hover:bg-slate-800/60 dark:focus-visible:bg-teal-950/50"
                  >
                    <SearchHitContent hit={hit} words={words} dense={false} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {page > 1 || more ? (
            <nav
              aria-label={t("results.pagination")}
              className="mt-3 flex items-center justify-between text-sm text-slate-500 dark:text-slate-400"
            >
              <span>{t("results.page", { page })}</span>
              <span className="flex gap-2">
                {page > 1 ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={pageHref(page - 1) as never}>{t("results.previous")}</Link>
                  </Button>
                ) : null}
                {more ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={pageHref(page + 1) as never}>{t("results.next")}</Link>
                  </Button>
                ) : null}
              </span>
            </nav>
          ) : null}
        </RecordTabs>
      )}
    </div>
  );
}
