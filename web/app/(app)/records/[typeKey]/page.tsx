import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FormField } from '@openbooks/forms-core'
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { ShowInactivesToggle } from '../../../../components/show-inactives-toggle'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { can, requirePermission } from '../../../../lib/authz'
import {
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
  resolveEntityLabels,
} from '../../../../lib/records'
import {
  RECORD_STATUSES,
  formatFieldValue,
  isNumericField,
  lintRecordFields,
  listableFields,
} from '../../../../lib/record-schema'
import { NewRecordButton } from './NewRecordButton'
import { RecordDrawer } from './RecordDrawer'
import { getMoneyFormatter } from '../../../../lib/money-server'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  inactive: 'outline',
}

/**
 * The auto-generated module for one published record type: a full list view
 * (search over the precomputed search text, per-choice-field filters,
 * sortable data columns, pagination) with the instant-draft record flyout.
 */
export default async function RecordModule({
  params,
  searchParams,
}: {
  params: Promise<{ typeKey: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('records.read')
  const display = await getMoneyFormatter(authz.user.orgId)
  const t = await getTranslations('records')
  const tc = await getTranslations('common')
  const { typeKey } = await params
  const sp = await searchParams

  const type = await loadRecordTypeByKey(authz.user.orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(authz.user.roles.map(({ key }) => key), type.allowed_roles)) {
    notFound()
  }
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) notFound()
  const sections = lint.sections
  const canCreate = can(authz, 'records.create')

  const basePath = `/records/${typeKey}`
  const columns = listableFields(sections).slice(0, 5)
  const filterFields = columns
    .filter((f) => (f.type === 'select' || f.type === 'radio') && (f.validation?.options?.length ?? 0) > 0)
    .slice(0, 3)

  const listParams = parseListParams(sp, {
    sort: 'created',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['number', 'created', ...columns.map((f) => f.id)],
  })
  const status = pickString(sp.status)
  const showInactive = pickString(sp.showInactive) === 'true'
  const recId = typeof sp.rec === 'string' ? sp.rec : undefined

  const activeFieldFilters = filterFields
    .map((f) => ({ field: f, value: pickString(sp[`f_${f.id}`]) }))
    .filter((x): x is { field: FormField; value: string } => Boolean(x.value))

  const scope = sql`r.org_id = ${authz.user.orgId} and r.type_key = ${typeKey}`
  let where = sql`${scope}
    ${showInactive || status === 'inactive' ? sql`` : sql` and r.status <> 'inactive'`}
    ${status ? sql` and r.status = ${status}` : sql``}
    ${listParams.q ? sql` and (r.search_text ilike ${'%' + listParams.q.toLowerCase() + '%'} or r.record_number ilike ${'%' + listParams.q + '%'})` : sql``}`
  for (const { field, value } of activeFieldFilters) {
    where = sql`${where} and r.data->>${field.id} = ${value}`
  }

  const sortColumn =
    listParams.sort === 'number'
      ? sql`r.record_number`
      : listParams.sort === 'created'
        ? sql`r.created_at`
        : (() => {
            const f = columns.find((c) => c.id === listParams.sort)!
            return isNumericField(f)
              ? sql`nullif(r.data->>${f.id}, '')::numeric`
              : sql`r.data->>${f.id}`
          })()

  const [rows, statusCounts, filterCounts] = await Promise.all([
    db.execute(sql`
      select r.id, r.record_number, r.data, r.status, r.created_at
        from custom_records r
       where ${where}
       order by ${sortColumn} ${listParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, r.created_at desc
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}
    `) as any,
    db.execute(sql`
      select r.status, count(*) as n from custom_records r
       where ${scope} ${showInactive || status === 'inactive' ? sql`` : sql`and r.status <> 'inactive'`}
       group by r.status
    `) as any,
    Promise.all(
      filterFields.map(
        (f) =>
          db.execute(sql`
            select r.data->>${f.id} as v, count(*) as n
             from custom_records r
             where ${scope}
               ${showInactive || status === 'inactive' ? sql`` : sql`and r.status <> 'inactive'`}
               and r.data->>${f.id} is not null
             group by 1
          `) as any,
      ),
    ),
  ])
  const total = statusCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filtered = Boolean(status || listParams.q || activeFieldFilters.length > 0)
  const filteredTotal = filtered
    ? Number(
        ((await db.execute(sql`select count(*) as n from custom_records r where ${where}`)) as any)
          .rows[0].n,
      )
    : total

  const labels = await resolveEntityLabels(
    sections,
    rows.rows.map((r: any) => r.data),
  )

  const openRecord = recId ? await loadRecord(authz.user.orgId, typeKey, recId) : null

  const statusOptions = statusCounts.rows.map((r: any) => ({
    value: r.status,
    label: (RECORD_STATUSES as readonly string[]).includes(r.status)
      ? tc(`status.${r.status}`)
      : String(r.status),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={type.plural_name}
            description={
              type.description ?? t('module.defaultDescription', { pluralName: type.plural_name })
            }
            actions={canCreate ? <NewRecordButton typeKey={typeKey} typeName={type.name} /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              placeholder={t('module.searchPlaceholder', {
                pluralName: type.plural_name.toLowerCase(),
              })}
            />
            <FilterChips
              basePath={basePath}
              currentParams={sp}
              paramKey="status"
              label={tc('labels.status')}
              options={statusOptions}
            />
            <ShowInactivesToggle basePath={basePath} currentParams={sp} />
            {filterFields.map((f) => {
              const counts = new Map<string, number>(
                (filterCounts[filterFields.indexOf(f)]?.rows ?? []).map((r: any) => [
                  String(r.v),
                  Number(r.n),
                ]),
              )
              return (
                <FilterChips
                  key={f.id}
                  basePath={basePath}
                  currentParams={sp}
                  paramKey={`f_${f.id}`}
                  label={f.label}
                  options={(f.validation?.options ?? []).map((o) => ({
                    value: o.value,
                    label: o.label,
                    count: counts.get(o.value) ?? 0,
                  }))}
                />
              )
            })}
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('module.emptyTitle', { pluralName: type.plural_name.toLowerCase() })}
          description={
            canCreate
              ? t('module.emptyCreate', { typeName: type.name.toLowerCase() })
              : t('module.emptyNoAccess')
          }
          action={canCreate ? <NewRecordButton typeKey={typeKey} typeName={type.name} /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={basePath} currentParams={sp} column="number" sort={listParams.sort} dir={listParams.dir}>
                  #
                </SortTh>
                {columns.map((f) => (
                  <SortTh
                    key={f.id}
                    basePath={basePath}
                    currentParams={sp}
                    column={f.id}
                    sort={listParams.sort}
                    dir={listParams.dir}
                    align={isNumericField(f) ? 'right' : 'left'}
                  >
                    {f.label}
                  </SortTh>
                ))}
                <TableHead>{tc('labels.status')}</TableHead>
                <SortTh basePath={basePath} currentParams={sp} column="created" sort={listParams.sort} dir={listParams.dir}>
                  {tc('labels.created')}
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-[13px] font-semibold">
                    <Link
                      href={buildListDrawerHref(basePath, sp, 'rec', String(r.id)) as any}
                      className="text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {r.record_number}
                    </Link>
                  </TableCell>
                  {columns.map((f) => {
                    const text = formatFieldValue(f, r.data?.[f.id], labels, display)
                    return (
                      <TableCell
                        key={f.id}
                        className={isNumericField(f) ? 'text-right tabular-nums' : undefined}
                      >
                        {text || <span className="text-slate-400 dark:text-slate-500">—</span>}
                      </TableCell>
                    )
                  })}
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>
                      {(RECORD_STATUSES as readonly string[]).includes(r.status)
                        ? tc(`status.${r.status}`)
                        : r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{dateTime(r.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination
              basePath={basePath}
              currentParams={sp}
              total={filteredTotal}
              page={listParams.page}
              perPage={listParams.perPage}
            />
          </div>
        </>
      )}
      {openRecord ? (
        <RecordDrawer
          key={openRecord.id} // remount when deep-linking straight to another record
          typeKey={typeKey}
          typeName={type.name}
          sections={sections}
          record={{
            id: openRecord.id,
            recordNumber: openRecord.record_number,
            data: openRecord.data,
            status: openRecord.status,
          }}
          canEdit={canCreate}
        />
      ) : null}
    </ListPageLayout>
  )
}
