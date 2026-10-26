/**
 * Equity workspace links. Every view of `/equity` is a URL view of one
 * route: the legal entity, the as-of date and a view's own filters travel
 * in the URL. A list's search, page and sort belong to the list they
 * narrow, so a link into another view never carries them: the stakeholder
 * search is not the securities search, and a page number past the end of a
 * shorter list would open it empty.
 */

/** Parameters owned by the list of the current view. */
export const EQUITY_LIST_PARAMS = ["q", "page", "sort", "dir"] as const;

export type EquityParams = Record<string, string | string[] | undefined>;

/**
 * The parameters a link keeps: the current ones with the overrides applied,
 * less the list's own state when the link opens a different view.
 */
export function equityLinkParams(
  params: EquityParams,
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value !== "") next[key] = value;
  }
  const currentView = next.view ?? "overview";
  const targetView = overrides.view === undefined ? currentView : overrides.view || "overview";
  if (targetView !== currentView) {
    for (const key of EQUITY_LIST_PARAMS) delete next[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  return next;
}

/** A link within the equity workspace (see {@link equityLinkParams}). */
export function equityHref(
  base: string,
  params: EquityParams,
  overrides: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams(equityLinkParams(params, overrides)).toString();
  return query ? `${base}?${query}` : base;
}

/** A list's sort from the URL: a column key, or the list's natural order. */
export interface EquityListSort {
  sort: string;
  dir: "asc" | "desc";
}

/** The natural order of a list: the order its reader returns, with every column offered for sorting. */
export const EQUITY_NATURAL_SORT = "default";

export function parseEquityListSort(
  sort: string | undefined,
  dir: string | undefined,
): EquityListSort {
  return {
    sort: sort && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(sort) ? sort : EQUITY_NATURAL_SORT,
    dir: dir === "desc" ? "desc" : "asc",
  };
}
