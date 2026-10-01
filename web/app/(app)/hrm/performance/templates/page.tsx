import { ModuleView } from '../../../../../components/viewspec/module-view'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { loadReviewTemplates, reviewTemplatesSpec } from '../../../admin/setup/review-templates/view'

export const dynamic = 'force-dynamic'

/** Performance uses the canonical form catalog without a trip through Setup. */
export default async function PerformanceTemplatesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const data = { ...await loadReviewTemplates(sp), basePath: '/hrm/performance/templates' }
  return <ModuleView spec={reviewTemplatesSpec(data)} data={data} searchParams={sp} trusted />
}
