import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Download, FileText, Pencil } from 'lucide-react'
import { Badge, Button, DetailHeader, EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { Pagination } from '../../../../../components/pagination'
import { parseListParams } from '../../../../../lib/list-params'
import { dateTime } from '../../../../../lib/format'
import { requirePermission } from '../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../lib/report-authz'
import { loadView, runView } from '../../../../../lib/views'
import type { ReportRunResult } from '@openbooks/reports'
import { ResultView } from '../../../reports/custom/ResultView'
import { orgBranding } from '../../../../../lib/report-pdf'
import { ReportPaper } from '../../../reports/ReportPaper'

export const dynamic = 'force-dynamic'

const PER_PAGE = 50

/**
 * Slice a run result to one page of rows, preserving group boundaries (a page
 * can straddle sections). The summary band keeps the FULL run's figures so
 * "Rows: 1,234" stays truthful while the table shows 50 at a time.
 */
function paginateResult(result: ReportRunResult, page: number, perPage: number): ReportRunResult {
  const start = (page - 1) * perPage
  const end = start + perPage
  let offset = 0
  const groups = result.groups
    .map((g) => {
      const gStart = offset
      offset += g.rows.length
      const from = Math.max(start - gStart, 0)
      const to = Math.min(end - gStart, g.rows.length)
      if (from >= g.rows.length || to <= 0) return null
      return { ...g, rows: g.rows.slice(from, to) }
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
  // An empty page (out of range) keeps the first group shell so the header row
  // still renders; the empty state below covers the zero-rows case.
  return { ...result, groups: groups.length ? groups : result.groups.slice(0, 1) }
}

export default async function ViewRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('knowledge.views')
  const tReports = await getTranslations('reports')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const { id } = await params
  const sp = await searchParams
  const listParams = parseListParams(sp, { sort: 'updated', dir: 'desc', perPage: PER_PAGE, allowedSorts: ['updated'] as const })

  const view = /^[0-9a-f-]{36}$/i.test(id)
    ? await loadView(authz.user.orgId, id, authz.user.id, authz.permissions)
    : null

  if (!view) {
    return (
      <ListPageLayout
        header={
          <PageHeader
            title={t('run.notFoundTitle')}
            description={t('run.notFoundDescription')}
            back={{ href: '/knowledge/views', label: t('run.backToList') }}
          />
        }
      >
        <EmptyState title={t('run.notFoundTitle')} description={t('run.notFoundDescription')} />
      </ListPageLayout>
    )
  }

  // A shared view never widens what its reader may see: payroll / optional-
  // module entities keep the same gate the report surfaces enforce.
  if (!(await canRunReportEntity(authz, view.query))) notFound()

  const canEdit = authz.permissions.has('*') || view.owner_id === authz.user.id
  const [result, branding] = await Promise.all([
    runView(authz.user.orgId, view.query),
    orgBranding(authz.user.orgId),
  ])
  const paged = paginateResult(result, listParams.page, PER_PAGE)
  const from = result.rowCount === 0 ? 0 : (listParams.page - 1) * PER_PAGE + 1
  const to = Math.min(listParams.page * PER_PAGE, result.rowCount)

  const entityLabel = tReports.has(`catalog.entities.${view.query.entity}.label`)
    ? tReports(`catalog.entities.${view.query.entity}.label`)
    : view.query.entity

  const currentParams = Object.fromEntries(Object.entries(sp).filter(([, v]) => v !== undefined)) as Record<string, string>

  return (
    <ListPageLayout
      header={
        <>
          <DetailHeader
            title={view.name}
            badge={
              <Badge variant={view.scope === 'shared' ? 'secondary' : 'outline'}>
                {t(`list.scope.${view.scope}` as never)}
              </Badge>
            }
            subtitle={view.description || t('run.refreshHint')}
            back={{ href: '/knowledge/views', label: t('run.backToList') }}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/views/${view.id}/export?format=pdf`}><FileText size={15} /> {t('studio.exportPdf')}</a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/views/${view.id}/export?format=xlsx`}><Download size={15} /> {t('studio.exportXlsx')}</a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/views/${view.id}/export?format=csv`}><Download size={15} /> {t('studio.exportCsv')}</a>
                </Button>
                {canEdit ? (
                  <Button size="sm" asChild>
                    <Link href={`/knowledge/views?view=${view.id}`}><Pencil size={14} /> {t('run.editSearch')}</Link>
                  </Button>
                ) : null}
              </div>
            }
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>{tc('labels.type')}: {entityLabel}</span>
            <span>{t('run.lastUpdated', { when: dateTime(view.updated_at) })}</span>
            {result.rowCount > 0 ? <span>{t('run.rowsRange', { from, to, total: result.rowCount })}</span> : null}
          </div>
        </>
      }
    >
      {result.rowCount === 0 ? (
        <ReportPaper company={branding.orgName} title={view.name} periodPhrase={view.description || undefined}>
          <EmptyState title={t('run.emptyTitle')} description={t('run.emptyDescription')} />
        </ReportPaper>
      ) : (
        <ResultView
          company={branding.orgName}
          title={view.name}
          description={view.description}
          result={paged}
          drillTarget={{ kind: 'custom', source: 'view', id: view.id, label: view.name }}
        />
      )}
      <Pagination
        basePath={`/knowledge/views/${view.id}`}
        currentParams={currentParams}
        page={listParams.page}
        perPage={PER_PAGE}
        total={result.rowCount}
      />
    </ListPageLayout>
  )
}
