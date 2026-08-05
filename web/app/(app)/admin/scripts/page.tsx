import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { dateTime } from '../../../../lib/format'
import { BUILT_IN_SCRIPT_KINDS, customRecordTypeKey, isCustomRecordKind } from '../../../../lib/script-kinds'
import { NewScriptButton, ScriptDrawer } from './ScriptDrawer'

export const dynamic = 'force-dynamic'

// Enum value → message key under admin.scripts. Unknown values render verbatim.
const TRIGGER_KEYS: Record<string, string> = {
  before_submit: 'beforeSubmit',
  before_post: 'beforePost',
  after_post: 'afterPost',
  before_void: 'beforeVoid',
  scheduled: 'scheduled',
  endpoint: 'endpoint',
  bulk: 'bulk',
  client: 'client',
}
export default async function Scripts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('scripts.manage')
  await requireFeatureEnabled(authz.user.orgId, 'scripts')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin.scripts')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const trigger = pickString(sp.trigger)
  const scriptId = pickString(sp.script)

  const where = sql`org_id = ${orgId}
    ${trigger ? sql` and trigger_point = ${trigger}` : sql``}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}`

  const [scripts, triggers, totalRow, open, runs, customTypes] = await Promise.all([
    db.execute(sql`
      select s.*, (select count(*) from script_runs r where r.script_id = s.id) as run_count,
             (select max(r.at) from script_runs r where r.script_id = s.id) as last_run
        from user_scripts s where ${where}
       order by s.trigger_point, s.sort_order, s.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select trigger_point, count(*) as n from user_scripts where org_id = ${orgId} group by 1`) as any,
    db.execute(sql`select count(*) as n from user_scripts where ${where}`) as any,
    scriptId && scriptId !== 'new'
      ? (db.execute(sql`select * from user_scripts where id = ${scriptId} and org_id = ${orgId}`) as any)
      : null,
    scriptId && scriptId !== 'new'
      ? (db.execute(sql`
          select status, error_message, logs, duration_ms, at, target_kind
            from script_runs where script_id = ${scriptId} and org_id = ${orgId} order by at desc limit 20`) as any)
      : null,
    db.execute(sql`
      select key, name from custom_record_types
       where org_id = ${orgId} and status = 'published' order by name`) as any,
  ])

  const customTypeName = new Map<string, string>(
    customTypes.rows.map((r: any) => [String(r.key), String(r.name)]),
  )
  const builtInKindKey = new Map(BUILT_IN_SCRIPT_KINDS.map((k) => [k.value, k.labelKey]))

  const triggerLabel = (v: string) =>
    TRIGGER_KEYS[v] ? t(`triggers.${TRIGGER_KEYS[v]}`) : v.replace('_', ' ')
  const kindLabel = (v: string) => {
    if (isCustomRecordKind(v)) return customTypeName.get(customRecordTypeKey(v)) ?? customRecordTypeKey(v)
    const labelKey = builtInKindKey.get(v)
    return labelKey ? t(labelKey) : v
  }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={<NewScriptButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath="/admin/scripts"
              currentParams={sp}
              paramKey="trigger"
              label={t('triggerFilter')}
              options={triggers.rows.map((r: any) => ({ value: r.trigger_point, label: triggerLabel(r.trigger_point), count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('table.script')}</TableHead>
            <TableHead>{t('table.trigger')}</TableHead>
            <TableHead>{t('table.kind')}</TableHead>
            <TableHead className="text-right">{t('table.runs')}</TableHead>
            <TableHead>{t('table.lastRun')}</TableHead>
            <TableHead>{t('table.status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scripts.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-slate-500 dark:text-slate-400">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {scripts.rows.map((s: any) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link href={buildListDrawerHref('/admin/scripts', sp, 'script', String(s.id)) as any} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {s.name}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{triggerLabel(String(s.trigger_point))}</Badge>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">
                {s.document_kind ? kindLabel(s.document_kind) : t('allKinds')}
              </TableCell>
              <TableCell className="text-right tabular-nums">{s.run_count}</TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{s.last_run ? dateTime(s.last_run) : ''}</TableCell>
              <TableCell>
                <Badge variant={s.is_active ? 'success' : 'outline'}>
                  {s.is_active ? t('statusActive') : t('statusDisabled')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/admin/scripts" currentParams={sp} total={Number(totalRow.rows[0].n)} page={params.page} perPage={params.perPage} />
      </div>

      {scriptId ? (
        <ScriptDrawer
          script={open?.rows[0] ?? null}
          runs={runs?.rows ?? []}
          customTypes={customTypes.rows.map((r: any) => ({ key: String(r.key), name: String(r.name) }))}
        />
      ) : null}
    </ListPageLayout>
  )
}
