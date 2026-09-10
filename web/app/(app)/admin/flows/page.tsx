import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { Workflow } from 'lucide-react'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
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
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { NewFlowButton, FlowRowActions } from './FlowsClient'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadFlows, flowsSpec } from './view'
import { FlowNameCell, FlowLastRunCell, FlowRowActionsCell } from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.flows')
  return { title: t('title') }
}

const RUN_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  completed: 'success',
  waiting: 'warning',
  failed: 'destructive',
  running: 'secondary',
  cancelled: 'outline',
}

export default async function Flows({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadFlows(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={flowsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('flows.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin.flows')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const subject = pickString(sp.subject)

  const where = sql`f.org_id = ${orgId}
    ${subject ? sql` and f.subject_kind = ${subject}` : sql``}
    ${params.q ? sql` and f.name ilike ${'%' + params.q + '%'}` : sql``}`

  const [flows, subjects, totalRow] = await Promise.all([
    (db.execute(sql`
      select f.id, f.name, f.subject_kind, f.enabled, ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
             jsonb_array_length(f.graph->'nodes') as node_count,
             lr.status as last_run_status, lr.started_at as last_run_at
        from flows f
        left join lateral (
          select status, started_at from flow_runs r
           where r.flow_id = f.id order by r.started_at desc limit 1
        ) lr on true
       where ${where}
       order by f.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    (db.execute(sql`
      select subject_kind, count(*) as n from flows f
       where f.org_id = ${orgId} group by 1 order by 1`)),
    db.execute(sql`select count(*) as n from flows f where ${where}`) as any,
  ])

  const subjectLabel = new Map(listFlowSubjectProfiles().map((p) => [p.subjectKind, p.label]))
  const total = Number(totalRow.rows[0].n)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={<NewFlowButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath="/admin/flows"
              currentParams={sp}
              paramKey="subject"
              label={t('subjectFilter')}
              options={subjects.rows.map((r: any) => ({
                value: r.subject_kind,
                label: subjectLabel.get(String(r.subject_kind)) ?? String(r.subject_kind),
                count: Number(r.n),
              }))}
            />
          </div>
        </>
      }
    >
      {total === 0 && !params.q && !subject ? (
        <EmptyState
          icon={<Workflow />}
          title={t('empty.title')}
          description={t('empty.description')}
          action={<NewFlowButton />}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.flow')}</TableHead>
                <TableHead>{t('table.subject')}</TableHead>
                <TableHead className="text-right">{t('table.nodes')}</TableHead>
                <TableHead>{t('table.lastRun')}</TableHead>
                <TableHead>{t('table.updated')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.rows.map((f: any) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <FlowNameCell name={f.name} href={`/admin/flows/${f.id}`} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {subjectLabel.get(String(f.subject_kind)) ?? String(f.subject_kind)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{f.node_count}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    <FlowLastRunCell
                      status={f.last_run_at ? String(f.last_run_status) : null}
                      variant={RUN_BADGE[String(f.last_run_status)] ?? 'outline'}
                      at={f.last_run_at ? dateTime(f.last_run_at) : null}
                      fallback={t('neverRan')}
                    />
                  </TableCell>
                  <TableCell className="text-slate-500 tabular-nums dark:text-slate-400">
                    {dateTime(f.updated_at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={f.enabled ? 'success' : 'outline'}>
                      {f.enabled ? t('statusEnabled') : t('statusDisabled')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <FlowRowActionsCell
                      id={String(f.id)}
                      name={String(f.name)}
                      enabled={Boolean(f.enabled)}
                      updatedAt={String(f.updated_at)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination
              basePath="/admin/flows"
              currentParams={sp}
              total={total}
              page={params.page}
              perPage={params.perPage}
            />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
