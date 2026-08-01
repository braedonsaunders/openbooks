import { PageHeader } from '@openbooks/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { listPrebills, listWipProjects, loadPrebill, wipAnalytics } from '../../../../lib/wip-billing'
import { requireWipBillingFeature } from '../../../../lib/wip-billing-gate'
import { ListPageLayout } from '../../../../components/page-layout'
import { WipBillingWorkspace } from './WipBillingWorkspace'

export const dynamic = 'force-dynamic'

export default async function WipBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('projects.read')
  await requireWipBillingFeature(authz.user.orgId)
  const sp = await searchParams
  const selectedId = pickString(sp.prebill)
  const [prebills, projects, analytics, selected] = await Promise.all([
    listPrebills(authz.user.orgId),
    listWipProjects(authz.user.orgId),
    wipAnalytics(authz.user.orgId),
    selectedId && isUuid(selectedId) ? loadPrebill(authz.user.orgId, selectedId) : null,
  ])
  return (
    <ListPageLayout
      header={
        <PageHeader
          title="WIP & Prebilling"
          description="Review unbilled project work, govern billing adjustments, and convert approved worksheets into draft invoices."
        />
      }
    >
      <WipBillingWorkspace
        prebills={prebills}
        projects={projects}
        analytics={analytics}
        selected={selected}
        canManage={can(authz, 'projects.manage')}
        canApprove={can(authz, 'ar.approve')}
        canCreateInvoice={can(authz, 'ar.create')}
      />
    </ListPageLayout>
  )
}
