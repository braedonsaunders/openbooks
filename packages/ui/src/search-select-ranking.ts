/**
 * Ranking for typeahead pickers. A clerk who types "sta" means Staples, not
 * "Costa Rica Imports": matches are ordered by how strongly the typed text
 * anchors to the option, so the intended record is the highlighted one far
 * more often than with a plain substring filter.
 *
 * Tiers, strongest first:
 *   0  the label (or a keyword such as a vendor code) equals the query
 *   1  the label starts with the query
 *   2  a keyword (code, number, alias) starts with the query
 *   3  a word inside the label starts with the query ("edi" → "Consolidated Edison")
 *   4  every query word starts some label word, in any order ("adv sta")
 *   5  the label contains the query
 *   6  a keyword, hint or group contains the query
 *
 * Within a tier, more recently chosen options come first, then the original
 * order, so the caller's sort (alphabetical, account number) stays stable.
 */

export interface RankableOption {
  value: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

const WORD_BOUNDARY = /[\s\-_/.,:;()&·]+/;

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function words(text: string): string[] {
  return fold(text).split(WORD_BOUNDARY).filter(Boolean);
}

/** The match tier for one option, or null when it does not match at all. */
export function matchTier(option: RankableOption, rawQuery: string): number | null {
  const query = fold(rawQuery.trim());
  if (!query) return 0;
  const label = fold(option.label);
  const keywords = (option.keywords ?? []).map(fold);
  if (label === query || keywords.includes(query)) return 0;
  if (label.startsWith(query)) return 1;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 2;
  const labelWords = words(option.label);
  if (labelWords.some((word) => word.startsWith(query))) return 3;
  const queryWords = query.split(WORD_BOUNDARY).filter(Boolean);
  if (
    queryWords.length > 1 &&
    queryWords.every((part) => labelWords.some((word) => word.startsWith(part)))
  )
    return 4;
  if (label.includes(query)) return 5;
  const extra = [...keywords, fold(option.hint ?? ""), fold(option.group ?? "")];
  if (extra.some((text) => text.includes(query))) return 6;
  return null;
}

/**
 * Filter and order options for a query. `recent` lists values most-recent
 * first; it breaks ties inside a tier and never lifts a weaker match above a
 * stronger one.
 */
export function rankOptions<T extends RankableOption>(
  options: readonly T[],
  query: string,
  recent: readonly string[] = [],
): T[] {
  if (!query.trim()) return [...options];
  const recency = new Map(recent.map((value, index) => [value, index]));
  return options
    .map((option, index) => ({ option, index, tier: matchTier(option, query) }))
    .filter((entry): entry is { option: T; index: number; tier: number } => entry.tier !== null)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const ra = recency.get(a.option.value) ?? Number.POSITIVE_INFINITY;
      const rb = recency.get(b.option.value) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    })
    .map((entry) => entry.option);
}

/** True when some option's label or keyword equals the query exactly. */
export function hasExactMatch(options: readonly RankableOption[], query: string): boolean {
  const folded = fold(query.trim());
  if (!folded) return false;
  return options.some(
    (option) =>
      fold(option.label) === folded ||
      (option.keywords ?? []).some((keyword) => fold(keyword) === folded),
  );
}

const RECENT_LIMIT = 8;
const RECENT_PREFIX = "openbooks:recent-choices:";

/** Values recently chosen for a picker key, most recent first. */
export function readRecentChoices(key: string | undefined): string[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_PREFIX + key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Record a choice for a picker key. Storage failures (private mode, quota) are ignored. */
export function rememberRecentChoice(key: string | undefined, value: string): string[] {
  if (!key || !value || typeof window === "undefined") return [];
  const next = [value, ...readRecentChoices(key).filter((existing) => existing !== value)].slice(
    0,
    RECENT_LIMIT,
  );
  try {
    window.localStorage.setItem(RECENT_PREFIX + key, JSON.stringify(next));
  } catch {
    // Recency is a convenience; a storage refusal leaves the picker unranked.
  }
  return next;
}
