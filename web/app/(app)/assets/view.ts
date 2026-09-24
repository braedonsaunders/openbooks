import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { listTaxRegimes } from '@openbooks/engine/src/tax-returns/pool-run.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'
import { loadAsset, type AssetCategoryRow as ApiAssetCategoryRow, type AssetPayload } from '../../api/assets/_lib'
import { assetAccountScopeSql } from '../../api/assets/_fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'
import type { AssetDrawer } from './AssetDrawer'
import { assetWorkspaceTabs } from './tabs'

/**
 * The fixed-asset register, split into a loader and a spec.
 *
 * Two searchParam-driven fixed-asset views over very different machinery,
 * presented in the shared header switcher beside the Equipment route:
 *
 *  - `register` is the universal EntityListView (`fixed_asset`), so the list
 *    itself arrives through the slot that re-derives Authz server-side. The
 *    spec carries only the record type, the current params, and widget refs
 *    for the drawer and the empty-state action — never an org id.
 *  - `tax-depreciation` is the interactive TaxPoolsView client island (a run
 *    button plus a result table kept in component state), so it is one widget,
 *    like the approvals table.
 *
 * The drawer keeps its remount key riding along as a prop: switching assets
 * must reset the drawer's client state, and a widget at a fixed position
 * would otherwise be reused. Route switching itself uses ModuleHomeTabs,
 * exactly like every other page-level subtab strip.
 */

type AssetDrawerProps = Parameters<typeof AssetDrawer>[0]

/** Picker rows for the asset drawer: books, categories, GL accounts (number
 *  is nullable), tax regimes with their pool classes, and methods. */
type AssetBookRow = { id: string; name: string; is_primary: boolean }
type AssetCategoryRow = { id: string; name: string }
type AssetAccountRow = { id: string; number: string | null; name: string }
type AssetTaxRegimeRow = {
  code: string
  name: string
  class_attribute: string
  classes: { code: string; name: string }[]
}
type AssetMethodRow = { id: string; code: string; name: string }
type DepreciationCandidateRow = { id: string; asset_number: string; name: string; status: string }
type DepreciationPeriodRow = { id: string; name: string; starts_on: string; ends_on: string }

