import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { listTaxRegimes } from '@openbooks/engine/src/tax-pool-run.ts'
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
import { isUuid, pickString } from '../../../lib/list-params'
import { loadAsset, type AssetPayload } from '../../api/assets/_lib'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../lib/custom-fields'
import type { AssetDrawer } from './AssetDrawer'

/**
 * The fixed-asset register, split into a loader and a spec.
 *
 * Two searchParam-driven tabs over very different machinery:
 *
 *  - `register` is the universal EntityListView (`fixed_asset`), so the list
 *    itself arrives through the slot that re-derives Authz server-side. The
 *    spec carries only the record type, the current params, and widget refs
 *    for the drawer and the empty-state action — never an org id.
 *  - `tax-depreciation` is the interactive TaxPoolsView client island (a run
 *    button plus a result table kept in component state), so it is one widget,
 *    like the approvals table.
 *
 * Two wrappers the spec cannot re-express: the register tab strip is a small
 * local nav (exact classes the native page uses), and the drawer is the
 * AssetDrawer with its remount key riding along as a prop — switching assets
 * must reset the drawer's client state, and a widget at a fixed position
 * would otherwise be reused.
 */

type AssetDrawerProps = Parameters<typeof AssetDrawer>[0]

export interface AssetsData {
  title: string
  description: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  onRegister: boolean
  onTax: boolean
  docLabel: string
  showActions: boolean
  books: { id: string; name: string; is_primary?: boolean }[]
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
  const tabs = [
    { key: 'register', href: '/assets', label: t('tabs.register'), active: tab === 'register' },
    {
      key: 'tax-depreciation',
      href: '/assets?tab=tax-depreciation',
      label: t('tabs.taxDepreciation'),
      active: tab === 'tax-depreciation',
    },
  ]

  const base = {
    title: t('list.title'),
    description: t('list.description'),
    tabs,
    onRegister: tab === 'register',
    onTax: tab === 'tax-depreciation',
    docLabel: t('equipment.documentation'),
    showActions: false,
    books: [] as AssetsData['books'],
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

  const [multiSub, allSubsidiaries, depreciationBooks] = await Promise.all([
    isMultiSubsidiary(orgId),
    subsidiaryOptions(),
    db.execute(sql`select id, name, is_primary from accounting_books where org_id=${orgId} and is_active and posts_gl order by is_primary desc, code`) as any,
  ])
  const subsidiaries = authz.allowedSubsidiaryIds
    ? allSubsidiaries.filter((subsidiary) => authz.allowedSubsidiaryIds!.has(subsidiary.id))
    : allSubsidiaries
  const assetId = pickString(sp.asset)

  const showNewRedirect = assetId === 'new' && canManage
  let drawer: AssetsData['drawer'] = null
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
      const requestedReturn = pickString(sp.drawerReturn)
      drawer = {
        remountKey: String(openAsset.asset.id),
        payload: openAsset as AssetPayload,
        categories: pickers[0].rows,
        accounts: pickers[1].rows,
        taxConfigurations: pickers[2].rows,
        subsidiaries: multiSub ? subsidiaries : [],
        canManage,
        canCustomize,
        layout: resolvedForm.layout,
        forms: resolvedForm.available,
        currentFormId: resolvedForm.row?.id ?? null,
        fieldDefs: fieldDefs as AssetDrawerProps['fieldDefs'],
        depreciationMethods: pickers[3].rows,
        closeHref: requestedReturn?.startsWith('/assets') ? requestedReturn : '/assets',
      }
    }
  }

  return {
    ...base,
    showActions: canManage,
    books: depreciationBooks.rows as AssetsData['books'],
    showNewRedirect,
    drawer,
  }
}

const f = ref<AssetsData>()

export function assetsSpec(data: AssetsData): PageSpec {
  const newAsset = {
    widget: 'new-asset',
    props: {},
  }
  const runDepreciation = {
    widget: 'run-depreciation',
    props: { books: data.books },
  }
  return page({
    route: '/assets',
    layout: 'list',
    header: [
      // Two headers, not one with conditional actions: the native tax tab
      // renders PageHeader with NO actions prop (no actions wrapper at all),
      // while the register tab always renders the doc link plus — for a
      // manager — the run/create buttons inside a flex row of its own.
      {
        ...pageHeader({
          title: f('title'),
          description: f('description'),
          actionsClassName: 'flex items-center gap-2',
          actions: [
            widget('assets-doc-link', { label: data.docLabel }),
            widget(runDepreciation.widget, runDepreciation.props, f('showActions')),
            widget(newAsset.widget, newAsset.props, f('showActions')),
          ],
        }),
        when: f('onRegister'),
      },
      {
        ...pageHeader({
          title: f('title'),
          description: f('description'),
        }),
        when: f('onTax'),
      },
      widgetBlock('assets-tabs', { tabs: data.tabs }),
      {
        ...widgetBlock('assets-equipment-link', { label: data.equipmentLabel }),
        when: f('onRegister'),
      },
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'fixed_asset',
          sp: data.currentParams,
          // Rendered in the native page's order: the create-redirect first,
          // then the record flyout.
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
