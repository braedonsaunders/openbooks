import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  table,
  text,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { pickString } from '../../../../lib/list-params'
import { NAV_GROUPS, NAV_MODULES } from '../../../../lib/nav/registry'
import { describeFields, type FieldDescriptor } from '../../../../lib/page-fields'
import { MissingSegmentError, PAGE_REGISTRY, PAGE_ROUTES } from '../../../../lib/page-registry'
import { listPageSpecs, loadPageSpec } from '../../../../lib/page-specs'
import { RENDER_REGISTRIES } from '../../../../components/viewspec/registries'
import type { PageSpec as Spec } from '@braedonsaunders/appkit-viewspec'

/**
 * Page Layouts — the human door onto the same customization the agent tools
 * and `/api/page-specs` already reach.
 *
 * Until now a stored layout could only be written by an agent or a raw HTTP
 * call, which meant the person accountable for what the org sees could not
 * look at it, let alone change or undo it. This is the list of every route
 * that can be customized and which ones are; the drawer is the editor.
 *
 * The permission is `admin.customization.manage` — the same authority that
 * governs form layouts and list views, because it is the same decision: what
 * a page looks like for everyone in the org.
 *
 * The drawer's contents come from running the target page's OWN loader, in
 * this request, under this caller's session. That is exactly what visiting
 * the page does minus the rendering, so a route this reader could not open
 * reports that instead of its layout — no escalation, and no separate
 * code path that could drift from what the page really does.
 */

const registries = RENDER_REGISTRIES

/** Nav label and group for a route, longest matching href first. */
const NAV_BY_HREF = [...NAV_MODULES]
  .sort((a, b) => b.href.length - a.href.length)
const GROUP_LABEL = new Map(NAV_GROUPS.map((group) => [group.key, group.label]))

function locate(route: string): { module: string; group: string } {
  const match = NAV_BY_HREF.find((item) => route === item.href || route.startsWith(`${item.href}/`))
  // A route with no nav entry is not mislabelled with itself — the Route
  // column already says that, and repeating it reads as a real module name.
  if (!match) return { module: '—', group: '' }
  const group = GROUP_LABEL.get(match.group)
  return { module: match.label, group: group ? ` · ${group}` : '' }
}

export interface PageLayoutRow extends Record<string, unknown> {
  id: string
  route: string
  module: string
  group: string
  href: string
  statusLabel: string
  statusVariant: 'secondary' | 'success'
  customized: boolean
  updatedAt: string
  note: string
}

/** Everything the drawer needs about the one route being edited. */
export interface PageLayoutDrawerData {
  route: string
  /** The layout the app ships. Null when the loader would not run for us. */
  builtIn: Spec | null
  /** The stored layout this reader would get, or null for the built-in one. */
  override: Spec | null
  overrideId: string | null
  /** Whose layout it is: the org's, or this reader's own. */
  overrideScope: 'org' | 'user' | null
  /** Dot paths the loader output exposes, with samples. */
  fields: FieldDescriptor[]
  fieldsTruncated: boolean
  /** Set when the built-in layout could not be read, with the reason. */
  unavailable: string | null
  requiredSegments: readonly string[]
  segments: Record<string, string>
}

export interface PageLayoutsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  statusFilterLabel: string
  statusOptions: { value: string; label: string }[]
  columnRoute: string
  columnModule: string
  columnStatus: string
  columnUpdated: string
  columnNote: string
  emptyLabel: string
  summary: string
  rows: PageLayoutRow[]
  drawerOpen: boolean
  drawer: PageLayoutDrawerData | null
}

/**
 * Read a route's built-in layout and bindable fields by running its loader.
 *
 * Every failure mode is an ANSWER rather than an exception. A page can
 * legitimately redirect (a permission this reader lacks, a feature the org has
 * off), answer not-found, or need a record id this screen has no way to guess;
 * none of those are broken, and all of them are things the editor must be able
 * to say out loud instead of showing an error.
 *
 * Next signals redirect and not-found by THROWING, with the reason only in the
 * error's `digest`. Left uncaught here they would redirect the admin screen
 * itself — the reader would be bounced to `/admin/setup/features` for asking
 * about a gated page.
 */
