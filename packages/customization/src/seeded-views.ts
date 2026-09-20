import { DEFAULT_PER_PAGE, type ListViewConfig, type RecordTypeMeta } from "./types";

/**
 * Untouched-seeded system defaults — the employees-Z→A defect class.
 *
 * The provisioning seed stores `defaultListView(recordType)` as a frozen JSON
 * snapshot. Orgs seeded before the registry declared a default sort carry the
 * old fallback direction forever, so registry fixes never reach them.
 *
 * An org default nobody edited must therefore resolve to the LIVE registry
 * default at request time; one somebody edited in the list designer keeps its
 * edits exactly. Untouched requires BOTH of these, because a human edit
 * changes at least one of them:
 *
 *   metadata rule — the row was never re-saved through the designer:
 *     1. `SEEDED_DEFAULT_MARK` in the stored config. The seed writes it;
 *        every designer write parses through `parseListView` (zod `z.object`
 *        strips unknown keys), so any save through the API drops it.
 *     2. `created_at = updated_at` for rows seeded before the mark existed.
 *        The seed inserts and (conditionally) updates in ONE transaction, and
 *        `now()` is transaction-scoped, so an untouched seeded row has
 *        identical timestamps. Any designer PATCH stamps `updated_at = now()`
 *        in a later transaction, which can never equal `created_at` again.
 *
 *   shape rule — the stored config still looks seed-made: filters empty,
 *   perPage at the seed default, and no surviving column carrying a
 *   labelOverride, width, or visibility that departs from the current
 *   registry default. Extra or missing columns are allowed: that is registry
 *   drift (custom fields, retired built-ins), not an edit. The stored SORT is
 *   deliberately not compared: the frozen seed's stale direction IS the
 *   defect, and a sort-only edit through the designer is already caught by
 *   the metadata rule (it bumps updated_at and strips the mark).
 *
 * User-scoped views are never system defaults, whatever their timestamps.
 */

/** Config-level key the seed stamps on a provisioned org default view. */
export const SEEDED_DEFAULT_MARK = "seededDefault";

export interface SeededViewRow {
  scope: "org" | "user" | string;
  config: unknown;
  /** Optional on the row type: a caller that did not select the stamps
   *  cannot prove untouched, so the rule fails closed to "edited". */
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function timestampsEqual(createdAt: SeededViewRow["createdAt"], updatedAt: SeededViewRow["updatedAt"]): boolean {
  if (createdAt == null || updatedAt == null) return false;
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  const updated = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  return Number.isFinite(created) && created === updated;
}

function metadataUntouched(row: SeededViewRow): boolean {
  const config = row.config as Record<string, unknown> | null | undefined;
  // A marked row was written by the seed and never re-saved through the
  // designer (whose parse strips the mark): untouched, no heuristic needed.
  if (config != null && typeof config === "object" && config[SEEDED_DEFAULT_MARK] === true)
    return true;
  // Rows seeded before the mark existed: the seed's insert and update share
  // one transaction's now(), so equal timestamps mean untouched.
  return timestampsEqual(row.createdAt, row.updatedAt);
}

/**
 * True when the stored config still looks seed-made: empty filters, perPage
 * at the seed default, and every surviving column at its registry default
 * visibility, width, and label. Pure: the stored JSON plus the registry meta
 * are the only inputs.
 */
export function configMatchesSeedShape(
  config: unknown,
  meta: Pick<RecordTypeMeta, "listColumns">,
): boolean {
  if (config == null || typeof config !== "object" || Array.isArray(config)) return false;
  const view = config as Record<string, unknown>;
  if (!Array.isArray(view.filters) || view.filters.length !== 0) return false;
  if (view.perPage != null && view.perPage !== DEFAULT_PER_PAGE) return false;
  if (!Array.isArray(view.columns)) return false;
  const registry = new Map(meta.listColumns.map((column) => [column.key, column]));
  for (const placement of view.columns) {
    if (placement == null || typeof placement !== "object" || Array.isArray(placement)) return false;
    const stored = placement as Record<string, unknown>;
    const registered = registry.get(stored.key as string);
    // Extra columns are registry drift (custom fields, retired built-ins),
    // not an edit — only surviving columns are compared.
    if (!registered) continue;
    if (stored.visible !== !registered.defaultHidden) return false;
    if ((stored.width ?? null) !== (registered.defaultWidth ?? null)) return false;
    if (stored.labelOverride != null) return false;
  }
  return true;
}

/**
 * True when this org default row is a seeded snapshot nobody edited — so the
 * caller must substitute the live registry default (`defaultListView` at
 * request time) instead of the stored config. Pure: the row plus the registry
 * meta are the only inputs, so unit tests pin the rule without a database.
 * Without registry meta there is no shape evidence, so it fails closed.
 */
export function isUntouchedSeededView(row: SeededViewRow, meta?: Pick<RecordTypeMeta, "listColumns"> | null): boolean {
  if (row.scope !== "org") return false;
  if (!meta) return false;
  return metadataUntouched(row) && configMatchesSeedShape(row.config, meta);
}

/** Stamp a fresh registry default as seed-owned (provisioning path only). */
export function markSeededDefaultView(config: ListViewConfig): ListViewConfig {
  return { ...config, [SEEDED_DEFAULT_MARK]: true } as ListViewConfig;
}

/** Drop the seed mark so the effective view is a clean registry shape. */
export function stripSeededDefaultMark<T>(config: T): T {
  if (config == null || typeof config !== "object" || Array.isArray(config)) return config;
  const next = { ...(config as Record<string, unknown>) };
  delete next[SEEDED_DEFAULT_MARK];
  return next as T;
}
