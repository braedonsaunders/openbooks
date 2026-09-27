import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadManufacturingSetup, manufacturingPoliciesSpec } from './view'
import { ManufacturingPoliciesForm, ManufacturingSetupTabs } from './sections'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { can, getAuthz } from '../../../../../lib/authz'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function ManufacturingSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadManufacturingSetup(sp)
  const entity = data.entityKey ? SETUP_ENTITY_BY_KEY.get(data.entityKey) : undefined
  const authz = data.entityKey ? await getAuthz() : null
  if (data.entityKey && (!entity || !authz)) notFound()
  return (
    <div className="space-y-4">
      <ModuleView spec={manufacturingPoliciesSpec(data)} data={data} searchParams={sp} trusted />
      <ManufacturingSetupTabs tabs={data.tabs} />
      {data.entityKey && entity && authz ? (
        <SetupEntitySection
          entity={entity}
          orgId={authz.user.orgId}
          searchParams={data.currentParams}
          basePath="/admin/setup/manufacturing"
          canManage={can(authz, 'admin.setup.manage')}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        />
      ) : (
        <ManufacturingPoliciesForm initial={data.policies} />
      )}
    </div>
  )
}