async function readLayout(
  route: string,
  segments: Record<string, string>,
  orgId: string,
  userId: string,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<PageLayoutDrawerData> {
  const entry = PAGE_REGISTRY[route]!
  // The reader's own layout wins here exactly as it does at render, so the
  // editor opens on the layout they are actually looking at.
  const stored = await loadPageSpec(orgId, route, registries, userId)
  const base: PageLayoutDrawerData = {
    route,
    builtIn: null,
    override: stored?.spec ?? null,
    overrideId: stored?.id ?? null,
    overrideScope: stored?.scope ?? null,
    fields: [],
    fieldsTruncated: false,
    unavailable: null,
    requiredSegments: entry.segments,
    segments,
  }

  const module = await entry.module()
  let data: object | null
  try {
    data = await module.load({ params: segments })
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      return { ...base, unavailable: t('unavailable.segment', { segment: error.segment }) }
    }
    const digest = (error as { digest?: unknown } | null)?.digest
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      // The destination is fact; the cause is not. A permission and a disabled
      // feature both redirect, and naming the wrong one sends the reader
      // looking in the wrong place.
      return { ...base, unavailable: t('unavailable.redirect', { href: digest.split(';')[2] ?? '' }) }
    }
    if (typeof digest === 'string' && (digest.startsWith('NEXT_HTTP_ERROR_FALLBACK') || digest === 'NEXT_NOT_FOUND')) {
      return { ...base, unavailable: t('unavailable.notFound') }
    }
    throw error
  }
  if (data === null) return { ...base, unavailable: t('unavailable.empty') }

  const catalog = describeFields(data)
  return { ...base, builtIn: module.spec(data), fields: catalog.fields, fieldsTruncated: catalog.truncated }
}

export async function loadPageLayouts(
  sp: Record<string, string | string[] | undefined>,
): Promise<PageLayoutsData> {
  const authz = await requirePermission('admin.customization.manage')
  const t = await getTranslations('admin.pageLayouts')
  const tHub = await getTranslations('admin.hub')

  // The org's layouts plus this reader's own — never a colleague's, which is
  // nobody else's business.
  const stored = await listPageSpecs(authz.user.orgId, authz.user.id)
  const byRoute = new Map(stored.map((row) => [row.route, row]))

  const search = (pickString(sp.q) ?? '').trim().toLowerCase()
  const status = pickString(sp.status) ?? ''

  const rows: PageLayoutRow[] = PAGE_ROUTES.map((route) => {
    const override = byRoute.get(route)
    const { module, group } = locate(route)
    return {
      id: route,
      route,
      module,
      group,
      href: `/admin/page-layouts?route=${encodeURIComponent(route)}`,
      statusLabel: override
        ? override.userId
          ? t('status.personal')
          : t('status.customized')
        : t('status.builtIn'),
      statusVariant: override ? ('success' as const) : ('secondary' as const),
      customized: Boolean(override),
      // Formatted here, never in the spec: a spec binds resolved values.
      updatedAt: override ? new Date(override.updatedAt).toISOString().slice(0, 10) : '',
      note: override?.note ?? '',
    }
  })
    .filter((row) => (status === 'customized' ? row.customized : status === 'builtIn' ? !row.customized : true))
    .filter((row) =>
      search === ''
        ? true
        : row.route.toLowerCase().includes(search) || row.module.toLowerCase().includes(search),
    )

  // A route named in the query opens the editor. An unknown one simply does
  // not open it — there is nothing to edit, and the list is still useful.
  const route = pickString(sp.route) ?? ''
  const drawerRoute = PAGE_REGISTRY[route] ? route : null
  const segments: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (key.startsWith('param.') && typeof value === 'string') segments[key.slice('param.'.length)] = value
  }

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    currentParams: sp,
    statusFilterLabel: t('status.filter'),
    statusOptions: [
      { value: 'customized', label: t('status.customized') },
      { value: 'builtIn', label: t('status.builtIn') },
    ],
    columnRoute: t('columns.route'),
    columnModule: t('columns.module'),
    columnStatus: t('columns.status'),
    columnUpdated: t('columns.updated'),
    columnNote: t('columns.note'),
    emptyLabel: t('empty'),
    summary: t('summary', { customized: stored.length, total: PAGE_ROUTES.length }),
    rows,
    drawerOpen: drawerRoute !== null,
    drawer: drawerRoute
      ? await readLayout(drawerRoute, segments, authz.user.orgId, authz.user.id, t)
      : null,
  }
}

const f = ref<PageLayoutsData>()
const item = field
const rootF = rootRef<PageLayoutsData>()

const LINK = 'font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400'
const MUTED = 'text-sm text-slate-500'

export function pageLayoutsSpec(data: PageLayoutsData): PageSpec {
  return page({
    route: '/admin/page-layouts',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/admin/page-layouts',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusFilterLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        emptyRow: { text: f('emptyLabel'), colSpan: 5, className: MUTED },
        columns: [
          column(rootF('columnRoute'), link(item('route'), item('href'), LINK)),
          column(
            rootF('columnModule'),
            text(item('module'), { suffix: { field: item('group'), className: 'text-slate-400' } }),
          ),
          column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
          column(rootF('columnUpdated'), text(item('updatedAt'), { fallback: '—' })),
          column(rootF('columnNote'), text(item('note'), { fallback: '—' }), { className: MUTED }),
        ],
      }),
      widgetBlock('page-layout-summary', { text: data.summary }),
      widgetBlock('page-layout-drawer', { drawer: data.drawer }, f('drawerOpen')),
    ],
  })
}
