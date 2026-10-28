import "server-only";
import { withReadMemo } from "@openbooks/engine/platform/database";
import type { Authz } from "./authz";
import { globalSearch, parseQueryFor, resolveRecentCoreRecords } from "./search";
import { resolveRecentOperationalRecords, searchOperationalRecords } from "./search-records";
import { resolveRecentCatalog, searchCatalog } from "./search-catalog";
import type { RecentRef, SearchHit, SearchResponse } from "./search-types";

/**
 * The header search: core ledger records (contacts, transactions, accounts,
 * items, projects), then reports and settings, then operational records,
 * then help. Every source applies its own permission, Features and
 * subsidiary rules; this module only orders their groups. One search is one
 * read-only scope: the Features switches and data-dependent defaults every
 * source consults load once per keystroke, not once per source and leg.
 */
export async function searchEverything(authz: Authz, rawQ: string): Promise<SearchResponse> {
  const [core, records, catalog] = await withReadMemo(async () => {
    const parsed = rawQ.trim().length >= 2 ? await parseQueryFor(authz, rawQ) : null;
    // Reports, settings and help are found by name; a query that is all
    // structure ("$1,200", "overdue last month") names none.
    const structured = Boolean(parsed && (parsed.amount || parsed.dates || parsed.status));
    const catalogQuery = structured
      ? (parsed?.words.map((word) => word.text).join(" ") ?? "")
      : rawQ;
    return Promise.all([
      globalSearch(authz, rawQ),
      searchOperationalRecords(authz, rawQ, parsed ?? undefined),
      searchCatalog(authz, catalogQuery),
    ]);
  });
  const groups = [
    ...core.groups,
    ...catalog.filter((group) => group.type !== "help"),
    ...records,
    ...catalog.filter((group) => group.type === "help"),
  ];
  return {
    q: core.q,
    groups,
    total: groups.reduce((n, group) => n + group.hits.length, 0),
    chips: core.chips,
  };
}

/**
 * Resolve the reader's recently opened results, most recent first. Each
 * reference re-resolves through the source that produced it, so what comes
 * back is exactly what the reader may open now.
 */
export async function resolveRecent(
  authz: Authz,
  refs: readonly RecentRef[],
): Promise<SearchHit[]> {
  const [core, records, catalog] = await withReadMemo(() =>
    Promise.all([
      resolveRecentCoreRecords(authz, refs),
      resolveRecentOperationalRecords(authz, refs),
      resolveRecentCatalog(authz, refs),
    ]),
  );
  const byRef = new Map(
    [...core, ...records, ...catalog].map((hit) => [`${hit.type}:${hit.id}`, hit]),
  );
  return refs.flatMap((ref) => {
    const hit = byRef.get(`${ref.type}:${ref.id}`);
    return hit ? [hit] : [];
  });
}
