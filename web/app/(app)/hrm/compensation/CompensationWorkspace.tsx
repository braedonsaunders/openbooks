import Link from 'next/link'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Plus } from 'lucide-react'
import { CompensationOverview } from './CompensationOverview'
import { CompensationCycleRegister, CompensationPlanRegister } from './CompensationRegisters'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { JOB_FAMILIES_ENTITY, JOB_LEVELS_ENTITY } from '../../../../lib/setup/hrm-compensation'
import { can } from '../../../../lib/authz'
import { compensationAuthz, type CompHomeData } from '../../../../lib/hrm/compensation'
import { NewCompensationButton } from './NewCompensationButton'
import { CompensationBandsWorkspace } from './CompensationBandsWorkspace'

/** One bounded work area, composed from the shared document-list and registry
 * machinery. Record drawers retain their existing commands and permissions. */
export async function CompensationWorkspace({ data }: { data: CompHomeData }) {
  const authz = await compensationAuthz()
  if (!authz) return null
  const canSetup = can(authz, 'admin.setup.manage') && authz.allowedSubsidiaryIds === null
  const architecture = data.activeView === 'families'
    ? { entity: JOB_FAMILIES_ENTITY, rowParam: 'family' }
    : data.activeView === 'levels'
      ? { entity: JOB_LEVELS_ENTITY, rowParam: 'level' }
      : null
  const activeAction = data.newItems.find((item) => item.key === ({ cycles: 'cycle', plans: 'plan', families: 'family', levels: 'level', bands: 'band' } as Record<string, string>)[data.activeView])
  const title = data.activeView === 'overview' ? data.title : data.workspaceTabs.find((tab) => tab.active)?.label ?? data.title
  return (
    <ListPageLayout contained header={
      <PageHeader title={title} description={data.workspaceDescription}
        actions={data.activeView === 'overview' ? <NewCompensationButton items={data.newItems} /> : activeAction ? (
          <Button asChild><Link href={activeAction.href as never}><Plus size={15} />{activeAction.label}</Link></Button>
        ) : null} />
    } className="gap-4">
      {data.activeView === 'overview' ? <CompensationOverview data={data} orgId={authz.user.orgId} actorId={authz.user.id} allowedSubsidiaryIds={authz.allowedSubsidiaryIds} canSetup={canSetup} /> : (
      <div className="min-h-0 flex-1 overflow-hidden">
        {architecture ? (
          <SetupEntitySection
            entity={{ ...architecture.entity, readOnly: !canSetup }}
            orgId={authz.user.orgId}
            actorId={authz.user.id}
            allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
            searchParams={data.currentParams}
            basePath="/hrm/compensation"
            rowParam={architecture.rowParam}
            canManage
            hideHeader
            contained
          />
        ) : data.activeView === 'bands' ? (
          <CompensationBandsWorkspace orgId={authz.user.orgId} actorId={authz.user.id}
            allowedSubsidiaryIds={authz.allowedSubsidiaryIds} canSetup={canSetup} searchParams={data.currentParams} />
        ) : data.activeView === 'plans' ? (
          <CompensationPlanRegister data={data} />
        ) : (
          <CompensationCycleRegister data={data} />
        )}
      </div>
      )}
    </ListPageLayout>
  )
}
