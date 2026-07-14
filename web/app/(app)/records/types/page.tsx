import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
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
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { requirePermission } from '../../../../lib/authz'
import { loadRecordTypeById, type RecordTypeRow } from '../../../../lib/records'
import { NewTypeButton } from './NewTypeButton'
import { TypeBuilderDrawer } from './TypeBuilderDrawer'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  published: 'success',
  draft: 'secondary',
  archived: 'outline',
}

const SORT_COLUMNS = {
  name: sql`t.name`,
  key: sql`t.key`,
  status: sql`t.status`,
  records: sql`record_count`,
  updated: sql`t.updated_at`,
} as const

export default async function RecordTypes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('records.manage_types')
  const sp = await searchParams
  const typeId = typeof sp.type === 'string' ? sp.type : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'key', 'status', 'records', 'updated'] as const,
  })
  const status = pickString(sp.status)

  const where = sql`t.org_id = ${authz.user.orgId}
    ${status ? sql` and t.status = ${status}` : sql``}
    ${params.q ? sql` and (t.name ilike ${'%' + params.q + '%'} or t.plural_name ilike ${'%' + params.q + '%'} or t.key ilike ${'%' + params.q + '%'})` : sql``}`

  const [types, counts, openType, roles] = await Promise.all([
    db.execute(sql`
      select t.id, t.key, t.name, t.plural_name, t.icon_key, t.status, t.show_in_nav,
             t.updated_at, jsonb_array_length(t.fields) as field_count,
             (select count(*) from custom_records cr where cr.type_id = t.id) as record_count
        from custom_record_types t
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select t.status, count(*) as n from custom_record_types t
       where t.org_id = ${authz.user.orgId}
       group by t.status
    `) as any,
    typeId ? loadRecordTypeById(authz.user.orgId, typeId) : null,
    typeId
      ? (db.execute(sql`
          select key, name from app_roles where org_id = ${authz.user.orgId} order by name
        `) as any)
      : null,
  ])
  const total = counts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const filteredTotal =
    status || params.q
      ? Number(
          ((await db.execute(sql`select count(*) as n from custom_record_types t where ${where}`)) as any)
            .rows[0].n,
        )
      : total

  const statusOptions = counts.rows.map((r: any) => ({
    value: r.status,
    label: String(r.status),
    count: Number(r.n),
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Record Types"
            description="Design your own record types — each published type becomes a full module with its own list, numbering, and flyout editor."
            actions={<NewTypeButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search record types…" />
            <FilterChips
              basePath="/records/types"
              currentParams={sp}
              paramKey="status"
              label="Status"
              options={statusOptions}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No record types yet"
          description="Create the first record type to generate a custom module — equipment, contracts, sites, anything the ledger doesn't already model."
          action={<NewTypeButton />}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/records/types" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>Name</SortTh>
                <SortTh basePath="/records/types" currentParams={sp} column="key" sort={params.sort} dir={params.dir}>Key</SortTh>
                <TableHead>Fields</TableHead>
                <SortTh basePath="/records/types" currentParams={sp} column="records" sort={params.sort} dir={params.dir} align="right">Records</SortTh>
                <TableHead>In nav</TableHead>
                <SortTh basePath="/records/types" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>Status</SortTh>
                <SortTh basePath="/records/types" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>Updated</SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.rows.map((t: any) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/records/types?type=${t.id}` as any}
                      className="text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-slate-500 dark:text-slate-400">{t.key}</TableCell>
                  <TableCell className="tabular-nums">{Number(t.field_count)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.status === 'published' ? (
                      <Link
                        href={`/records/${t.key}` as any}
                        className="text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {Number(t.record_count)}
                      </Link>
                    ) : (
                      Number(t.record_count)
                    )}
                  </TableCell>
                  <TableCell>
                    {t.show_in_nav && t.status === 'published' ? (
                      <Badge variant="default">shown</Badge>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{dateTime(t.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination
              basePath="/records/types"
              currentParams={sp}
              total={filteredTotal}
              page={params.page}
              perPage={params.perPage}
            />
          </div>
        </>
      )}
      {openType ? (
        <TypeBuilderDrawer
          key={openType.id} // remount when deep-linking straight to another type
          type={serializeType(openType)}
          roles={(roles?.rows ?? []) as { key: string; name: string }[]}
        />
      ) : null}
    </ListPageLayout>
  )
}

/** Plain-JSON shape for the client drawer (see RecordTypePayload). */
function serializeType(t: RecordTypeRow) {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    pluralName: t.plural_name,
    iconKey: t.icon_key,
    description: t.description,
    fields: t.fields,
    status: t.status,
    showInNav: t.show_in_nav,
    allowedRoles: t.allowed_roles,
    sortOrder: t.sort_order,
  }
}
