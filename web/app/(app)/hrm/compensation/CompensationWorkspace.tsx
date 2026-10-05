import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { requireBandsReadScope } from '@openbooks/engine/hrm/compensation'
import Link from 'next/link'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Plus } from 'lucide-react'
import { CompensationOverview } from './CompensationOverview'
import { CompensationCycleRegister, CompensationPlanRegister } from './CompensationRegisters'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { JOB_FAMILIES_ENTITY, JOB_LEVELS_ENTITY, PAY_BANDS_ENTITY } from '../../../../lib/setup/hrm-compensation'
import { can } from '../../../../lib/authz'
import { compensationAuthz, type CompHomeData } from '../../../../lib/hrm/compensation'
import { NewCompensationButton } from './NewCompensationButton'

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
      : data.activeView === 'bands'
        ? { entity: PAY_BANDS_ENTITY, rowParam: 'band' } : null
  let visibleBandIds: ReadonlySet<string> | undefined
  if (data.activeView === 'bands') {
    const allowed = await requireBandsReadScope(authz.user.orgId, authz.user.id)
    if (allowed !== null) {
      const ids = await db.execute<{ id: string }>(sql`
        select id from hrm_pay_bands where org_id = ${authz.user.orgId}
          and (employer_subsidiary_id is null or employer_subsidiary_id = any(${`{${[...allowed].join(',')}}`}::uuid[]))
      `)
      visibleBandIds = new Set(ids.rows.map((row) => row.id))
    }
  }
  const activeAction = data.newItems.find((item) => item.key === ({ cycles: 'cycle', plans: 'plan', families: 'family', levels: 'level', bands: 'band' } as Record<string, string>)[data.activeView])
  const title = data.activeView === 'overview' ? data.title : data.workspaceTabs.find((tab) => tab.active)?.label ?? data.title
  return (
    <ListPageLayout contained header={
      <PageHeader title={title} description={data.workspaceDescription}
        actions={data.activeView === 'overview' ? <NewCompensationButton items={data.newItems} /> : activeAction ? (
          <Button asChild><Link href={activeAction.href as never}><Plus size={15} />{activeAction.label}</Link></Button>
        ) : null} />
    } className="gap-4">
      {data.activeView === 'overview' ? <CompensationOverview data={data} /> : (
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
            visibleRowIds={visibleBandIds}
            canManage
            hideHeader
            contained
          />
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
