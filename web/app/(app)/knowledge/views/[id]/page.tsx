import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Download, FileText, Pencil } from 'lucide-react'
import { Badge, Button, DetailHeader, EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { Pagination } from '../../../../../components/pagination'
import { isUuid, parseListParams } from '../../../../../lib/list-params'
import { SavedViewHeader, SavedViewMeta } from './sections'
// One definition of the page size and the client-side pager, shared by both
// render paths.
import { PER_PAGE, paginateResult } from './view'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadSavedViewRun, savedViewRunSpec } from './view'
import { dateTime } from '../../../../../lib/format'
import { requirePermission } from '../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../lib/report-authz'
import { loadView, runView } from '../../../../../lib/views'
import type { ReportRunResult } from '@openbooks/reports'
import { ResultView } from '../../../reports/custom/ResultView'
import { orgBranding } from '../../../../../lib/report-pdf'
import { ReportPaper } from '../../../reports/ReportPaper'

export const dynamic = 'force-dynamic'

export default async function ViewRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp0 = await searchParams
  if (sp0.__viewspec === '1') {
    const data = await loadSavedViewRun(await params, sp0)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={savedViewRunSpec(data)} data={data} searchParams={sp0} trusted />
      </>
    )
  }
  const t = await getTranslations('knowledge.views')
  const tReports = await getTranslations('reports')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const { id } = await params
  const sp = await searchParams
  const listParams = parseListParams(sp, { sort: 'updated', dir: 'desc', perPage: PER_PAGE, allowedSorts: ['updated'] as const })

  const view = isUuid(id)
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
          <SavedViewHeader
            viewId={view.id}
            name={view.name}
            scope={view.scope}
            scopeLabel={t(`list.scope.${view.scope}` as never)}
            subtitle={view.description || t('run.refreshHint')}
            backHref="/knowledge/views"
            backLabel={t('run.backToList')}
            canEdit={canEdit}
            labels={{
              exportPdf: t('studio.exportPdf'),
              exportXlsx: t('studio.exportXlsx'),
              exportCsv: t('studio.exportCsv'),
              edit: t('run.editSearch'),
            }}
          />
          <SavedViewMeta
            typeLabel={`${tc('labels.type')}: ${entityLabel}`}
            lastUpdated={t('run.lastUpdated', { when: dateTime(view.updated_at) })}
            rowsRange={
              result.rowCount > 0 ? t('run.rowsRange', { from, to, total: result.rowCount }) : null
            }
          />
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
