import "server-only";
import { withReadMemo } from "@openbooks/engine/platform/database";
import type { Authz } from "./authz";
import { globalSearch, parseQueryFor } from "./search";
import { searchEverything } from "./search-all";
import { searchCatalog } from "./search-catalog";
import { OPERATIONAL_RECORD_TYPES, searchOperationalRecords } from "./search-records";
import type { SearchChip, SearchHit, SearchType } from "./search-types";

/** Hits per results page. */
export const RESULTS_PAGE_SIZE = 25;

const CORE = new Set<string>(["contact", "transaction", "account", "item", "project"]);
const CATALOG = new Set<string>(["report", "setting", "help"]);

export interface SearchResultsTab {
  type: SearchType;
  labelKey: string;
  /** Hits the overview found, and whether more exist beyond them. */
  count: number;
  more: boolean;
}

export interface SearchResultsPage {
  q: string;
  chips: SearchChip[];
  tabs: SearchResultsTab[];
  active: SearchType | null;
  hits: SearchHit[];
  page: number;
  more: boolean;
}

/**
 * The full results page for a query: one tab per group the header search
 * finds, and a page of the active group read deeper than the header shows.
 * Every group comes from the same sources, fences and ranking as the
 * header search, so the page never shows what the panel would hide.
 */
export async function loadSearchResults(
  authz: Authz,
  rawQ: string,
  requestedType: string | null,
  page: number,
): Promise<SearchResultsPage> {
  const q = rawQ.trim();
  const empty: SearchResultsPage = {
    q,
    chips: [],
    tabs: [],
    active: null,
    hits: [],
    page: 1,
    more: false,
  };
  if (q.length < 2) return empty;
  return withReadMemo(async () => {
    const overview = await searchEverything(authz, q);
    const tabs: SearchResultsTab[] = overview.groups.map((group) => ({
      type: group.type,
      labelKey: group.labelKey,
      count: group.hits.length,
      more: Boolean(group.more),
    }));
    // Unless the reader picked a tab, open the group with the most hits: the
    // page exists to read deep, unlike the panel's best-guess first group.
    const fullest = [...tabs].sort(
      (a, b) => Number(b.more) - Number(a.more) || b.count - a.count,
    )[0];
    const active = (tabs.find((tab) => tab.type === requestedType) ?? fullest)?.type ?? null;
    if (!active) return { ...empty, chips: overview.chips ?? [] };
    const current = Math.max(1, Math.min(page, 40));
    const offset = (current - 1) * RESULTS_PAGE_SIZE;
    let hits: SearchHit[] = [];
    let more = false;
    if (CORE.has(active)) {
      const result = await globalSearch(authz, q, {
        types: [active],
        limit: RESULTS_PAGE_SIZE,
        offset,
      });
      const group = result.groups.find((candidate) => candidate.type === active);
      hits = group?.hits ?? [];
      more = Boolean(group?.more);
    } else if (OPERATIONAL_RECORD_TYPES.includes(active)) {
      const parsed = await parseQueryFor(authz, q);
      const [group] = await searchOperationalRecords(authz, q, parsed, {
        types: [active],
        limit: RESULTS_PAGE_SIZE,
        offset,
      });
      hits = group?.hits ?? [];
      more = Boolean(group?.more);
    } else if (CATALOG.has(active)) {
      const parsed = await parseQueryFor(authz, q);
      const structured = Boolean(parsed.amount || parsed.dates || parsed.status);
      const groups = await searchCatalog(
        authz,
        structured ? parsed.words.map((word) => word.text).join(" ") : q,
        { limit: 50 },
      );
      hits = groups.find((group) => group.type === active)?.hits ?? [];
    }
    return { q, chips: overview.chips ?? [], tabs, active, hits, page: current, more };
  });
}
