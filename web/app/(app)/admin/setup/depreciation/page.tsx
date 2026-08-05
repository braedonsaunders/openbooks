import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { cn } from '@openbooks/ui'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'

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
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const sp = await searchParams
  const requested = pickString(sp.tab)
  const tab: Tab = requested && requested in ENTITY_BY_TAB ? requested as Tab : 'methods'
  const t = await getTranslations('admin.setup.assetDepreciationSetup')
  const tabs: { key: Tab; label: string }[] = [
    { key: 'methods', label: t('tabs.methods') },
    { key: 'books', label: t('tabs.books') },
  ]
  const entity = SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab])!

  return <div className="space-y-5">
    <header>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
    </header>
    <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('tabsAria')}>
      {tabs.map((item) => <Link key={item.key} href={`/admin/setup/depreciation?tab=${item.key}` as never}
        aria-current={tab === item.key ? 'page' : undefined}
        className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === item.key ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
        {item.label}
      </Link>)}
    </nav>
    <SetupEntitySection entity={entity} orgId={authz.user.orgId} searchParams={sp} basePath="/admin/setup/depreciation" canManage />
  </div>
}
