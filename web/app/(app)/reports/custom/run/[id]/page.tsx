import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CalendarClock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button, PageHeader } from '@openbooks/ui'
import { REPORT_ENTITY_MAP, type ReportRunResult } from '@openbooks/reports'
import { ListPageLayout } from '../../../../../../components/page-layout'
import { can, requirePermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { executeReport, loadReportDefinition } from '../../../../../../lib/custom-reports'
import { statementPageHref } from '../../../../../../lib/report-run'
import { orgBranding } from '../../../../../../lib/report-pdf'
import { ReportFilterBar } from '../../../ReportFilterBar'
import { ExportMenu } from '../../../ExportMenu'
import { ReportPaper } from '../../../ReportPaper'
import { ResultView } from '../../ResultView'

export const dynamic = 'force-dynamic'

/**
 * A saved query report IS a regular report: this screen is the exact native
 * report chrome — header back to the hub, filter-bar row with Export, and the
 * paper, already run. Definition management (builder, delivery schedules, run
 * history) lives on its own screens, never here.
 */
export default async function ReportRunPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const canSchedule = authz.permissions.has('reports.schedule') || authz.permissions.has('*')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()
  // Standard statement definitions are viewed through their rich drill-through
  // pages, not the entity-query runner.
  if (definition.report_type === 'statement') redirect(statementPageHref(definition.statement))
  if (!definition.query) notFound()

  // Sensitive entities (payroll wages) carry their own permission on top of
  // reports.read — same gate as /api/reports/run.
  const entity = REPORT_ENTITY_MAP[(definition.query as { entity?: string }).entity ?? '']
  if (entity?.requiredPermission && !can(authz, entity.requiredPermission)) notFound()

  const t = await getTranslations('reports')
  const tk = await getTranslations('reports.custom')
  const tc = await getTranslations('common')

  // Built-in definitions localize by slug; custom slugs fall back to stored text.
  const displayName = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.name`)
    ? t(`builtIns.${definition.slug}.name`)
    : definition.name
  const displayDescription = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.description`)
    ? t(`builtIns.${definition.slug}.description`)
    : definition.description

  // Native reports land showing data: execute the plan read-only on the
  // server (no report_runs row — scheduled/recorded runs persist their own).
  let result: ReportRunResult | null = null
  let error: string | null = null
  const branding = await orgBranding(authz.user.orgId)
  try {
    result = await executeReport(authz.user.orgId, definition.query)
  } catch (err) {
    error = err instanceof Error ? err.message : 'report failed'
  }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={displayName}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: false }}
            actions={
              <>
                {canCreate ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/reports/custom/builder/${definition.id}`}>{tc('actions.edit')}</Link>
                  </Button>
                ) : null}
                {canSchedule ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/reports/custom/run/${definition.id}/delivery`}>
                      <CalendarClock size={14} /> {tk('runner.scheduledDelivery')}
                    </Link>
                  </Button>
                ) : null}
                <ExportMenu baseHref={`/api/reports/definitions/${definition.id}/export`} />
              </>
            }
          />
        </>
      }
    >
      {result ? (
        <ResultView
          company={branding.orgName}
          title={displayName}
          description={displayDescription}
          result={result}
          drillTarget={{ kind: 'custom', source: 'definition', id: definition.id, label: displayName }}
        />
      ) : (
        <ReportPaper company={branding.orgName} title={displayName} periodPhrase={displayDescription || undefined}>
          <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{error}</p>
        </ReportPaper>
      )}
    </ListPageLayout>
  )
}
