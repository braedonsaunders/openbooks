import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { loadShippingSetup, shippingSetupSpec } from './view'
import { ShippingAccountsClient } from './ShippingAccountsClient'
import { AdjustmentImportClient } from './AdjustmentImportClient'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { can, getAuthz } from '../../../../../lib/authz'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.setup.shipping')
  return { title: t('title') }
}

/**
 * Company Settings → Shipping. Carrier accounts (connect with an API key,
 * test the connection, park without deleting history), package presets,
 * and the org's shipping defaults — one tab each, the last two rendered
 * by the shared setup section over rehomed registry entities.
 */
export default async function ShippingSetup({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const data = await loadShippingSetup(sp)
  const entity = data.entityKey ? SETUP_ENTITY_BY_KEY.get(data.entityKey) : undefined
  const authz = data.entityKey ? await getAuthz() : null
  if (data.entityKey && (!entity || !authz)) notFound()
  return (
    <div className="space-y-4">
      <ModuleView spec={shippingSetupSpec(data)} data={data} searchParams={sp} trusted />
      <ModuleHomeTabs tabs={data.tabs} />
      {data.tab === 'accounts' ? <ShippingAccountsClient /> : null}
      {data.tab === 'adjustments' ? <AdjustmentImportClient /> : null}
      {entity && authz ? (
        <SetupEntitySection
          entity={entity}
          orgId={authz.user.orgId}
          searchParams={data.currentParams}
          basePath="/admin/setup/shipping"
          canManage={can(authz, 'admin.setup.manage')}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        />
      ) : null}
    </div>
  )
}
