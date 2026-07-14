// Parse common list query params (?q=&sort=&dir=&page=&perPage=) from the
// `searchParams` Next.js gives App-Router pages.
//
// We treat the query string as the canonical state for list filters. That
// way refreshes / shared links work, and we don't need client state for
// the list shell.

type ListParams<S extends string = string> = {
  q: string | undefined
  sort: S
  dir: 'asc' | 'desc'
  page: number
  perPage: number
}

type Search = Record<string, string | string[] | undefined>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when `value` is a UUID. Use to guard `[id]` route params before querying
 * a uuid PK — a non-UUID segment (e.g. a stale `/new` path) otherwise throws a
 * Postgres "invalid input syntax for type uuid" error instead of a clean 404.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function parseListParams<S extends string>(
  searchParams: Search,
  config: { sort: S; dir?: 'asc' | 'desc'; perPage?: number; allowedSorts: readonly S[] },
): ListParams<S> {
  const q = pickString(searchParams.q)
  const rawSort = pickString(searchParams.sort)
  const sort = config.allowedSorts.includes(rawSort as S) ? (rawSort as S) : config.sort
  const dir =
    pickString(searchParams.dir) === 'asc'
      ? 'asc'
      : pickString(searchParams.dir) === 'desc'
        ? 'desc'
        : (config.dir ?? 'desc')
  const page = clamp(Number(pickString(searchParams.page) ?? '1'), 1, 10_000)
  const perPage = clamp(
    Number(pickString(searchParams.perPage) ?? String(config.perPage ?? 25)),
    5,
    100,
  )
  return { q: q && q.length ? q : undefined, sort, dir, page, perPage }
}

/**
 * Parse a list that shares its route with other independently paged lists.
 * `prefix="review"` reads reviewQ/reviewSort/reviewDir/reviewPage/reviewPerPage,
 * keeping one sub-list's controls from resetting another one.
 */
export function parsePrefixedListParams<S extends string>(
  searchParams: Search,
  prefix: string,
  config: { sort: S; dir?: 'asc' | 'desc'; perPage?: number; allowedSorts: readonly S[] },
): ListParams<S> {
  return parseListParams(
    {
      q: searchParams[`${prefix}Q`],
      sort: searchParams[`${prefix}Sort`],
      dir: searchParams[`${prefix}Dir`],
      page: searchParams[`${prefix}Page`],
      perPage: searchParams[`${prefix}PerPage`],
    },
    config,
  )
}

export function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0]
  return v
}

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function buildHref(
  base: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const q = usp.toString()
  return q ? `${base}?${q}` : base
}

export function mergeHref(
  base: string,
  current: Search,
  overrides: Record<string, string | number | undefined | null>,
): string {
  const merged: Record<string, string | number | undefined | null> = {}
  for (const [k, v] of Object.entries(current)) {
    merged[k] = pickString(v) ?? undefined
  }
  for (const [k, v] of Object.entries(overrides)) {
    merged[k] = v
  }
  return buildHref(base, merged)
}

/**
 * Build an export URL that carries the current list filters but drops
 * pagination params (export is always "all visible rows that match").
 *
 * Returned as `any` so callers can drop it directly into Next's typed-routes
 * `<Link href>` (typed-routes refuses string template literals at the type
 * level even though the runtime is fine with them).
 */
export function buildExportHref(base: string, current: Search): any {
  const merged: Record<string, string | number | undefined | null> = {}
  for (const [k, v] of Object.entries(current)) {
    if (k === 'page' || k === 'perPage') continue
    merged[k] = pickString(v) ?? undefined
  }
  return buildHref(base, merged)
}
