import 'server-only'
import { getTranslations } from 'next-intl/server'
import { can, type Authz } from './authz'
import { resolvedFeatureState } from './features'
import { visibleNavigationHref } from './nav/access'
import { searchPages, type PageSearchHit } from './nav/page-search'
import { setupRail, setupRailItemLabel } from './setup/rail'
import { setupRailFlags } from './setup/rail-flags'
import { searchDocArticles } from './feedback/knowledge'
import { getArticle } from './docs'
import { reportsHubFor } from '../app/(app)/reports/view'
import { visibleAdminHubGroups } from '../app/(app)/admin/view'
import type { RecentRef, SearchGroup, SearchHit } from './search-types'

/**
 * Global search over the product's own catalog: reports, settings and help.
 *
 * Nothing here is a second list. Reports are the Reports hub's cards for this
 * reader, settings are the Company Setup rail and the Administration hub
 * cards this reader can open, and help is the help centre's own article
 * search. Each is matched by the same name matcher the Pages group uses.
 */

const REPORT_LIMIT = 5
const SETTING_LIMIT = 6
const HELP_LIMIT = 4

type CatalogEntry = PageSearchHit & { type: 'report' | 'setting' }

async function catalogEntries(authz: Authz): Promise<CatalogEntry[]> {
  const features = await resolvedFeatureState(authz.user.orgId)
  const navigable = (href: string) =>
    visibleNavigationHref(href, (permission) => permission === undefined || can(authz, permission), features)
  const [t, tAdmin, reports] = await Promise.all([
    getTranslations(),
    getTranslations('admin'),
    // The Reports module is gated by reports.read at its layout; the hub's
    // own feature and entity gates then decide each card.
    can(authz, 'reports.read') && navigable('/reports')
      ? reportsHubFor(authz, { materialize: false })
      : Promise.resolve(null),
  ])
  const label = (key: string) => t(key as never)

  const entries: CatalogEntry[] = []
  for (const group of reports?.groups ?? []) {
    for (const card of group.cards) {
      entries.push({ type: 'report', href: card.href, title: card.title, trail: [group.label], iconKey: 'file' })
    }
  }

  const rail = setupRail(await setupRailFlags(authz, features))
  const setupTitle = label('admin.setup.title')
  for (const group of rail.groups) {
    for (const item of group.items) {
      entries.push({ type: 'setting', href: item.href, title: setupRailItemLabel(item, label), trail: [setupTitle, label(group.labelKey)], iconKey: 'settings' })
    }
  }
  for (const item of rail.data.items) {
    entries.push({ type: 'setting', href: item.href, title: setupRailItemLabel(item, label), trail: [label(rail.data.labelKey)], iconKey: 'settings' })
  }

  const adminTitle = tAdmin('hub.title')
  for (const group of visibleAdminHubGroups(authz, features, (key) => tAdmin(key as never))) {
    for (const card of group.cards) {
      entries.push({ type: 'setting', href: card.href, title: card.title, trail: [adminTitle, group.label], iconKey: 'settings' })
    }
  }

  // One entry per destination: a page reachable from two places (a hub card
  // and a rail link) is still one result.
  const byHref = new Map<string, CatalogEntry>()
  for (const entry of entries) if (!byHref.has(entry.href)) byHref.set(entry.href, entry)
  return [...byHref.values()]
}

function catalogHit(entry: CatalogEntry): SearchHit {
  return {
    id: entry.href,
    type: entry.type,
    title: entry.title,
    subtitle: entry.trail.length ? entry.trail.join(' › ') : undefined,
    href: entry.href,
    iconKey: entry.iconKey,
  }
}

function helpHit(slug: string): SearchHit | null {
  const article = getArticle(slug)
  if (!article) return null
  return {
    id: article.slug,
    type: 'help',
    title: article.title,
    subtitle: article.summary,
    href: `/docs/${article.slug}`,
    iconKey: 'circle-help',
  }
}

/** Reports, settings and help articles matching the query, as result groups. */
export async function searchCatalog(authz: Authz, rawQ: string): Promise<SearchGroup[]> {
  const q = rawQ.trim().slice(0, 80)
  if (q.length < 2) return []
  const entries = await catalogEntries(authz)
  const reports = searchPages(entries.filter((entry) => entry.type === 'report'), q, REPORT_LIMIT)
  const settings = searchPages(entries.filter((entry) => entry.type === 'setting'), q, SETTING_LIMIT)
  const help = searchDocArticles(q).slice(0, HELP_LIMIT).flatMap((hit) => {
    const resolved = helpHit(hit.id)
    return resolved ? [resolved] : []
  })
  const groups: SearchGroup[] = [
    { type: 'report', labelKey: 'reports', hits: reports.map((hit) => catalogHit({ ...hit, type: 'report' })) },
    { type: 'setting', labelKey: 'settings', hits: settings.map((hit) => catalogHit({ ...hit, type: 'setting' })) },
    { type: 'help', labelKey: 'help', hits: help },
  ]
  return groups.filter((group) => group.hits.length > 0)
}

const CATALOG_TYPES = new Set(['report', 'setting', 'help'])

export function isCatalogRecentRef(ref: RecentRef): boolean {
  return CATALOG_TYPES.has(ref.type)
}

/**
 * Re-resolve recently opened reports, settings and help articles. A report
 * or setting the reader can no longer open is absent from their catalog and
 * so resolves to nothing.
 */
export async function resolveRecentCatalog(authz: Authz, refs: readonly RecentRef[]): Promise<SearchHit[]> {
  const wanted = refs.filter(isCatalogRecentRef)
  if (wanted.length === 0) return []
  const needsCatalog = wanted.some((ref) => ref.type !== 'help')
  const byHref = new Map((needsCatalog ? await catalogEntries(authz) : []).map((entry) => [`${entry.type}:${entry.href}`, entry]))
  return wanted.flatMap((ref): SearchHit[] => {
    if (ref.type === 'help') {
      const hit = helpHit(ref.id)
      return hit ? [hit] : []
    }
    const entry = byHref.get(`${ref.type}:${ref.id}`)
    return entry ? [catalogHit(entry)] : []
  })
}
