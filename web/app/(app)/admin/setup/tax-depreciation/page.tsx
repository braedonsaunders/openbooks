import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { taxDepreciationPacks } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { TaxDepreciationHeader } from './sections'
import { TaxDepreciationSetup } from './TaxDepreciationSetup'
import { loadTaxDepreciationSetup, taxDepreciationSetupSpec } from './view'

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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadTaxDepreciationSetup(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={taxDepreciationSetupSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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
  const headerTabs = tabs.map((item) => ({
    key: item.key,
    href: `/admin/setup/tax-depreciation?tab=${item.key}`,
    label: item.label,
    active: tab === item.key,
  }))
  const header = (
    <TaxDepreciationHeader
      title={t('title')}
      description={t('description')}
      descriptionClassName={
        tab === 'overview'
          ? 'mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400'
          : 'mt-1 text-sm text-slate-500 dark:text-slate-400'
      }
      tabs={headerTabs}
      tabsAria={t('tabsAria')}
    />
  )

  if (tab !== 'overview') {
    const entity = SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab])!
    return <div className="space-y-5">
      {header}
      <SetupEntitySection entity={entity} orgId={orgId} searchParams={sp} basePath="/admin/setup/tax-depreciation" canManage />
    </div>
  }

  const [org, installed, classes, categories] = await Promise.all([
    db.execute<{ country: string }>(sql`select upper(country) as country from orgs where id = ${orgId}`),
    db.execute<{ code: string }>(sql`select code from tax_regimes where org_id = ${orgId} and is_active`),
    db.execute<{ regime: string; regime_name: string; class_attribute: string; class_code: string; class_name: string }>(sql`
      select r.code as regime, r.name as regime_name, r.class_attribute,
             c.class_code, c.name as class_name
        from tax_regimes r
        join tax_pool_classes c on c.org_id = r.org_id and c.regime = r.code and c.is_active
       where r.org_id = ${orgId} and r.is_active
       order by r.name, c.class_code`),
    db.execute<{ id: string; name: string; tax_attributes: Record<string, unknown> }>(sql`select id, name, tax_attributes from asset_categories where org_id = ${orgId} and is_active order by name`),
  ])
  return (
    <div className="space-y-5">
      {header}
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
