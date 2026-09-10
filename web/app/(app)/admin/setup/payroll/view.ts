import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  ref,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { PAY_DERIVED_RULES_ENTITY } from '../../../../../lib/setup/payroll-derived-rules'
import { PAYROLL_HOLIDAYS_ENTITY } from '../../../../../lib/setup/payroll-holidays'
import { PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import { launcherDataFor, type PayrollLauncherData } from './sections'

/**
 * The payroll setup workspace, split into a loader and a spec.
 *
 * This page is the setup workspace's odd sibling: it owns its own two-level
 * tab strip (house border-b group strip on top, ModuleHomeTabs pill row
 * beneath) rather than arriving through the generic entity list, and its
 * tabs are mutually exclusive bodies behind one `?tab=` param. Presence
 * flags (`onPacks`, `onAccounts`, …) choose exactly one of them; the spec
 * never branches, it only places blocks and lets all but one vanish — the
 * accounts-page precedent (`onList`/`onSearch`/`onHierarchy`) at its widest
 * so far.
 *
 * The deep-link contract is loader work, copied VERBATIM: every historical
 * `?tab=` value keeps working (the `available` filter drops unregistered
 * entity tabs so the workspace never links at a 404), two-letter country
 * codes alias to `accounts`, and anything unknown falls back to `packs`.
 * The group follows FROM the tab. The label helper keeps its fallbacks —
 * they are part of the byte contract because the message catalog may not
 * carry every key.
 *
 * Every tab body needs an org id, and the entity-backed bodies additionally
 * need a live registry entry plus the manage gate. None of those travel
 * through a spec, so the spec places one widget per tab and the registry
 * entries (INTEGRATION.md) render the `./sections` slots, which re-derive
 * everything from the session. The loader resolves only the tab key, the
 * labels, and the presence flags.
 *
 * Loader-resolved treatments (the harness lesson from /banking: a tile or
 * badge whose treatment the native markup decides conditionally must have
 * that decision made in the LOADER, never omitted): every subtab's
 * `active` boolean, every group strip's `activeGroup` flag, and every label
 * string travel as data. What the blocks cannot express — the active-vs-
 * plain link PAIR, aria-current set-vs-omitted — lives in the shared
 * `PayrollSetupTabs` chrome (./sections), used by both render paths.
 */

const ENTITY_BY_TAB = {
  filing: 'payroll-filing-accounts',
  schedules: 'pay-schedules',
  components: 'pay-components',
  union: 'union-agreements',
  // Entitlement plans (pay banks) and their two configuration surfaces: the
  // scoped caps, and the service-based schedules that raise a plan's accrual
  // rate or flip a pay component's eligibility on.
  entitlements: 'entitlement-plans',
  limits: 'entitlement-plan-limits',
  service: 'entitlement-service-tiers',
} as const

const TABS = [
  'packs', 'accounts', 'filing', 'schedules', 'components', 'union',
  // Employer-supplied statutory rates (experience-rated SUI, the FUTA credit
  // reduction, provincial employer health levies), at the scope the pack
  // declares each varies by.
  'rates',
  // The hours and days employees are normally scheduled to work — a generic
  // employment attribute (engine/src/work-schedules.ts) that several
  // jurisdictions' statutory holiday pay is computed FROM.
  'workSchedules',
  'entitlements', 'limits', 'service', 'derived', 'derivedPreview',
  // Statutory holidays: the employer's elections, then the resolved calendar
  // those elections produce. Same edit-then-confirm pairing as derived rules.
  'holidays', 'holidayCalendar',
  // Pay rails, EFT originator profiles, and stub delivery.
  'payday',
] as const
type Tab = (typeof TABS)[number]
type EntityTab = keyof typeof ENTITY_BY_TAB

const isEntityTab = (tab: Tab): tab is EntityTab => tab in ENTITY_BY_TAB

/** The two-level arrangement: ≤5 top-row groups, subtabs within. */
const GROUPS: { key: 'foundations' | 'earnings' | 'entitlements' | 'payday'; tabs: Tab[] }[] = [
  { key: 'foundations', tabs: ['packs', 'accounts', 'rates', 'schedules', 'workSchedules', 'filing'] },
  { key: 'earnings', tabs: ['components', 'derived', 'derivedPreview', 'holidays', 'holidayCalendar', 'union'] },
  { key: 'entitlements', tabs: ['entitlements', 'limits', 'service'] },
  { key: 'payday', tabs: ['payday'] },
]

export interface PayrollSetupData {
  title: string
  description: string
  launcher: PayrollLauncherData
  currentParams: Record<string, string | string[] | undefined>
  groups: { key: string; label: string; firstTab: string }[]
  activeGroup: string
  tabsAria: string
  subTabs: { href: string; label: string; active: boolean }[]
  onPacks: boolean
  onAccounts: boolean
  onPayday: boolean
  onRates: boolean
  onWorkSchedules: boolean
  onEntityTab: boolean
  entityKey: string | null
  onDerived: boolean
  onDerivedPreview: boolean
  onHolidays: boolean
  onHolidayCalendar: boolean
}

export async function loadPayrollSetup(
  sp: Record<string, string | string[] | undefined>,
): Promise<PayrollSetupData> {
  const authz = await requirePermission('payroll.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  // A subtab backed by a registry entity only exists while that entity is
  // registered, so the workspace never links at a 404.
  const available = TABS.filter((key) => !isEntityTab(key) || SETUP_ENTITY_BY_KEY.has(ENTITY_BY_TAB[key]))
  const requested = pickString(sp.tab)
  // Legacy alias: readiness slot items link `?tab=<country>` (ca, us, …);
  // those slots are mapped on the accounts tab.
  const aliased =
    requested && /^[a-z]{2}$/.test(requested) && requested.toUpperCase() in PAYROLL_COUNTRY_PACKS
      ? 'accounts'
      : requested
  const tab: Tab = aliased && (available as readonly string[]).includes(aliased) ? (aliased as Tab) : 'packs'
  const group = GROUPS.find((g) => g.tabs.includes(tab)) ?? GROUPS[0]!
  const t = await getTranslations('payroll.settingsPage')
  const canManageEntities = can(authz, 'admin.setup.manage')
  const launcher = await launcherDataFor({
    orgId,
    canManageEntities,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  })

  const tabLabel = (key: Tab, fallback: string) =>
    t.has(`tabs.${key}` as never) ? t(`tabs.${key}` as never) : fallback
  const label = (key: Tab): string =>
    key === 'derived'
      ? tabLabel(key, 'Derived Earnings')
      : key === 'derivedPreview'
        ? tabLabel(key, 'Rule Preview')
        : key === 'holidays'
          ? tabLabel(key, 'Holidays')
          : key === 'holidayCalendar'
            ? tabLabel(key, 'Holiday Calendar')
            : key === 'payday'
              ? tabLabel(key, 'Payday')
              : key === 'rates'
                ? tabLabel(key, 'Statutory Rates')
                : t(`tabs.${key}`)

  const groups = GROUPS
    .map((g) => ({ key: g.key, tabs: g.tabs.filter((k) => available.includes(k)) }))
    .filter((g) => g.tabs.length > 0)
  const subTabs = group.tabs.filter((k) => available.includes(k)).map((key) => ({
    href: `/admin/setup/payroll?tab=${key}`,
    label: label(key),
    active: key === tab,
  }))

  // Registry-backed tabs resolve like the native helpers: the registered
  // descriptor wins the moment it exists. The LOADER resolves each tab to a
  // plain entity KEY — SetupEntitySection needs a live entry, and entries
  // are code, so the lookup happens inside the slot. One `entityKey` field
  // serves all seven registry tabs: the presence flags are mutually
  // exclusive, so exactly one `setup-section` block ever reads it.
  const entityKeyFor = (key: Tab): string | null => {
    if (isEntityTab(key)) return ENTITY_BY_TAB[key]
    if (key === 'derived') return PAY_DERIVED_RULES_ENTITY.key
    if (key === 'holidays') return PAYROLL_HOLIDAYS_ENTITY.key
    return null
  }

  return {
    title: t('title'),
    description: t('description'),
    launcher,
    currentParams: sp,
    groups: groups.map((g) => ({
      key: g.key,
      label: t(`groups.${g.key}`),
      firstTab: g.tabs[0]!,
    })),
    activeGroup: group.key,
    tabsAria: t('tabsAria'),
    subTabs,
    onPacks: tab === 'packs',
    onAccounts: tab === 'accounts',
    onPayday: tab === 'payday',
    onRates: tab === 'rates',
    onWorkSchedules: tab === 'workSchedules',
    onEntityTab: isEntityTab(tab),
    entityKey: entityKeyFor(tab),
    onDerived: tab === 'derived',
    onDerivedPreview: tab === 'derivedPreview',
    onHolidays: tab === 'holidays',
    onHolidayCalendar: tab === 'holidayCalendar',
  }
}

const f = ref<PayrollSetupData>()

/**
 * The full tab workspace. Each body block carries its own presence flag;
 * exactly one survives on any render. The bodies resolve org id, registry
 * entries and gates inside their slots — the spec carries only keys, URLs
 * and flags.
 */
export function payrollSetupSpec(data: PayrollSetupData): PageSpec {
  const basePath = '/admin/setup/payroll'
  return page({
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome. The native
    // page owns its outer `<div className="space-y-5">`, so the spec places
    // the same element — the [entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-5', [
        // Custom header: the native page owns an `<header>` (h1 +
        // description + launcher button) that no PageHeader block can
        // express, so the whole row is one shared component over
        // loader-resolved strings plus the launcher payload. The banner's
        // `missing > 0` presence lives inside its shared component too.
        widgetBlock('payroll-setup-header', {
          title: data.title,
          description: data.description,
          launcher: data.launcher,
        }),
        widgetBlock('payroll-setup-banner', { launcher: data.launcher }),
        // Group strip + subtab pills: shared chrome, one widget. The
        // active-vs-plain link PAIR lives in the shared component.
        widgetBlock('payroll-setup-tabs', {
          groups: data.groups,
          activeGroup: data.activeGroup,
          tabsAria: data.tabsAria,
          subTabs: data.subTabs,
        }),
        // Tab bodies. Exactly one presence flag is true per render.
        {
          ...widgetBlock('payroll-packs-tab', {}),
          when: f('onPacks'),
        },
        {
          ...widgetBlock('payroll-accounts-tab', {}),
          when: f('onAccounts'),
        },
        {
          ...widgetBlock('payroll-payday-tab', {}),
          when: f('onPayday'),
        },
        {
          ...widgetBlock('payroll-rates-tab', {}),
          when: f('onRates'),
        },
        {
          ...widgetBlock('payroll-schedules-tab', {}),
          when: f('onWorkSchedules'),
        },
        // Seven registry-entity tabs share the `setup-section` SLOT
        // (already registered): the slot re-derives org id, entry and
        // manage gate from the session. `onEntityTab` covers filing,
        // schedules, components, union, entitlements, limits and service —
        // the flags are mutually exclusive, so exactly one block ever reads
        // `entityKey`.
        {
          ...widgetBlock('setup-section', {
            entityKey: data.entityKey,
            sp: data.currentParams,
            basePath,
          }),
          when: f('onEntityTab'),
        },
        // The derived tab's entity is not yet in the registry: same slot,
        // same session-derived lookup, key resolved by the loader.
        {
          ...widgetBlock('setup-section', {
            entityKey: data.entityKey,
            sp: data.currentParams,
            basePath,
          }),
          when: f('onDerived'),
        },
        {
          ...widgetBlock('payroll-derived-preview-tab', { sp: data.currentParams }),
          when: f('onDerivedPreview'),
        },
        {
          ...widgetBlock('payroll-holidays-tab', {
            sp: data.currentParams,
            basePath,
          }),
          when: f('onHolidays'),
        },
        {
          ...widgetBlock('payroll-holiday-calendar-tab', { sp: data.currentParams }),
          when: f('onHolidayCalendar'),
        },
      ]),
    ],
  })
}
