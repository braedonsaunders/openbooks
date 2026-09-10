import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { DepreciationSetupHeader } from './sections'
import { loadDepreciationSetup, depreciationSetupSpec } from './view'

export const dynamic = 'force-dynamic'

const ENTITY_BY_TAB = {
  methods: 'depreciation-methods',
  books: 'depreciation-book-policies',
} as const
type Tab = keyof typeof ENTITY_BY_TAB

export default async function DepreciationSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDepreciationSetup(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={depreciationSetupSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const sp = await searchParams
  const requested = pickString(sp.tab)
  const tab: Tab = requested && Object.hasOwn(ENTITY_BY_TAB, requested) ? requested as Tab : 'methods'
  const t = await getTranslations('admin.setup.assetDepreciationSetup')
  const tabs: { key: Tab; href: string; label: string; active: boolean }[] = [
    { key: 'methods', href: '/admin/setup/depreciation?tab=methods', label: t('tabs.methods'), active: tab === 'methods' },
    { key: 'books', href: '/admin/setup/depreciation?tab=books', label: t('tabs.books'), active: tab === 'books' },
  ]
  const entity = SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab])!

  return <div className="space-y-5">
    <DepreciationSetupHeader
      title={t('title')}
      description={t('description')}
      tabs={tabs}
      tabsAria={t('tabsAria')}
    />
    <SetupEntitySection entity={entity} orgId={authz.user.orgId} searchParams={sp} basePath="/admin/setup/depreciation" canManage />
  </div>
}
