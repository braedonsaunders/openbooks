import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { taxDepreciationPacks } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { grid, page, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import type {
  TaxDepreciationOverview,
  TaxDepreciationSetupTabs,
} from './sections'

/**
 * The tax-depreciation setup workspace, split into a loader and a spec.
 *
 * Four mutually exclusive bodies behind one `?tab=` param — the payroll
 * precedent. The overview body is a client component (pack install and
 * assignment Selects are fetch flows plus useState a spec cannot name), so
 * it renders through a WHOLE-COMPONENT slot: the loader resolves every prop
 * the page passed `TaxDepreciationSetup` (company country, packs,
 * installed codes, regime groups, category assignments) to presentation-ready
 * data, and the slot re-derives nothing — the props are data, not
 * capabilities. The three registry-backed tabs (`regimes`, `classes`,
 * `first-year`) arrive through the already-registered `setup-section` slot,
 * which re-derives org id, entry and manage gate from the session.
 *
 * The loader copies the native page VERBATIM: the `admin.setup.manage`
 * gate, the `fixedAssets` feature gate, the tab fallback to `overview`, the
 * four queries, and the `classes.rows.reduce` regime-grouping.
 */

const ENTITY_BY_TAB = {
  regimes: 'tax-regimes',
  classes: 'tax-pool-classes',
  'first-year': 'tax-first-year-rules',
} as const
type Tab = 'overview' | keyof typeof ENTITY_BY_TAB

export interface TaxDepreciationSetupData {
  title: string
  description: string
  /** `max-w-3xl` only on the overview branch — loader-resolved, verbatim. */
  descriptionClassName: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: TaxDepreciationSetupTabs
  tabsAria: string
  onOverview: boolean
  onEntityTab: boolean
  /** The registry key for the active entity tab; null on overview. */
  entityKey: string | null
  overview: TaxDepreciationOverview
}

export async function loadTaxDepreciationSetup(
  sp: Record<string, string | string[] | undefined>,
): Promise<TaxDepreciationSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'fixedAssets')
  const requested = pickString(sp.tab)
  const tab: Tab =
    requested && (requested === 'overview' || requested in ENTITY_BY_TAB)
      ? (requested as Tab)
      : 'overview'
  const t = await getTranslations('admin.setup.taxDepreciationSetup')
  // The native page reads the tabs straight from the registry; the keys all
  // exist, so an entity tab the registry dropped would 404 in SetupDrawer —
  // same belt-and-braces `available` filter the payroll page uses.
  const available: readonly Tab[] = (
    ['overview', 'regimes', 'classes', 'first-year'] as Tab[]
  ).filter((key) => key === 'overview' || SETUP_ENTITY_BY_KEY.has(ENTITY_BY_TAB[key]))
  const active: Tab = available.includes(tab) ? tab : 'overview'
  const tabHref = (key: Tab): string => `/admin/setup/tax-depreciation?tab=${key}`
  const tabs: TaxDepreciationSetupData['tabs'] = [
    { key: 'overview', href: tabHref('overview'), label: t('tabs.overview'), active: active === 'overview' },
    { key: 'regimes', href: tabHref('regimes'), label: t('tabs.regimes'), active: active === 'regimes' },
    { key: 'classes', href: tabHref('classes'), label: t('tabs.classes'), active: active === 'classes' },
    { key: 'first-year', href: tabHref('first-year'), label: t('tabs.firstYear'), active: active === 'first-year' },
  ]

  // The four overview queries, copied verbatim. The native page awaits them
  // only on the overview branch (after the early entity-tab return); the
  // loader keeps one code path and runs them unconditionally, so the spec
  // data is branch-independent.
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

  return {
    title: t('title'),
    description: t('description'),
    descriptionClassName:
      active === 'overview'
        ? 'mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400'
        : 'mt-1 text-sm text-slate-500 dark:text-slate-400',
    currentParams: sp,
    tabs,
    tabsAria: t('tabsAria'),
    onOverview: active === 'overview',
    onEntityTab: active !== 'overview',
    entityKey: active === 'overview' ? null : ENTITY_BY_TAB[active],
    overview: {
      companyCountry: org.rows[0]?.country ?? '',
      packs: taxDepreciationPacks(),
      installedCodes: installed.rows.map((row) => row.code),
      regimes: Object.values(
        classes.rows.reduce<
          Record<string, { code: string; name: string; classAttribute: string; classes: { code: string; name: string }[] }>
        >((all, row) => {
          const regime = all[row.regime] ?? {
            code: row.regime,
            name: row.regime_name,
            classAttribute: row.class_attribute,
            classes: [],
          }
          regime.classes.push({ code: row.class_code, name: row.class_name })
          all[row.regime] = regime
          return all
        }, {}),
      ),
      categories: categories.rows.map((category) => ({
        id: category.id,
        name: category.name,
        taxAttributes: category.tax_attributes ?? {},
      })),
    },
  }
}

const f = ref<TaxDepreciationSetupData>()

/**
 * The full tab workspace. The header (h1 + description) and the tab strip
 * are shared chrome the spec cannot express (the active-vs-plain link PAIR,
 * aria-current set-vs-omitted); the overview body is a whole-component slot
 * over loader-resolved props; the entity tabs are the registered
 * `setup-section` slot. Exactly one body block survives per render.
 */
export function taxDepreciationSetupSpec(data: TaxDepreciationSetupData): PageSpec {
  const basePath = '/admin/setup/tax-depreciation'
  return page({
    route: '/admin/setup/tax-depreciation',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome. The native
    // page owns its outer `<div className="space-y-5">`, so the spec places
    // the same element — the payroll/[entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-5', [
        widgetBlock('tax-depreciation-header', {
          title: data.title,
          description: data.description,
          descriptionClassName: data.descriptionClassName,
          tabs: data.tabs,
          tabsAria: data.tabsAria,
        }),
        {
          ...widgetBlock('tax-depreciation-overview', { overview: data.overview }),
          when: f('onOverview'),
        },
        // The three registry-entity tabs share the `setup-section` SLOT
        // (already registered): the slot re-derives org id, entry and manage
        // gate from the session. `onEntityTab` covers regimes, classes and
        // first-year — the flags are mutually exclusive, so exactly one
        // block ever reads `entityKey`.
        {
          ...widgetBlock('setup-section', {
            entityKey: data.entityKey,
            sp: data.currentParams,
            basePath,
          }),
          when: f('onEntityTab'),
        },
      ]),
    ],
  })
}
