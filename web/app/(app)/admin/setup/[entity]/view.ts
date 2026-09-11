import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { TAX_RETURN_PACKS } from '@openbooks/engine/src/seed-tax-forms.ts'
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  page,
  pagination,
  ref,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { resolvedFeatureState, featureEnabled } from '../../../../../lib/features'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
import {
  SETUP_ENTITY_BY_KEY,
  setupEntityForFeatureState,
  setupOptionLabel,
  toSnake,
  type SetupColumn,
  type SetupColumnKind,
} from '../../../../../lib/setup/registry'
import { resolveDynamicSetupOptions } from '../../../../../lib/setup/dynamic-options'
import { loadRefOptions, orderExpr } from '../../../../../lib/setup/ref-options'

/**
 * The generic setup-entity list, split into a loader and a spec.
 *
 * One spec serves every registry entity: the loader resolves the entity's
 * columns (translated headers + kinds) and every row's cells to
 * presentation-ready strings, and the spec builder maps the column
 * descriptors to `Column` specs. The emitted PageSpec is still pure data —
 * the mapping is spec construction, not a spec-level conditional.
 *
 * The drawer (with its nested sub-tabs and stacked child drawers) and the
 * three bespoke entity pages (company, period-close, fx-provider) arrive
 * through slots in `sections.tsx` that re-derive authz server-side: an org id
 * and row payloads are capabilities, not data, and never travel through a
 * spec. The spec carries only the entity key, the URL, and presence flags.
 */

const LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'
const MUTED = 'text-slate-500 dark:text-slate-400'

export interface SetupListColumn {
  key: string
  kind: SetupColumnKind
  header: string
}

export interface SetupListCell {
  display: string
  href: string | null
  badgeVariant: 'default' | 'secondary' | 'outline' | 'success' | null
  codeShown: boolean
}

export interface SetupListRow {
  id: string
  cells: Record<string, SetupListCell>
}

export interface SetupLibraryPack {
  code: string
  name: string
  country: string
}

export interface SetupEntityData {
  entityKey: string
  isCompany: boolean
  isPeriodClose: boolean
  isFxProvider: boolean
  isRegistryList: boolean
  canReopen: boolean
  currentParams: Record<string, string | string[] | undefined>
  title: string
  description: string
  docHref: string | null
  learnMore: string
  newLabel: string
  showLibrary: boolean
  libraryPacks: SetupLibraryPack[]
  libraryInstalled: string[]
  libraryOpen: boolean
  libraryOpenHref: string
  libraryCloseHref: string
  searchPlaceholder: string
  hasActiveToggle: boolean
  columns: SetupListColumn[]
  rows: SetupListRow[]
  emptyLabel: string
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
}

/** One table cell's presentation, resolved from the raw (snake-keyed) row. */
function cellDisplay(
  col: SetupColumn,
  row: Record<string, unknown>,
  refLabels: Record<string, Map<string, string>>,
  t: (k: string) => string,
): { display: string; badgeVariant: SetupListCell['badgeVariant'] } {
  const raw = row[toSnake(col.key)]
  const option = col.options?.find((candidate) => candidate.value === String(raw))
  if (option && col.kind !== 'badge') return { display: setupOptionLabel(option, t), badgeVariant: null }
  switch (col.kind) {
    case 'badge-active':
      return raw
        ? { display: t('statusActive'), badgeVariant: 'success' }
        : { display: t('statusArchived'), badgeVariant: 'outline' }
    case 'badge':
      return {
        display: option ? setupOptionLabel(option, t) : raw == null || raw === '' ? '—' : String(raw),
        badgeVariant: raw === 'builtin' ? 'secondary' : 'default',
      }
    case 'boolean':
      return { display: raw ? t('yes') : '—', badgeVariant: null }
    case 'percent':
      return { display: raw == null || raw === '' ? '—' : `${Number(raw)}%`, badgeVariant: null }
    case 'number': {
      if (raw == null || raw === '') return { display: '—', badgeVariant: null }
      const num = Number(raw)
      // Locale-formatted, trailing zeros trimmed (1.7500 → 1.75, 40.0000 → 40).
      return {
        display: Number.isFinite(num)
          ? num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
          : String(raw),
        badgeVariant: null,
      }
    }
    case 'date':
      return { display: raw ? String(raw) : '—', badgeVariant: null }
    case 'ref': {
      const label = col.ref ? refLabels[col.ref]?.get(String(raw)) : undefined
      return { display: label ?? (raw ? String(raw) : '—'), badgeVariant: null }
    }
    case 'code':
    case 'text':
    default:
      return { display: raw == null || raw === '' ? '—' : String(raw), badgeVariant: null }
  }
}

