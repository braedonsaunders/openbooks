import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../lib/authz'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { disabledCustomFieldTargets } from '../../../../lib/customization/gates'
import { FieldDrawer, NewFieldButton } from './FieldDrawer'

export const dynamic = 'force-dynamic'

// field_type enum value → admin.customFields.types.* message key. Unknown
// values (shouldn't happen) render the raw code.
const TYPE_KEYS: Record<string, string> = {
  text: 'text',
  long_text: 'longText',
  number: 'number',
  currency: 'currency',
  date: 'date',
  boolean: 'boolean',
  select: 'select',
  multi_select: 'multiSelect',
}

export default async function CustomFields({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.custom_fields.manage')
  const t = await getTranslations('admin.customFields')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'target', allowedSorts: ['target'] as const, perPage: 100 })
  const target = pickString(sp.target)
  const fieldId = pickString(sp.field)
  const orgId = authz.user.orgId
  const hidden = await disabledCustomFieldTargets(orgId)
  if (target && hidden.tables.includes(target)) notFound()

  const kindHide = hidden.kinds.length === 0
    ? sql`true`
    : sql`(target_kind is null or target_kind not in (${sql.join(hidden.kinds.map((k) => sql`${k}`), sql`, `)}))`
  const tableHide = hidden.tables.length === 0
    ? sql`true`
    : sql`not (target_kind is null and target_table in (${sql.join(hidden.tables.map((t) => sql`${t}`), sql`, `)}))`

  const where = sql`org_id = ${orgId} and ${kindHide} and ${tableHide}
    ${target ? sql` and target_table = ${target}` : sql``}
    ${params.q ? sql` and (label ilike ${'%' + params.q + '%'} or key ilike ${'%' + params.q + '%'})` : sql``}`

  const [defs, counts, totalRow, open] = await Promise.all([
    db.execute(sql`
      select id, target_table, target_kind, key, label, field_type, config, is_required, is_active, sort_order
        from custom_field_defs where ${where}
       order by target_table, target_kind nulls first, sort_order, label
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select target_table, count(*) as n from custom_field_defs where org_id = ${orgId} and ${kindHide} and ${tableHide} group by 1`) as any,
    db.execute(sql`select count(*) as n from custom_field_defs where ${where}`) as any,
    fieldId && fieldId !== 'new'
      ? (db.execute(sql`select * from custom_field_defs where id = ${fieldId} and org_id = ${orgId}`) as any)
      : null,
  ])

  const openRow = open?.rows[0] ?? null
  if (openRow && (
    hidden.kinds.includes(openRow.target_kind)
    || (openRow.target_kind == null && hidden.tables.includes(openRow.target_table))
  )) notFound()

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={<NewFieldButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath="/admin/custom-fields"
              currentParams={sp}
              paramKey="target"
              label={t('targetFilter')}
              options={counts.rows.map((r: any) => ({ value: r.target_table, label: r.target_table, count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('table.field')}</TableHead>
            <TableHead>{t('table.key')}</TableHead>
            <TableHead>{t('table.target')}</TableHead>
            <TableHead>{t('table.type')}</TableHead>
            <TableHead>{t('table.required')}</TableHead>
            <TableHead>{t('table.status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {defs.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-slate-500 dark:text-slate-400">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {defs.rows.map((d: any) => (
            <TableRow key={d.id}>
              <TableCell>
                <Link href={buildListDrawerHref('/admin/custom-fields', sp, 'field', String(d.id)) as any} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {d.label}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-xs text-slate-500">{d.key}</TableCell>
              <TableCell className="font-mono text-xs">
                {d.target_table}
                {d.target_kind ? <span className="text-slate-400">:{d.target_kind}</span> : null}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">
                  {TYPE_KEYS[d.field_type] ? t(`types.${TYPE_KEYS[d.field_type]}.label`) : d.field_type}
                </Badge>
              </TableCell>
              <TableCell>{d.is_required ? tCommon('labels.yes') : ''}</TableCell>
              <TableCell>
                <Badge variant={d.is_active ? 'success' : 'outline'}>
                  {d.is_active ? t('statusActive') : t('statusArchived')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/admin/custom-fields" currentParams={sp} total={Number(totalRow.rows[0].n)} page={params.page} perPage={params.perPage} />
      </div>

      {fieldId ? <FieldDrawer def={openRow} hiddenKinds={hidden.kinds} hiddenTables={hidden.tables} /> : null}
    </ListPageLayout>
  )
}
