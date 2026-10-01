import { ModuleView } from '../../../../../../components/viewspec/module-view'
import { can, requirePermission } from '../../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../../lib/feature-gates'
import { loadReviewTemplateBuilder, reviewTemplateBuilderSpec } from '../../../../admin/setup/review-templates/[id]/view'

export const dynamic = 'force-dynamic'

/** The native form builder keeps its navigation and next step in Performance. */
export default async function PerformanceTemplateBuilderPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = await searchParams
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const data = {
    ...await loadReviewTemplateBuilder(id),
    basePath: '/hrm/performance/templates',
    cycleHref: can(authz, 'hrm.performance.manage') ? `/hrm/performance?cycle=new&template=${encodeURIComponent(id)}` : null,
  }
  return <ModuleView spec={reviewTemplateBuilderSpec(data)} data={data} searchParams={sp} trusted />
}