export async function loadSetupEntity(
  entityKey: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<SetupEntityData> {
  const authz = await requirePermission('admin.setup.manage')
  const { orgId } = authz.user

  const isCompany = entityKey === 'company'
  const isPeriodClose = entityKey === 'period-close'
  const isFxProvider = entityKey === 'fx-provider'

  // Bespoke tabs carry their own gates; the slots re-render the components.
  let canReopen = false
  if (isPeriodClose) {
    await requirePermission('periods.manage')
    canReopen = can(authz, 'close.reopen')
  }
  if (isFxProvider) {
    await requireFeatureEnabled(orgId, 'multiCurrency')
  }

  const assetSetupTabs: Record<string, string> = {
    'tax-regimes': 'regimes',
    'tax-pool-classes': 'classes',
    'tax-first-year-rules': 'first-year',
  }
  if (assetSetupTabs[entityKey]) {
    redirect(mergeHref('/admin/setup/tax-depreciation', sp, { tab: assetSetupTabs[entityKey] }))
  }
  const bookDepreciationTabs: Record<string, string> = {
    'depreciation-methods': 'methods',
    'depreciation-book-policies': 'books',
  }
  if (bookDepreciationTabs[entityKey]) {
    redirect(mergeHref('/admin/setup/depreciation', sp, { tab: bookDepreciationTabs[entityKey] }))
  }

  const baseEntity = isCompany || isPeriodClose || isFxProvider ? undefined : SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!isCompany && !isPeriodClose && !isFxProvider && (!baseEntity || baseEntity.nestedUnder || baseEntity.rehomed)) {
    notFound()
  }
  const features = await resolvedFeatureState(orgId)
  if (baseEntity?.featureKey && !featureEnabled(features, baseEntity.featureKey)) notFound()
  const entity = baseEntity
    ? resolveDynamicSetupOptions(setupEntityForFeatureState(baseEntity, {
        multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
        equipment: featureEnabled(features, 'equipment'),
        fieldTickets: featureEnabled(features, 'fieldTickets'),
      }))
    : null

  const t = await getTranslations('admin.setup')
  const isRegistryList = entity !== null

  const rowParam = typeof sp.row === 'string' ? sp.row : undefined
  const showInactive = pickString(sp.showInactive) === 'true'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })

  const searchColumns = entity
    ? entity.columns.map((c) => sql`cast(${sql.raw(toSnake(c.key))} as text) ilike ${`%${list.q ?? ''}%`}`)
    : []
  const rowFilter = entity
    ? sql`where 1 = 1
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`
    : sql``
  const [rowsRes, countRes, refOptions, installedPackRows] = entity
    ? await Promise.all([
        (db.execute(sql`
      select * from ${sql.raw(entity.table)} ${rowFilter}
       order by ${sql.raw(orderExpr(entity))}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`)),
        (db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`)),
        loadRefOptions(entity, orgId),
        entity.key === 'tax-return-forms'
          ? db.execute(sql`select code from tax_return_forms where org_id = ${orgId}`) as any
          : Promise.resolve({ rows: [] as { code: string }[] }),
      ])
    : [{ rows: [] }, { rows: [] }, {}, { rows: [] }]
  const rows = (rowsRes.rows)

  // Lookup maps for rendering ref columns.
  const refLabels: Record<string, Map<string, string>> = {}
  for (const [source, opts] of Object.entries(refOptions)) {
    refLabels[source] = new Map(opts.map((o) => [o.value, o.label]))
  }

  const idColumn = entity?.idColumn ?? 'id'

  return {
    entityKey,
    isCompany,
    isPeriodClose,
    isFxProvider,
    isRegistryList,
    canReopen,
    currentParams: sp,
    title: entity ? t(`entities.${entity.key}.title`) : '',
    description: entity ? t(`entities.${entity.key}.description`) : '',
    docHref: entity?.docSlug ? `/docs/${entity.docSlug}` : null,
    learnMore: t('learnMore'),
    newLabel: t('new'),
    showLibrary: entity?.key === 'tax-return-forms',
    libraryPacks: TAX_RETURN_PACKS.map(({ code, name, country }) => ({ code, name, country })),
    libraryInstalled: installedPackRows.rows.map((row: { code: string }) => row.code),
    libraryOpen: entity?.key === 'tax-return-forms' && pickString(sp.library) === 'true',
    libraryOpenHref: mergeHref('/admin/setup/tax-return-forms', sp, { library: 'true' }),
    libraryCloseHref: mergeHref('/admin/setup/tax-return-forms', sp, { library: undefined }),
    searchPlaceholder: t('searchPlaceholder'),
    hasActiveToggle: Boolean(entity?.hasActive),
    columns: (entity?.columns ?? []).map((c) => ({
      key: c.key,
      kind: c.kind,
      header: t(`fields.${c.key}`),
    })),
    rows: entity
      ? rows.map((row) => {
          const rowId = String(row[idColumn])
          const href = mergeHref(`/admin/setup/${entity.key}`, sp, { row: rowId })
          const cells: Record<string, SetupListCell> = {}
          for (const c of entity.columns) {
            const { display, badgeVariant } = cellDisplay(c, row, refLabels, t)
            cells[c.key] = {
              display,
              href,
              badgeVariant,
              codeShown: c.kind === 'code' && row[toSnake(c.key)] != null && row[toSnake(c.key)] !== '',
            }
          }
          return { id: rowId, cells }
        })
      : [],
    emptyLabel: t('empty'),
    total: Number((countRes.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
    currentPage: list.page,
    perPage: list.perPage,
    drawerOpen: isRegistryList && rowParam !== undefined,
  }
}

const f = ref<SetupEntityData>()
const item = field

/**
 * Build one table column from its loader-resolved descriptor. The first
 * column's cell always rides inside the row-drawer link; a badge-kind or
 * code-kind first column is a composite (badge/span inside the link) the
 * `link` cell cannot render, so those go through the sections.tsx cells.
 */
function setupColumn(col: SetupListColumn, isFirst: boolean) {
  const display = item(`cells.${col.key}.display`)
  const href = item(`cells.${col.key}.href`)
  if (isFirst) {
    switch (col.kind) {
      case 'badge-active':
      case 'badge':
        return column(
          col.header,
          widgetCell('setup-badge-link-cell', {
            label: display,
            variant: item(`cells.${col.key}.badgeVariant`),
            href,
          }),
        )
      case 'code':
        return column(
          col.header,
          widgetCell('setup-code-cell', {
            text: display,
            shown: item(`cells.${col.key}.codeShown`),
            href,
          }),
        )
      default:
        return column(col.header, link(display, href, LINK))
    }
  }
  switch (col.kind) {
    case 'badge-active':
    case 'badge':
      return column(col.header, badge(display, { variant: item(`cells.${col.key}.badgeVariant`) }))
    case 'code':
      return column(
        col.header,
        widgetCell('setup-code-cell', {
          text: display,
          shown: item(`cells.${col.key}.codeShown`),
        }),
      )
    default:
      return column(col.header, text(display))
  }
}

export function setupEntitySpec(data: SetupEntityData): PageSpec {
  return page({
    route: '/admin/setup/[entity]',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome.
    layout: 'bare',
    header: [],
    body: [
      {
        ...widgetBlock('setup-company', {}),
        when: f('isCompany'),
      },
      {
        ...widgetBlock('setup-close', { sp: data.currentParams, canReopen: data.canReopen }),
        when: f('isPeriodClose'),
      },
      {
        ...widgetBlock('setup-fx', {}),
        when: f('isFxProvider'),
      },
      {
        ...grid('space-y-4', [
          grid('flex items-start justify-between gap-3', [
            grid('min-w-0', [
              heading(2, f('title'), 'text-lg font-semibold text-slate-900 dark:text-slate-100'),
              widgetBlock('setup-description', {
                description: f('description'),
                docHref: f('docHref'),
                learnMore: data.learnMore,
              }),
            ]),
            grid('flex items-center gap-2', [
              widgetBlock(
                'tax-return-library',
                {
                  packs: data.libraryPacks,
                  installedCodes: data.libraryInstalled,
                  open: data.libraryOpen,
                  openHref: data.libraryOpenHref,
                  closeHref: data.libraryCloseHref,
                },
                f('showLibrary'),
              ),
              widgetBlock('new-setup-button', { entityKey: data.entityKey, label: data.newLabel }),
            ]),
          ]),
          grid('flex flex-wrap items-center gap-2', [
            widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
            widgetBlock(
              'show-inactives-toggle',
              {
                basePath: `/admin/setup/${data.entityKey}`,
                currentParams: data.currentParams,
              },
              f('hasActiveToggle'),
            ),
          ]),
          grid(
            'rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
            [
              table({
                variant: 'app',
                rows: f('rows'),
                rowKey: item('id'),
                emptyRow: { text: f('emptyLabel'), colSpan: data.columns.length, className: MUTED },
                columns: data.columns.map((col, index) => setupColumn(col, index === 0)),
              }),
            ],
          ),
          pagination({
            basePath: `/admin/setup/${data.entityKey}`,
            total: f('total'),
            page: f('currentPage'),
            perPage: f('perPage'),
            bare: true,
          }),
          widgetBlock(
            'setup-drawer',
            { entityKey: data.entityKey, sp: data.currentParams },
            f('drawerOpen'),
          ),
        ]),
        when: f('isRegistryList'),
      },
    ],
  })
}
