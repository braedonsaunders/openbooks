import { notFound } from 'next/navigation'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { TAX_RETURN_PACKS } from '@openbooks/engine/src/seed-tax-forms.ts'
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { can, requirePermission } from '../../../../../lib/authz'
import { ShowInactivesToggle } from '../../../../../components/show-inactives-toggle'
import { SearchInput } from '../../../../../components/search-input'
import { Pagination } from '../../../../../components/pagination'
import { mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
import {
  SETUP_ENTITY_BY_KEY,
  toSnake,
  type SetupColumn,
  type SetupEntity,
  type SetupRefSource,
} from '../../../../../lib/setup/registry'
import { CompanyTab } from './CompanyTab'
import { CloseSetupPage } from './CloseSetupPage'
import { FxProviderPage } from './FxProviderPage'
import { NewSetupButton, SetupDrawer } from './SetupDrawer'
import { TaxReturnLibrary } from './TaxReturnLibrary'

export const dynamic = 'force-dynamic'

type RefOption = { value: string; label: string }

/** Distinct ref sources declared anywhere in this entity's columns or fields. */
function refSources(entity: SetupEntity): SetupRefSource[] {
  const set = new Set<SetupRefSource>()
  for (const c of entity.columns) if (c.ref) set.add(c.ref)
  for (const f of entity.fields) if (f.ref) set.add(f.ref)
  return [...set]
}

/** Postable accounts for the org, matching the company-settings pickers. */
async function loadAccounts(orgId: string): Promise<RefOption[]> {
  const r = (await db.execute(sql`
    select id, number, name from accounts
     where org_id = ${orgId} and not is_summary and is_active
     order by number nulls last, name`)) as any
  return r.rows.map((a: any) => ({
    value: a.id as string,
    label: `${a.number ? `${a.number} · ` : ''}${a.name}`,
  }))
}

/** Options for a setup-entity ref source (id + code/name label). */
async function loadEntityOptions(source: string, orgId: string): Promise<RefOption[]> {
  if (source === 'accounting-periods') {
    const periods = (await db.execute(sql`
      select id as value, name as label from accounting_periods
       where org_id = ${orgId} order by starts_on desc, period_number desc`)) as any
    return periods.rows as RefOption[]
  }
  if (source === 'items') {
    const items = (await db.execute(sql`
      select id as value,
             case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label
        from items where org_id = ${orgId} and is_active order by code nulls last, name`)) as any
    return items.rows as RefOption[]
  }
  const target = SETUP_ENTITY_BY_KEY.get(source)
  if (!target) return []
  const orgFilter = target.orgScoped ? sql` where org_id = ${orgId}` : sql``
  const customSegmentFilter = source === 'segment-definitions'
    ? (target.orgScoped ? sql` and source_kind = 'custom'` : sql` where source_kind = 'custom'`)
    : sql``
  // Only entities that declare a `code` field carry the column (e.g.
  // subsidiaries are name-only) — prefix the label with it when present.
  const labelExpr = target.fields.some((f) => f.key === 'code')
    ? sql.raw(`case when coalesce(code, '') <> '' then code || ' · ' || name else name end`)
    : sql.raw('name')
  const r = (await db.execute(sql`
    select id as value, ${labelExpr} as label
      from ${sql.raw(target.table)}${orgFilter}${customSegmentFilter}
     order by name`)) as any
  return r.rows as RefOption[]
}

async function loadRefOptions(
  entity: SetupEntity,
  orgId: string,
): Promise<Record<string, RefOption[]>> {
  const out: Record<string, RefOption[]> = {}
  for (const source of refSources(entity)) {
    out[source] = source === 'accounts' ? await loadAccounts(orgId) : await loadEntityOptions(source, orgId)
  }
  return out
}

function orderExpr(entity: SetupEntity): string {
  if (entity.orderBy) return entity.orderBy
  if (entity.naturalKey) return toSnake(entity.naturalKey)
  return entity.idColumn ?? 'id'
}

/** Render one table cell for a column, given the raw (snake-keyed) row. */
function renderCell(
  col: SetupColumn,
  row: Record<string, any>,
  refLabels: Record<string, Map<string, string>>,
  t: (k: string) => string,
) {
  const raw = row[toSnake(col.key)]
  switch (col.kind) {
    case 'badge-active':
      return (
        <Badge variant={raw ? 'success' : 'outline'}>
          {raw ? t('statusActive') : t('statusArchived')}
        </Badge>
      )
    case 'boolean':
      return raw ? t('yes') : '—'
    case 'percent':
      return raw == null || raw === '' ? '—' : `${Number(raw)}%`
    case 'number':
      return raw == null || raw === '' ? '—' : String(raw)
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

export default async function SetupEntityPage({
  params,
  searchParams,
}: {
  params: Promise<{ entity: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { entity: entityKey } = await params
  const authz = await requirePermission('admin.setup.manage')
  const { orgId } = authz.user
  const sp = await searchParams

  // Company & Accounting settings is a bespoke tab (not a registry entity).
  if (entityKey === 'company') return <CompanyTab orgId={orgId} />
  if (entityKey === 'period-close') {
    await requirePermission('periods.manage')
    return <CloseSetupPage orgId={orgId} actorId={authz.user.id} searchParams={sp} canReopen={can(authz, 'close.reopen')} />
  }
  if (entityKey === 'fx-provider') return <FxProviderPage orgId={orgId} />

  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!entity) notFound()

  const t = await getTranslations('admin.setup')
  const rowParam = typeof sp.row === 'string' ? sp.row : undefined
  const showInactive = pickString(sp.showInactive) === 'true'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const closeHref = mergeHref(`/admin/setup/${entity.key}`, sp, { row: undefined })

  const searchColumns = entity.columns.map((column) => sql`cast(${sql.raw(toSnake(column.key))} as text) ilike ${`%${list.q ?? ''}%`}`)
  const rowFilter = sql`where 1 = 1
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${entity.hasActive && !showInactive ? sql`and is_active` : sql``}
    ${list.q && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`
  const [rowsRes, countRes, refOptions, installedPackRows] = await Promise.all([
    db.execute(sql`
      select * from ${sql.raw(entity.table)} ${rowFilter}
       order by ${sql.raw(orderExpr(entity))}
       limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`) as any,
    db.execute(sql`select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`) as any,
    loadRefOptions(entity, orgId),
    entity.key === 'tax-return-forms'
      ? db.execute(sql`select code from tax_return_forms where org_id = ${orgId}`) as any
      : Promise.resolve({ rows: [] as { code: string }[] }),
  ])
  const rows = rowsRes.rows as Record<string, any>[]
  const total = Number(countRes.rows[0]?.n ?? 0)

  // Lookup maps for rendering ref columns.
  const refLabels: Record<string, Map<string, string>> = {}
  for (const [source, opts] of Object.entries(refOptions)) {
    refLabels[source] = new Map(opts.map((o) => [o.value, o.label]))
  }

  const idColumn = entity.idColumn ?? 'id'
  const open = rowParam
    ? rowParam === 'new'
      ? { creating: true, row: null as Record<string, any> | null, members: [] as string[] }
      : await (async () => {
          const selected = (await db.execute(sql`
            select * from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn)} = ${rowParam}
             ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             limit 1`)) as any
          const found = selected.rows[0] ?? null
          let members: string[] = []
          const multi = entity.fields.find((f) => f.kind === 'multiref')
          if (found && multi) {
            const m = (await db.execute(sql`
              select tax_code_id from tax_group_members where tax_group_id = ${found.id}`)) as any
            members = m.rows.map((x: any) => x.tax_code_id as string)
          }
          return { creating: false, row: found, members }
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
          </p>
        </div>
        <NewSetupButton entityKey={entity.key} label={t('new')} />
      </div>

      {entity.key === 'tax-return-forms' ? (
        <TaxReturnLibrary
          packs={TAX_RETURN_PACKS.map(({ code, name, country }) => ({ code, name, country }))}
          installedCodes={installedPackRows.rows.map((row: { code: string }) => row.code)}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('searchPlaceholder')} />
        {entity.hasActive ? (
          <ShowInactivesToggle basePath={`/admin/setup/${entity.key}`} currentParams={sp} />
        ) : null}
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
                    {i === 0 ? (
                      <Link
                        href={`/admin/setup/${entity.key}?row=${row[idColumn]}`}
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

      <Pagination
        basePath={`/admin/setup/${entity.key}`}
        currentParams={sp}
        total={total}
        page={list.page}
        perPage={list.perPage}
      />

      {open ? (
        <SetupDrawer
          entity={entity}
          row={open.row}
          members={open.members}
          refOptions={refOptions}
          closeHref={closeHref}
        />
      ) : null}
    </div>
  )
}
