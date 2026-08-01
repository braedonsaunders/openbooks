import { sql } from 'drizzle-orm'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { cn } from '@openbooks/ui'
import { taxDepreciationPacks } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { TaxDepreciationSetup } from './TaxDepreciationSetup'

export const dynamic = 'force-dynamic'

const ENTITY_BY_TAB = {
  regimes: 'tax-regimes',
  classes: 'tax-pool-classes',
  'first-year': 'tax-first-year-rules',
} as const
type Tab = 'overview' | keyof typeof ENTITY_BY_TAB

export default async function TaxDepreciationSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'fixedAssets')
  const sp = await searchParams
  const requested = pickString(sp.tab)
  const tab: Tab = requested && (requested === 'overview' || requested in ENTITY_BY_TAB) ? requested as Tab : 'overview'
  const t = await getTranslations('admin.setup.taxDepreciationSetup')
  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: t('tabs.overview') },
    { key: 'regimes', label: t('tabs.regimes') },
    { key: 'classes', label: t('tabs.classes') },
    { key: 'first-year', label: t('tabs.firstYear') },
  ]
  const tabNav = (
    <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" aria-label={t('tabsAria')}>
      {tabs.map((item) => <Link key={item.key} href={`/admin/setup/tax-depreciation?tab=${item.key}` as never}
        aria-current={tab === item.key ? 'page' : undefined}
        className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium', tab === item.key ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
        {item.label}
      </Link>)}
    </nav>
  )

  if (tab !== 'overview') {
    const entity = SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab])!
    return <div className="space-y-5">
      <header><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('description')}</p></header>
      {tabNav}
      <SetupEntitySection entity={entity} orgId={orgId} searchParams={sp} basePath="/admin/setup/tax-depreciation" canManage />
    </div>
  }

  const [org, installed, classes, categories] = await Promise.all([
    db.execute(sql`select upper(country) as country from orgs where id = ${orgId}`) as unknown as Promise<{ rows: { country: string }[] }>,
    db.execute(sql`select code from tax_regimes where org_id = ${orgId} and is_active`) as unknown as Promise<{ rows: { code: string }[] }>,
    db.execute(sql`
      select r.code as regime, r.name as regime_name, r.class_attribute,
             c.class_code, c.name as class_name
        from tax_regimes r
        join tax_pool_classes c on c.org_id = r.org_id and c.regime = r.code and c.is_active
       where r.org_id = ${orgId} and r.is_active
       order by r.name, c.class_code`) as unknown as Promise<{ rows: { regime: string; regime_name: string; class_attribute: string; class_code: string; class_name: string }[] }>,
    db.execute(sql`select id, name, tax_attributes from asset_categories where org_id = ${orgId} and is_active order by name`) as unknown as Promise<{ rows: { id: string; name: string; tax_attributes: Record<string, unknown> }[] }>,
  ])
  return (
    <div className="space-y-5">
      <header><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1><p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p></header>
      {tabNav}
      <TaxDepreciationSetup
        companyCountry={org.rows[0]?.country ?? ''}
        packs={taxDepreciationPacks()}
        installedCodes={installed.rows.map((row) => row.code)}
        regimes={Object.values(classes.rows.reduce<Record<string, { code: string; name: string; classAttribute: string; classes: { code: string; name: string }[] }>>((all, row) => {
          const regime = all[row.regime] ?? { code: row.regime, name: row.regime_name, classAttribute: row.class_attribute, classes: [] }
          regime.classes.push({ code: row.class_code, name: row.class_name })
          all[row.regime] = regime
          return all
        }, {}))}
        categories={categories.rows.map((category) => ({ id: category.id, name: category.name, taxAttributes: category.tax_attributes ?? {} }))}
      />
    </div>
  )
}
