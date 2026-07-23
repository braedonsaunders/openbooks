import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ShowInactivesToggle } from '../../../../../components/show-inactives-toggle'
import { SearchInput } from '../../../../../components/search-input'
import { Pagination } from '../../../../../components/pagination'
import { mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
import { setupEntityForFeatureState, toSnake, type SetupColumn, type SetupEntity } from '../../../../../lib/setup/registry'
import { loadRefOptions, orderExpr } from '../../../../../lib/setup/ref-options'
import { subsidiaryFeatureEnabled } from '../../../../../lib/features'
import { NewSetupButton, SetupDrawer } from './SetupDrawer'

/**
 * Registry-driven list + drawer for one configuration entity, mountable under
 * ANY base path (not just /admin/setup). The setup workspace, the Inventory
 * module, and the Items catalog all render the same generic CRUD surface —
 * only `basePath` changes, so search / pagination / drawer links stay local to
 * the host page. Reads the standard `q` / `showInactive` / `row` params.
 */

/** Render one table cell for a column, given the raw (snake-keyed) row. */
export function renderCell(
  col: SetupColumn,
  row: Record<string, any>,
  refLabels: Record<string, Map<string, string>>,
  t: (k: string) => string,
) {
  const raw = row[toSnake(col.key)]
  const option = col.options?.find((candidate) => candidate.value === String(raw))
  switch (col.kind) {
    case 'badge-active':
      return (
        <Badge variant={raw ? 'success' : 'outline'}>
          {raw ? t('statusActive') : t('statusArchived')}
        </Badge>
      )
    case 'badge':
      return (
        <Badge variant={raw === 'builtin' ? 'secondary' : 'default'}>
          {option ? t(option.labelKey) : raw == null || raw === '' ? '—' : String(raw)}
        </Badge>
      )
    case 'boolean':
      return raw ? t('yes') : '—'
    case 'percent':
      return raw == null || raw === '' ? '—' : `${Number(raw)}%`
    case 'number': {
      if (raw == null || raw === '') return '—'
      const num = Number(raw)
      // Locale-formatted, trailing zeros trimmed (1.7500 → 1.75, 40.0000 → 40).
      return Number.isFinite(num)
        ? num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
        : String(raw)
    }
    case 'date':
      return raw ? String(raw) : '—'
    case 'ref': {
      const label = col.ref ? refLabels[col.ref]?.get(String(raw)) : undefined
      return label ?? (raw ? String(raw) : '—')
    }
    case 'code':
      return raw ? <span className="font-mono text-xs">{String(raw)}</span> : '—'
    case 'text':
    default:
      return raw == null || raw === '' ? '—' : String(raw)
  }
}

export async function SetupEntitySection({
  entity: baseEntity,
  orgId,
  searchParams: sp,
  basePath,
  canManage,
}: {
  entity: SetupEntity
  orgId: string
  searchParams: Record<string, string | string[] | undefined>
  basePath: string
  canManage: boolean
}) {
  const entity = setupEntityForFeatureState(baseEntity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
  })
  const t = await getTranslations('admin.setup')
  const rowParam = typeof sp.row === 'string' ? sp.row : undefined
  const showInactive = pickString(sp.showInactive) === 'true'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const closeHref = mergeHref(basePath, sp, { row: undefined })

  const searchColumns = entity.columns.map(
    (column) => sql`cast(${sql.raw(toSnake(column.key))} as text) ilike ${`%${list.q ?? ''}%`}`,
  )
  const rowFilter = sql`where 1 = 1
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`

  const [rowsRes, countRes, refOptions] = await Promise.all([
    db.execute(sql`
      select * from ${sql.raw(entity.table)} ${rowFilter}
       order by ${sql.raw(orderExpr(entity))}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`) as any,
    db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`) as any,
    loadRefOptions(entity, orgId),
  ])
  const rows = rowsRes.rows as Record<string, any>[]
  const total = Number(countRes.rows[0]?.n ?? 0)

  const refLabels: Record<string, Map<string, string>> = {}
  for (const [source, opts] of Object.entries(refOptions)) {
    refLabels[source] = new Map(opts.map((o) => [o.value, o.label]))
  }

  const idColumn = entity.idColumn ?? 'id'
  const open = rowParam
    ? rowParam === 'new'
      ? { creating: true, row: null as Record<string, any> | null }
      : await (async () => {
          const selected = (await db.execute(sql`
            select * from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn)} = ${rowParam}
             ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             limit 1`)) as any
          return { creating: false, row: selected.rows[0] ?? null }
        })()
    : null

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t(`entities.${entity.key}.title`)}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t(`entities.${entity.key}.description`)}
            {entity.docSlug ? (
              <>
                {' '}
                <Link
                  href={`/docs/${entity.docSlug}`}
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t('learnMore')}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {canManage ? <NewSetupButton entityKey={entity.key} label={t('new')} basePath={basePath} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('searchPlaceholder')} />
        {entity.hasActive ? <ShowInactivesToggle basePath={basePath} currentParams={sp} /> : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              {entity.columns.map((c) => (
                <TableHead key={c.key}>{t(`fields.${c.key}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={entity.columns.length} className="text-slate-500 dark:text-slate-400">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => (
              <TableRow key={String(row[idColumn])}>
                {entity.columns.map((c, i) => (
                  <TableCell key={c.key}>
                    {i === 0 && canManage ? (
                      <Link
                        href={mergeHref(basePath, sp, { row: String(row[idColumn]) })}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {renderCell(c, row, refLabels, t)}
                      </Link>
                    ) : (
                      renderCell(c, row, refLabels, t)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pagination basePath={basePath} currentParams={sp} total={total} page={list.page} perPage={list.perPage} />

      {open && canManage ? (
        <SetupDrawer
          entity={entity}
          row={open.row}
          members={[]}
          refOptions={refOptions}
          closeHref={closeHref}
        />
      ) : null}
    </div>
  )
}
