import "server-only";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { getAuthz } from "../../../lib/authz";
import { pickString } from "../../../lib/list-params";
import { loadSearchResults, type SearchResultsPage } from "../../../lib/search-results";

/**
 * Search results, split into a loader and a spec.
 *
 * Everything the header search finds, one group at a time and read deeper
 * than the header shows. Ungated like the header search itself: every group
 * applies the reader's own permissions, Features switches and subsidiary
 * scope, so the page can only ever show what the reader could open.
 */

export interface SearchPageData extends SearchResultsPage {
  title: string;
  description: string;
}

export async function loadSearchPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<SearchPageData> {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  const t = await getTranslations("shell.globalSearch.results");
  const q = (pickString(sp.q) ?? "").slice(0, 200);
  const page = Number.parseInt(pickString(sp.page) ?? "1", 10);
  const results = await loadSearchResults(
    authz,
    q,
    pickString(sp.type) ?? null,
    Number.isFinite(page) ? page : 1,
  );
  return {
    ...results,
    title: t("title"),
    description: q.trim() ? t("description", { query: q.trim() }) : t("noQueryDescription"),
  };
}

const f = ref<SearchPageData>();

export function searchSpec(data: SearchPageData): PageSpec {
  return page({
    route: "/search",
    layout: "list",
    header: [pageHeader({ title: f("title"), description: f("description") })],
    body: [
      // One client surface owns the query box, the reading chips, the group
      // tabs and paging, which all navigate by URL.
      widgetBlock("search-results", {
        q: data.q,
        chips: data.chips,
        tabs: data.tabs,
        active: data.active,
        hits: data.hits,
        page: data.page,
        more: data.more,
      }),
    ],
  });
}
