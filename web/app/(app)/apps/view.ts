import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, heading, page, pageHeader, pagination, ref, repeat, field, textBlock, widget, widgetBlock, type FieldRef, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { parseListParams } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { listApps } from '../../../lib/apps/store'

/**
 * The app launcher, split into a loader and a spec.
 *
 * Four mutually exclusive bodies chosen by four presence flags the LOADER
 * computes (the card grid; the no-results note; the virgin-tenant note; the
 * virgin-tenant note plus its CTA): `when` OMITS, so each conditional PAIR
 * gets its own flag rather than the spec gaining a negation. The same
 * presence-not-branching rule the accounts page tests with three bodies,
 * plus the fourth the CTA pair needs.
 *
 * Each card is a composite cell (a link over a header row plus two text
 * lines plus a footer affordance), so the whole card is one `AppLauncherCard`
 * component in sections.tsx — placed per item by `repeat` with `unwrapped`,
 * and shared with the native path. The loader resolves every href and label
 * the card needs; the spec binds flat per-item fields (one level deep is
 * all widget props resolve).
 *
 * The empty-note titles are `heading` blocks, not `text`: the native titles
 * are <h2>, and a text block renders a <p>.
 */

export interface AppLauncherCardRow {
  key: string
  href: string
  ariaLabel: string
  iconKey: string
  name: string
  versionLine: string
  description: string
  openLabel: string
}

export interface AppsLauncherData {
  title: string
  description: string
  searchPlaceholder: string
  docsHref: string
  docsLabel: string
  libraryHref: string
  libraryLabel: string
  canManage: boolean
  hasCards: boolean
  noResults: boolean
  emptyNoCta: boolean
  emptyWithCta: boolean
  cards: AppLauncherCardRow[]
  emptyTitle: string
  emptyDescription: string
  emptyActionLabel: string
  total: number
  currentPage: number
  perPage: number
}

export async function loadAppsLauncher(
  sp: Record<string, string | string[] | undefined>,
): Promise<AppsLauncherData> {
  // Gate: the launcher refuses without `apps.use`. The layout adds the
  // `apps` feature gate for the whole /apps segment, so the loader does
  // not repeat it here.
  const authz = await requirePermission('apps.use')
  const t = await getTranslations('apps')
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 12,
    allowedSorts: ['name'] as const,
  })
  const query = params.q?.toLocaleLowerCase()
  const allApps = await listApps(authz.user.orgId)
  const availableApps = allApps.filter((app) => app.status === 'installed' && app.activeVersionId)
  const installed = availableApps
    .filter((app) => !query || `${app.name} ${app.key} ${app.description ?? ''}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
  const total = installed.length
  const apps = installed.slice((params.page - 1) * params.perPage, params.page * params.perPage)
  const hasAnyInstalled = availableApps.length > 0
  const canManage = can(authz, 'apps.manage')

  return {
    title: t('title'),
    description: t('description'),
    searchPlaceholder: t('searchPlaceholder'),
    docsHref: '/docs/apps',
    docsLabel: t('actions.documentation'),
    libraryHref: '/apps/library',
    libraryLabel: t('actions.library'),
    canManage,
    hasCards: apps.length > 0,
    noResults: apps.length === 0 && hasAnyInstalled,
    emptyNoCta: apps.length === 0 && !hasAnyInstalled && !canManage,
    emptyWithCta: apps.length === 0 && !hasAnyInstalled && canManage,
    cards: apps.map((app) => ({
      key: app.key,
      // Keys are URL slugs; the native page encodes them the same way.
      href: `/apps/${encodeURIComponent(app.key)}`,
      ariaLabel: t('actions.openAria', { name: app.name }),
      iconKey: app.iconKey,
      name: app.name,
      versionLine: t('version', { version: app.version ?? '—' }),
      description: app.description || t('noDescription'),
      openLabel: t('actions.open'),
    })),
    emptyTitle: hasAnyInstalled ? t('noResults.title') : t('empty.title'),
    emptyDescription: hasAnyInstalled ? t('noResults.description') : t('empty.description'),
    emptyActionLabel: t('empty.action'),
    total,
    currentPage: params.page,
    perPage: params.perPage,
  }
}

const f = ref<AppsLauncherData>()
const item = field

// Shared empty-note title/description blocks: the three note bodies differ
// only in their presence flag and (for one) the trailing CTA.
function emptyNoteBody(when: FieldRef, data: AppsLauncherData, withCta: boolean) {
  return {
    ...grid('flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700', [
      widgetBlock('apps-empty-icon'),
      heading(2, f('emptyTitle'), 'font-medium text-slate-900 dark:text-slate-100'),
      textBlock(f('emptyDescription'), {
        className: 'mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400',
      }),
      ...(withCta
        ? [
            widgetBlock('apps-launcher-button', {
              href: data.libraryHref,
              label: data.emptyActionLabel,
              icon: 'library',
              size: 'sm',
              className: 'mt-4',
            }),
          ]
        : []),
    ]),
    when,
  }
}

export function appsLauncherSpec(data: AppsLauncherData): PageSpec {
  return page({
    route: '/apps',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget('apps-launcher-button', {
            href: data.docsHref,
            label: data.docsLabel,
            icon: 'book',
            variant: 'outline',
            size: 'sm',
          }),
          widget(
            'apps-launcher-button',
            { href: data.libraryHref, label: data.libraryLabel, icon: 'library' },
            f('canManage'),
          ),
        ],
      }),
      widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
    ],
    body: [
      {
        ...repeat({
          items: f('cards'),
          itemKey: item('key'),
          className: 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3',
          unwrapped: true,
          blocks: [
            widgetBlock('app-launcher-card', {
              href: item('href'),
              ariaLabel: item('ariaLabel'),
              iconKey: item('iconKey'),
              name: item('name'),
              versionLine: item('versionLine'),
              description: item('description'),
              openLabel: item('openLabel'),
            }),
          ],
        }),
        when: f('hasCards'),
      },
      emptyNoteBody(f('noResults'), data, false),
      emptyNoteBody(f('emptyNoCta'), data, false),
      emptyNoteBody(f('emptyWithCta'), data, true),
      pagination({
        basePath: '/apps',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager sits flush under the grid — no `mt-3` spacer.
        bare: true,
      }),
    ],
  })
}