export interface AssetsData {
  title: string
  description: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  onRegister: boolean
  onTax: boolean
  docLabel: string
  showActions: boolean
  books: { id: string; name: string; is_primary?: boolean }[]
  /** Depreciable-register candidates for the review drawer picker. */
  candidates: { id: string; number: string; name: string; status: string }[]
  /** Valid accounting periods for the review drawer period control. */
  periods: { id: string; name: string; startsOn: string; endsOn: string }[]
  /** Compatibility data for tenant PageSpecs saved before Equipment became a tab. */
  equipmentLabel: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  canRun: boolean
  canConfigure: boolean
  regimes: { code: string; name: string }[]
  defaultTaxYear: number
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadAssets(
  sp: Record<string, string | string[] | undefined>,
): Promise<AssetsData> {
  const t = await getTranslations('assets')
  const authz = await requirePermission('assets.read')
  await requireFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const canManage = can(authz, 'assets.manage')
  const canSetupTaxDepreciation = can(authz, 'admin.setup.manage')
  const canCustomize = can(authz, 'admin.customization.manage')
  const orgId = authz.user.orgId

  const tab = pickString(sp.tab) === 'tax-depreciation' ? 'tax-depreciation' : 'register'
  const equipmentEnabled = await isFeatureEnabled(orgId, 'equipment')
  const tabs = assetWorkspaceTabs({
    active: tab,
    registerLabel: t('tabs.register'),
    taxDepreciationLabel: t('tabs.taxDepreciation'),
    equipmentLabel: t('equipment.title'),
    showFixedAssets: true,
    showEquipment: equipmentEnabled,
  })

  const base = {
    title: t('list.title'),
    description: t('list.description'),
    tabs,
    onRegister: tab === 'register',
    onTax: tab === 'tax-depreciation',
    docLabel: t('equipment.documentation'),
    showActions: false,
    books: [] as AssetsData['books'],
    candidates: [] as AssetsData['candidates'],
    periods: [] as AssetsData['periods'],
    equipmentLabel: t('equipment.title'),
    currentParams: sp,
    canManage,
    canRun: false,
    canConfigure: canSetupTaxDepreciation,
    regimes: [] as AssetsData['regimes'],
    defaultTaxYear: 0,
    showNewRedirect: false,
    drawer: null as AssetsData['drawer'],
  }

  if (tab === 'tax-depreciation') {
    const [regimes, today] = await Promise.all([listTaxRegimes(orgId), businessToday(orgId)])
    return {
      ...base,
      canRun: canManage,
      regimes: regimes.map((regime) => ({ code: regime.code, name: regime.name })),
      // Last completed calendar year on the org business day — never browser UTC.
      defaultTaxYear: Number(today.slice(0, 4)) - 1,
    }
  }

  const [multiSub, allSubsidiaries, depreciationBooks, depreciationPeriods, depreciationCandidates] = await Promise.all([
    isMultiSubsidiary(orgId),
    subsidiaryOptions(),
    db.execute<AssetBookRow>(sql`select id, name, is_primary from accounting_books where org_id=${orgId} and is_active order by is_primary desc, code`),
    db.execute<DepreciationPeriodRow>(sql`select id, name, starts_on::text as starts_on, ends_on::text as ends_on from accounting_periods where org_id=${orgId} and not is_adjustment order by starts_on desc`),
    // Picker rows for the review drawer: live depreciable register only.
    // Reader-scoped like the drawer payload — never the whole tenant.
    db.execute<DepreciationCandidateRow>(authz.allowedSubsidiaryIds
      ? sql`select id, asset_number, name, status from fixed_assets where org_id=${orgId} and status in ('in_service','fully_depreciated') and subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(",")}}`}::uuid[]) order by asset_number`
      : sql`select id, asset_number, name, status from fixed_assets where org_id=${orgId} and status in ('in_service','fully_depreciated') order by asset_number`),
  ])
  const subsidiaries = authz.allowedSubsidiaryIds
    ? allSubsidiaries.filter((subsidiary) => authz.allowedSubsidiaryIds!.has(subsidiary.id))
    : allSubsidiaries
  const assetId = pickString(sp.asset)

  const showNewRedirect = assetId === 'new' && canManage
  // Unsaved create: ?assetNew=1 opens the SAME tenant-customizable drawer on
  // an in-memory payload over no record — identical layout, custom fields,
  // and tax elections to edit. The loader performs only picker reads here:
  // no draft row, no FA-#### number, no category write, no audit row.
  // Allocation happens on Save in POST /api/assets, which routes back to
  // ?asset=<persisted id>.
  const creating = pickString(sp.assetNew) === '1' && canManage
  const requestedReturn = pickString(sp.drawerReturn)
  const createCloseHref = requestedReturn?.startsWith('/assets')
    ? requestedReturn
    : mergeHref('/assets', sp, {
        asset: undefined,
        assetNew: undefined,
        drawerReturn: undefined,
      })
  let drawer: AssetsData['drawer'] = null
  if (creating && tab === 'register') {
    const [createPickers, createFieldDefs] = await Promise.all([
      Promise.all([
        db.execute<ApiAssetCategoryRow>(sql`select id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, default_method, default_depreciation_method_id, default_life_months, default_convention, tax_attributes from asset_categories where org_id = ${orgId} and is_active order by name`),
        db.execute<AssetAccountRow>(sql`select a.id, a.number, a.name from accounts a where a.org_id = ${orgId} and a.is_active and not a.is_summary ${assetAccountScopeSql(orgId, authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null)} order by a.number nulls last`),
        db.execute<AssetTaxRegimeRow>(sql`
          select r.code, r.name, r.class_attribute,
                 coalesce(jsonb_agg(jsonb_build_object('code', c.class_code, 'name', c.name) order by c.class_code)
                   filter (where c.class_code is not null), '[]'::jsonb) as classes
            from tax_regimes r
            left join tax_pool_classes c on c.org_id=r.org_id and c.regime=r.code and c.is_active
           where r.org_id=${orgId} and r.is_active
           group by r.code,r.name,r.class_attribute order by r.name`),
        db.execute<AssetMethodRow>(sql`select id, code, name from depreciation_methods where org_id=${orgId} and is_active order by name`),
      ]),
      loadFieldDefs('fixed_assets'),
    ])
    const createCategory = createPickers[0].rows[0] ?? null
    const createSubsidiaryId = subsidiaries[0]?.id ?? null
    const createPayload: AssetPayload = {
      asset: {
        id: '',
        category_id: createCategory?.id ?? '',
        subsidiary_id: createSubsidiaryId ?? '',
        asset_number: '',
        name: '',
        description: null,
        status: 'draft',
        acquired_on: null,
        in_service_on: null,
        acquisition_cost: '0.0000',
        salvage_value: '0.0000',
        serial_number: null,
        depreciation_method: null,
        depreciation_method_id: null,
        useful_life_months: null,
        depreciation_rate_percent: null,
        depreciation_convention: null,
        depreciation_units_total: null,
        opening_accumulated_depreciation: null,
        opening_accumulated_as_of: null,
        custom: {},
        updated_at: '',
        asset_account_id: null,
        accumulated_depreciation_account_id: null,
        depreciation_expense_account_id: null,
      },
      category: createCategory,
      accounts: {
        assetAccountId: null,
        accumulatedDepreciationAccountId: null,
        depreciationExpenseAccountId: null,
      },
      accountNames: { asset: null, accumulated: null, expense: null },
      totals: {
        remainingCost: '0.0000',
        accumulated: '0.0000',
        netBookValue: '0.0000',
        posted: '0.0000',
        planned: '0.0000',
      },
      books: [],
      schedulePage: { total: 0, page: 1, perPage: 25, bookId: null, query: '' },
      hasAccountingEvidence: false,
      schedule: [],
    }
    const createForm = await resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: 'fixed_asset',
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: createFieldDefs,
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    })
    drawer = {
      remountKey: 'new-asset',
      payload: createPayload,
      categories: createPickers[0].rows,
      accounts: createPickers[1].rows,
      taxConfigurations: createPickers[2].rows,
      subsidiaries: multiSub ? subsidiaries : [],
      canManage,
      canManageSetup: canSetupTaxDepreciation,
      canCustomize,
      layout: createForm.layout,
      forms: createForm.available,
      currentFormId: createForm.row?.id ?? null,
      fieldDefs: createFieldDefs as AssetDrawerProps['fieldDefs'],
      depreciationMethods: createPickers[3].rows,
      periods: [] as AssetDrawerProps['periods'],
      closeHref: createCloseHref,
      createMode: true,
    }
  }
  if (assetId && assetId !== 'new' && isUuid(assetId)) {
    const [openAsset, pickers, fieldDefs] = await Promise.all([
      loadAsset(assetId, orgId, {
        bookId: pickString(sp.deprbook),
        query: pickString(sp.deprq) ?? '',
        page: Math.max(1, Number.parseInt(pickString(sp.deprpage) ?? '1', 10) || 1),
        perPage: 25,
      }),
      Promise.all([
        db.execute<AssetCategoryRow>(sql`select id, name from asset_categories where org_id = ${orgId} and is_active order by name`),
        db.execute<AssetAccountRow>(sql`select a.id, a.number, a.name from accounts a where a.org_id = ${orgId} and a.is_active and not a.is_summary ${assetAccountScopeSql(orgId, authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null)} order by a.number nulls last`),
        db.execute<AssetTaxRegimeRow>(sql`
          select r.code, r.name, r.class_attribute,
                 coalesce(jsonb_agg(jsonb_build_object('code', c.class_code, 'name', c.name) order by c.class_code)
                   filter (where c.class_code is not null), '[]'::jsonb) as classes
            from tax_regimes r
            left join tax_pool_classes c on c.org_id=r.org_id and c.regime=r.code and c.is_active
           where r.org_id=${orgId} and r.is_active
           group by r.code,r.name,r.class_attribute order by r.name`),
        db.execute<AssetMethodRow>(sql`select id, code, name from depreciation_methods where org_id=${orgId} and is_active order by name`),
      ]),
      loadFieldDefs('fixed_assets'),
    ])
    if (
      openAsset &&
      (!authz.allowedSubsidiaryIds ||
        authz.allowedSubsidiaryIds.has(String(openAsset.asset.subsidiary_id)))
    ) {
      const resolvedForm = await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'fixed_asset',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: fieldDefs,
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
      const editRequestedReturn = pickString(sp.drawerReturn)
      drawer = {
        remountKey: String(openAsset.asset.id),
        payload: openAsset as AssetPayload,
        categories: pickers[0].rows,
        accounts: pickers[1].rows,
        taxConfigurations: pickers[2].rows,
        subsidiaries: multiSub ? subsidiaries : [],
        canManage,
        canManageSetup: canSetupTaxDepreciation,
        canCustomize,
        layout: resolvedForm.layout,
        forms: resolvedForm.available,
        currentFormId: resolvedForm.row?.id ?? null,
        fieldDefs: fieldDefs as AssetDrawerProps['fieldDefs'],
        depreciationMethods: pickers[3].rows,
        periods: depreciationPeriods.rows.map((row) => ({
          id: row.id,
          name: row.name,
          startsOn: row.starts_on,
          endsOn: row.ends_on,
        })),
        closeHref: editRequestedReturn?.startsWith('/assets') ? editRequestedReturn : '/assets',
      }
    }
  }

  return {
    ...base,
    showActions: canManage,
    books: depreciationBooks.rows as AssetsData['books'],
    candidates: depreciationCandidates.rows.map((row) => ({
      id: row.id,
      number: row.asset_number,
      name: row.name,
      status: row.status,
    })),
    periods: depreciationPeriods.rows.map((row) => ({
      id: row.id,
      name: row.name,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
    })),
    showNewRedirect,
    drawer,
  }
}

const f = ref<AssetsData>()

export function assetsSpec(data: AssetsData): PageSpec {
  const newAsset = {
    widget: 'new-asset',
    props: { currentParams: data.currentParams },
  }
  const runDepreciation = {
    widget: 'run-depreciation',
    props: { books: data.books, candidates: data.candidates, periods: data.periods },
  }
  return page({
    route: '/assets',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [
          widget('assets-doc-link', { label: data.docLabel }, f('onRegister')),
          widget(runDepreciation.widget, runDepreciation.props, f('showActions')),
          widget(newAsset.widget, newAsset.props, f('showActions')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'fixed_asset',
          sp: data.currentParams,
          // Rendered in the native page's order: the create-redirect first,
          // then the record flyout (which renders createMode for ?assetNew=1).
          drawer: [
            data.showNewRedirect ? { widget: 'new-asset-redirect', props: {} } : null,
            data.drawer ? { widget: 'asset-drawer', props: { drawer: data.drawer } } : null,
          ].filter(Boolean),
          emptyAction: data.canManage ? newAsset : null,
        }),
        when: f('onRegister'),
      },
      {
        ...widgetBlock('tax-pools', {
          canRun: data.canRun,
          canConfigure: data.canConfigure,
          regimes: data.regimes,
          defaultTaxYear: data.defaultTaxYear,
        }),
        when: f('onTax'),
      },
    ],
  })
}
