import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader, cn } from '@openbooks/ui'
import { listTaxRegimes } from '@openbooks/engine/src/tax-pool-run.ts'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { TaxPoolsView } from './tax-pools/TaxPoolsView'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadAsset } from '../../api/assets/_lib'
import { NewAssetButton } from './NewAssetButton'
import { NewAssetRedirect } from './NewAssetRedirect'
import { RunDepreciationButton } from './RunDepreciationButton'
import { AssetDrawer } from './AssetDrawer'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'

export const dynamic = 'force-dynamic'

export default async function Assets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('assets')
  const authz = await requirePermission('assets.read')
  await requireFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const canManage = can(authz, 'assets.manage')
  const canSetupTaxDepreciation = can(authz, 'admin.setup.manage')
  const canCustomize = can(authz, 'admin.customization.manage')
  const orgId = authz.user.orgId
  const sp = await searchParams

  const tab = pickString(sp.tab) === 'tax-depreciation' ? 'tax-depreciation' : 'register'
  const tabs = [
    { key: 'register', label: t('tabs.register'), href: '/assets' },
    { key: 'tax-depreciation', label: t('tabs.taxDepreciation'), href: '/assets?tab=tax-depreciation' },
  ] as const
  const tabsNav = (
    <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((item) => (
        <Link
          key={item.key}
          href={item.href as never}
          aria-current={tab === item.key ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            tab === item.key
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )

  if (tab === 'tax-depreciation') {
    const regimes = await listTaxRegimes(orgId)
    return (
      <ListPageLayout
        header={<><PageHeader title={t('list.title')} description={t('list.description')} />{tabsNav}</>}
      >
        <TaxPoolsView canRun={canManage} canConfigure={canSetupTaxDepreciation} regimes={regimes} />
      </ListPageLayout>
    )
  }

  const [multiSub, allSubsidiaries, depreciationBooks] = await Promise.all([
    isMultiSubsidiary(orgId),
    subsidiaryOptions(),
    db.execute(sql`select id, name, is_primary from accounting_books where org_id=${orgId} and is_active and posts_gl order by is_primary desc, code`) as any,
  ])
  const subsidiaries = authz.allowedSubsidiaryIds
    ? allSubsidiaries.filter((subsidiary) => authz.allowedSubsidiaryIds!.has(subsidiary.id))
    : allSubsidiaries
  const assetId = pickString(sp.asset)

  let drawer: React.ReactNode = assetId === 'new' && canManage ? <NewAssetRedirect /> : null
  if (assetId && assetId !== 'new' && isUuid(assetId)) {
    const [openAsset, pickers, fieldDefs] = await Promise.all([
      loadAsset(assetId, orgId, {
        bookId: pickString(sp.deprbook),
        query: pickString(sp.deprq) ?? '',
        page: Math.max(1, Number.parseInt(pickString(sp.deprpage) ?? '1', 10) || 1),
        perPage: 25,
      }),
      Promise.all([
        db.execute(sql`select id, name from asset_categories where org_id = ${orgId} and is_active order by name`) as any,
        db.execute(sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last`) as any,
        db.execute(sql`
          select r.code, r.name, r.class_attribute,
                 coalesce(jsonb_agg(jsonb_build_object('code', c.class_code, 'name', c.name) order by c.class_code)
                   filter (where c.class_code is not null), '[]'::jsonb) as classes
            from tax_regimes r
            left join tax_pool_classes c on c.org_id=r.org_id and c.regime=r.code and c.is_active
           where r.org_id=${orgId} and r.is_active
           group by r.code,r.name,r.class_attribute order by r.name`) as any,
        db.execute(sql`select id, code, name from depreciation_methods where org_id=${orgId} and is_active order by name`) as any,
      ]),
      loadFieldDefs('fixed_assets'),
    ])
    if (openAsset && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(openAsset.asset.subsidiary_id)))) {
      const resolvedForm = await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'fixed_asset',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: fieldDefs,
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
      const requestedReturn = pickString(sp.drawerReturn)
      drawer = (
        <AssetDrawer
          key={String(openAsset.asset.id)}
          payload={openAsset}
          categories={pickers[0].rows}
          accounts={pickers[1].rows}
          taxConfigurations={pickers[2].rows}
          depreciationMethods={pickers[3].rows}
          subsidiaries={multiSub ? subsidiaries : []}
          canManage={canManage}
          canCustomize={canCustomize}
          layout={resolvedForm.layout}
          forms={resolvedForm.available}
          currentFormId={resolvedForm.row?.id ?? null}
          fieldDefs={fieldDefs as any}
          closeHref={requestedReturn?.startsWith('/assets') ? requestedReturn : '/assets'}
        />
      )
    }
  }

  const actions = (
    <div className="flex items-center gap-2">
      <Link href="/docs/fixed-assets-depreciation" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
        {t('equipment.documentation')}
      </Link>
      {canManage ? <><RunDepreciationButton books={depreciationBooks.rows} /><NewAssetButton /></> : null}
    </div>
  )

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('list.title')} description={t('list.description')} actions={actions} />
          {tabsNav}
          <Link href="/assets/equipment" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
            {t('equipment.title')}
          </Link>
        </>
      }
    >
      <EntityListView
        recordType="fixed_asset"
        orgId={orgId}
        userId={authz.user.id}
        canManage={canCustomize}
        sp={sp}
        emptyAction={canManage ? <NewAssetButton /> : undefined}
        drawer={drawer}
      />
    </ListPageLayout>
  )
}
