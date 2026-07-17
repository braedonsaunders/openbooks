import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { Activity, Settings } from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { readableContinuousCloseAgents } from '../../../lib/continuous-close'
import { WorkItemDrawer, type ContinuousCloseWorkItem } from './WorkItemDrawer'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('continuousClose')
  return { title: t('metaTitle') }
}

const SORT_COLUMNS = {
  detected: sql`w.last_detected_at`,
  severity: sql`case w.severity when 'critical' then 3 when 'warning' then 2 else 1 end`,
  materiality: sql`w.materiality`,
  status: sql`w.status`,
} as const

const SEVERITY_VARIANT = { info: 'secondary', warning: 'warning', critical: 'destructive' } as const
const STATUS_VARIANT = { open: 'warning', in_review: 'secondary', resolved: 'success', dismissed: 'outline' } as const

export default async function ContinuousClosePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('assistant.use')
  const readable = readableContinuousCloseAgents(authz)
  if (readable.length === 0) redirect('/assistant')
  const t = await getTranslations('continuousClose')
  const tc = await getTranslations('common')
  const locale = await getLocale()
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'detected', dir: 'desc', perPage: 25, allowedSorts: ['detected', 'severity', 'materiality', 'status'] as const })
  const requestedAgent = pickString(sp.agent)
  const agent = requestedAgent === 'accounting' || requestedAgent === 'finance'
    ? readable.includes(requestedAgent) ? requestedAgent : undefined
    : undefined
  const requestedStatus = pickString(sp.status)
  const status = ['open', 'in_review', 'resolved', 'dismissed'].includes(requestedStatus ?? '') ? requestedStatus : undefined
  const requestedSeverity = pickString(sp.severity)
  const severity = ['info', 'warning', 'critical'].includes(requestedSeverity ?? '') ? requestedSeverity : undefined
  const readableSql = sql.raw(`(${readable.map((key) => `'${key}'`).join(',')})`)
  const base = sql`w.org_id = ${authz.user.orgId} and w.agent_key in ${readableSql}`
  const where = sql`${base}
    ${agent ? sql`and w.agent_key = ${agent}` : sql``}
    ${status ? sql`and w.status = ${status}` : sql``}
    ${severity ? sql`and w.severity = ${severity}` : sql``}
    ${params.q ? sql`and (w.finding_type ilike ${`%${params.q}%`} or w.summary::text ilike ${`%${params.q}%`})` : sql``}`

  const [rows, totalResult, counts, statusCounts, severityCounts] = (await Promise.all([
    db.execute(sql`
      select w.id, w.agent_key, w.finding_type, w.severity, w.status, w.confidence::text,
             w.materiality::text, w.summary, w.first_detected_at, w.last_detected_at
        from ai_work_items w where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`}, w.id
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`select count(*) as n from ai_work_items w where ${where}`),
    db.execute(sql`select agent_key, count(*) as n from ai_work_items w where ${base} group by agent_key`),
    db.execute(sql`select status, count(*) as n from ai_work_items w where ${base} group by status`),
    db.execute(sql`select severity, count(*) as n from ai_work_items w where ${base} group by severity`),
  ])) as unknown as { rows: Record<string, any>[] }[]
  const total = Number(totalResult.rows[0]?.n ?? 0)
  const itemId = pickString(sp.item)
  let selected: ContinuousCloseWorkItem | null = null
  if (itemId && isUuid(itemId)) {
    const detail = (await db.execute(sql`
      select w.*, f.rating
        from ai_work_items w
        left join ai_work_item_feedback f on f.work_item_id = w.id and f.user_id = ${authz.user.id}
       where w.id = ${itemId} and w.org_id = ${authz.user.orgId} and w.agent_key in ${readableSql}
    `)) as unknown as { rows: Record<string, any>[] }
    const row = detail.rows[0]
    if (row) {
      const evidence = (await db.execute(sql`
        select id, kind, source_type, source_id, data
          from ai_work_item_evidence where work_item_id = ${itemId} and org_id = ${authz.user.orgId}
         order by created_at, id
      `)) as unknown as { rows: Record<string, any>[] }
      selected = {
        id: row.id,
        agentKey: row.agent_key,
        findingType: row.finding_type,
        severity: row.severity,
        status: row.status,
        confidence: row.confidence,
        materiality: row.materiality,
        summary: row.summary ?? {},
        firstDetectedAt: new Date(row.first_detected_at).toISOString(),
        lastDetectedAt: new Date(row.last_detected_at).toISOString(),
        dismissalReason: row.dismissal_reason,
        feedback: row.rating ?? null,
        evidence: evidence.rows.map((e) => ({ id: e.id, kind: e.kind, sourceType: e.source_type, sourceId: e.source_id, data: e.data ?? {} })),
      }
    }
  }

  const closeHref = mergeHref('/continuous-close', sp, { item: undefined })
  const canManage = can(authz, 'admin.ai.manage')
  const canWrite = can(authz, 'assistant.write')
  const activeCount = statusCounts.rows.filter((row) => row.status === 'open' || row.status === 'in_review').reduce((sum, row) => sum + Number(row.n), 0)
  const criticalCount = severityCounts.rows.find((row) => row.severity === 'critical')?.n ?? 0

  return (
    <ListPageLayout
      header={<>
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={canManage ? <Button variant="outline" asChild><Link href="/admin/ai"><Settings size={14} />{t('actions.settings')}</Link></Button> : undefined}
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric locale={locale} label={t('metrics.active')} value={activeCount} />
          <Metric locale={locale} label={t('metrics.critical')} value={Number(criticalCount)} tone={Number(criticalCount) > 0 ? 'text-red-600 dark:text-red-400' : undefined} />
          <Metric locale={locale} label={t('metrics.accounting')} value={Number(counts.rows.find((row) => row.agent_key === 'accounting')?.n ?? 0)} />
          <Metric locale={locale} label={t('metrics.finance')} value={Number(counts.rows.find((row) => row.agent_key === 'finance')?.n ?? 0)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('search')} />
          <FilterChips basePath="/continuous-close" currentParams={sp} paramKey="agent" label={t('filters.agent')} options={counts.rows.map((row) => ({ value: row.agent_key, label: t(`agents.${row.agent_key}`), count: Number(row.n) }))} />
          <FilterChips basePath="/continuous-close" currentParams={sp} paramKey="status" label={tc('labels.status')} options={statusCounts.rows.map((row) => ({ value: row.status, label: t(`status.${row.status}`), count: Number(row.n) }))} />
          <FilterChips basePath="/continuous-close" currentParams={sp} paramKey="severity" label={t('filters.severity')} options={severityCounts.rows.map((row) => ({ value: row.severity, label: t(`severity.${row.severity}`), count: Number(row.n) }))} />
        </div>
      </>}
    >
      {total === 0 ? (
        <EmptyState
          icon={<Activity />}
          title={t('empty.title')}
          description={t('empty.description')}
          action={canManage ? <Button asChild><Link href="/admin/ai">{t('empty.action')}</Link></Button> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('table.finding')}</TableHead>
              <TableHead>{t('table.agent')}</TableHead>
              <SortTh basePath="/continuous-close" currentParams={sp} column="severity" sort={params.sort} dir={params.dir}>{t('table.severity')}</SortTh>
              <SortTh basePath="/continuous-close" currentParams={sp} column="materiality" sort={params.sort} dir={params.dir} align="right">{t('table.materiality')}</SortTh>
              <SortTh basePath="/continuous-close" currentParams={sp} column="status" sort={params.sort} dir={params.dir}>{tc('labels.status')}</SortTh>
              <SortTh basePath="/continuous-close" currentParams={sp} column="detected" sort={params.sort} dir={params.dir}>{t('table.detected')}</SortTh>
            </TableRow></TableHeader>
            <TableBody>{rows.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell><Link href={mergeHref('/continuous-close', sp, { item: row.id }) as never} className="font-medium text-slate-900 hover:text-teal-700 hover:underline dark:text-slate-100 dark:hover:text-teal-300">{t(`findings.${row.finding_type}.title`)}</Link><p className="mt-0.5 max-w-xl truncate text-xs text-slate-500">{summaryLabel(row.summary)}</p></TableCell>
                <TableCell><Badge variant="outline">{t(`agents.${row.agent_key}`)}</Badge></TableCell>
                <TableCell><Badge variant={SEVERITY_VARIANT[row.severity as keyof typeof SEVERITY_VARIANT]}>{t(`severity.${row.severity}`)}</Badge></TableCell>
                <TableCell className="text-right font-medium tabular-nums">{money(row.materiality)}</TableCell>
                <TableCell><Badge variant={STATUS_VARIANT[row.status as keyof typeof STATUS_VARIANT]}>{t(`status.${row.status}`)}</Badge></TableCell>
                <TableCell className="text-sm text-slate-500">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(row.last_detected_at))}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
          <Pagination basePath="/continuous-close" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
        </>
      )}
      {selected ? <WorkItemDrawer item={selected} closeHref={closeHref} canWrite={canWrite} /> : null}
    </ListPageLayout>
  )

  function summaryLabel(summary: Record<string, unknown>): string {
    if (summary.accountName) return [summary.accountNumber, summary.accountName].filter(Boolean).join(' · ')
    if (summary.scenarioName) return String(summary.scenarioName)
    if (summary.currentPeriod) return `${summary.currentPeriod} / ${summary.priorPeriod}`
    if (summary.count != null) return t('summary.records', { count: Number(summary.count) })
    return t('summary.review')
  }
}

function Metric({ label, value, locale, tone }: { label: string; value: number; locale: string; tone?: string }) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950"><div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div><div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value.toLocaleString(locale)}</div></div>
}
