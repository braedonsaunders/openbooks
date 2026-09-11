import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, heading, page, pageHeader, pagination, ref, repeat, field, textBlock, widget, widgetBlock, type FieldRef, type PageSpec } from '@openbooks/viewspec'
import { parseListParams } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { listApps, listListings } from '../../../../lib/apps/store'

/**
 * The app library, split into a loader and a spec.
 *
 * Two mutually exclusive bodies chosen by two presence flags the LOADER
 * computes (the card grid; the empty/resultless note): `when` OMITS, so the
 * conditional pair gets one flag per side rather than the spec gaining a
 * negation. The same presence-not-branching rule the accounts page tests
 * with three bodies and the /apps launcher with four.
 *
 * Each card couples a plain `<code>` with the `InstallListingButton` client
 * component, so the whole card is one `ListingCard` component in
 * sections.tsx — placed per item by `repeat` with `unwrapped`, and shared
 * with the native path (which imports it back) so the two renders stay
 * byte-identical.
 *
 * GATES: the loader gates on `apps.manage` (the page refuses without it).
 * The `apps` feature gate lives on the /apps segment layout and is not
 * repeated here — the same split the /apps launcher documents. The word
 * "manage" is doing double duty: `requirePermission` gates the page,
 * `canManage` gates the docs button. They coincide (both key off
 * `apps.manage`), so one boolean serves both.
 */

export interface ListingCardRow {
  id: string
  listingId: string
  listingKey: string
  name: string
  versionLine: string
  description: string
  installed: boolean
  current: boolean
}

export interface AppsLibraryData {
  backHref: string
  backLabel: string
  title: string
  description: string
  docsHref: string
  docsLabel: string
  canManage: boolean
  searchPlaceholder: string
  hasCards: boolean
  empty: boolean
  cards: ListingCardRow[]
  emptyTitle: string
  emptyDescription: string
  total: number
  currentPage: number
  perPage: number
}

export async function loadAppsLibrary(
  sp: Record<string, string | string[] | undefined>,
): Promise<AppsLibraryData> {
  // Gate: the library refuses without `apps.manage`. The layout adds the
  // `apps` feature gate for the whole /apps segment, so the loader does
  // not repeat it here.
  const authz = await requirePermission('apps.manage')
  const t = await getTranslations('apps')
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 12,
    allowedSorts: ['name'] as const,
  })
  const [{ listings, total }, installedApps] = await Promise.all([
    listListings({
      query: params.q,
      page: params.page,
      perPage: params.perPage,
    }),
    listApps(authz.user.orgId),
  ])
  const installedByKey = new Map(installedApps.map((app) => [app.key, app]))
  // Past the gate the reader always holds `apps.manage`, so the docs action
  // always renders — but the flag stays a loader-resolved field (not a
  // literal) so the spec never hardcodes a permission outcome.
  const canManage = can(authz, 'apps.manage')

  return {
    backHref: '/apps',
    backLabel: t('title'),
    title: t('library.title'),
    description: t('library.description'),
    docsHref: '/docs/apps',
    docsLabel: t('actions.documentation'),
    canManage,
    searchPlaceholder: t('library.searchPlaceholder'),
    hasCards: listings.length > 0,
    empty: listings.length === 0,
    cards: listings.map((listing) => {
      const installed = installedByKey.get(listing.key)
      return {
        id: listing.id,
        listingId: listing.id,
        listingKey: listing.key,
        name: listing.name,
        versionLine: t('version', { version: listing.version }),
        description: listing.description || t('noDescription'),
        installed: Boolean(installed),
        current: installed?.version === listing.version,
      }
    }),
    emptyTitle: params.q ? t('library.noResults.title') : t('library.empty.title'),
    emptyDescription: params.q ? t('library.noResults.description') : t('library.empty.description'),
    total,
    currentPage: params.page,
    perPage: params.perPage,
  }
}

const f = ref<AppsLibraryData>()
const item = field

// Shared empty-note title/description blocks: the two note bodies (a search
// with no hits; a library with nothing published) differ only in their
// copy — the loader picks it, so neither the blocks nor the flag vary. The
// `<h2>` is a `heading`, not `text`: the native title is an <h2>.
function emptyNoteBody(when: FieldRef) {
  return {
    ...grid('flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700', [
      widgetBlock('library-empty-icon'),
      heading(2, f('emptyTitle'), 'font-medium text-slate-900 dark:text-slate-100'),
      textBlock(f('emptyDescription'), {
        className: 'mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400',
      }),
    ]),
    when,
  }
}

export function appsLibrarySpec(data: AppsLibraryData): PageSpec {
  return page({
    route: '/apps/library',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [
          widget('apps-launcher-button', {
            href: data.docsHref,
            label: data.docsLabel,
            icon: 'book',
            variant: 'outline',
            size: 'sm',
          }),
        ],
      }),
      widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
    ],
    body: [
      {
        ...repeat({
          items: f('cards'),
          itemKey: item('id'),
          className: 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3',
          unwrapped: true,
          blocks: [
            widgetBlock('listing-card', {
              listingId: item('listingId'),
              listingKey: item('listingKey'),
              name: item('name'),
              versionLine: item('versionLine'),
              description: item('description'),
              installed: item('installed'),
              current: item('current'),
            }),
          ],
        }),
        when: f('hasCards'),
      },
      emptyNoteBody(f('empty')),
      pagination({
        basePath: '/apps/library',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager sits flush under the grid — no `mt-3` spacer.
        bare: true,
      }),
    ],
  })
}
