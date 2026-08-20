import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { cn } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { payrollSettings } from '@openbooks/engine/src/payroll-run.ts'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { payrollSetupState } from '@openbooks/engine/src/payroll-readiness.ts'
import { payrollBankProfiles } from '@openbooks/engine/src/payroll-bank-file.ts'
import { packRemittanceVendorSettingsKeys, packSlotState, PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import { payrollTaxYearCoverage } from '@openbooks/engine/src/payroll/tax-years.ts'
import { pdfEncryptionAvailable } from '@openbooks/pdf'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { stubPasswordPolicy } from '../../../../../lib/payroll-outputs'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { pickString } from '../../../../../lib/list-params'
import { SETUP_ENTITY_BY_KEY, type SetupEntity } from '../../../../../lib/setup/registry'
import { PAY_DERIVED_RULES_ENTITY } from '../../../../../lib/setup/payroll-derived-rules'
import { PAYROLL_HOLIDAYS_ENTITY } from '../../../../../lib/setup/payroll-holidays'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { DerivedRulePreviewSection } from './DerivedRulePreviewSection'
import { HolidayCalendarSection } from './HolidayCalendarSection'
import { PayrollCountryPacks } from './PayrollCountryPacks'
import { PayrollPaydaySettings } from './PayrollPaydaySettings'
import { PayrollSetupLauncher } from './PayrollSetupLauncher'
import { PayrollSetupWorkspace } from './PayrollSetupWorkspace'
import { StatutoryRatesSection } from './StatutoryRatesSection'
import { StatHolidayPaySection } from './StatHolidayPaySection'
import { WorkSchedulesSection } from './WorkSchedulesSection'

export const dynamic = 'force-dynamic'

/**
 * Payroll setup — a two-level workspace. The TOP row is four GROUPS on the
 * house border-b tab strip (the Close-setup / Tax-setup subtab idiom); the
 * second level inside a group is the ModuleHomeTabs pill strip (the module
 * homes' route-tab switcher), so a dozen-plus surfaces never crowd one row.
 * Country packs are the front door; accounts & posting own
 * orgs.settings.payroll; schedules, components, and union agreements are the
 * re-homed registry entities that left the setup rail to live here.
 *
 * Deep links: every historical `?tab=` value keeps working — tab keys are
 * unchanged, the group is inferred FROM the tab, and the readiness Resolve
 * links that name a pack (`?tab=ca`, `?tab=us`) alias to the accounts tab
 * where the statutory slots are mapped.
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

/**
 * Derived earnings rules are an ordinary registry entity that has not been
 * spread into SETUP_ENTITIES yet (see .local/handoff-derived-earnings.md).
 * Prefer the registered descriptor the moment it exists so there is never a
 * second copy of the entity's shape in play.
 */
const derivedRulesEntity = (): SetupEntity =>
  SETUP_ENTITY_BY_KEY.get(PAY_DERIVED_RULES_ENTITY.key) ?? PAY_DERIVED_RULES_ENTITY

/** Same arrangement for observed statutory holidays — see
 *  .local/handoff-holidays.md for the registry.ts spread. */
const holidaysEntity = (): SetupEntity =>
  SETUP_ENTITY_BY_KEY.get(PAYROLL_HOLIDAYS_ENTITY.key) ?? PAYROLL_HOLIDAYS_ENTITY

export default async function PayrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const sp = await searchParams
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
  const group = GROUPS.find((g) => g.tabs.includes(tab)) ?? GROUPS[0]
  const t = await getTranslations('payroll.settingsPage')
  const canManageEntities = can(authz, 'admin.setup.manage')

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
  const subTabs = (group.tabs.filter((k) => available.includes(k))).map((key) => ({
    href: `/admin/setup/payroll?tab=${key}`,
    label: label(key),
    active: key === tab,
  }))

  const launcher = await launcherData(orgId, canManageEntities)

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {/* Re-launchable from the settings page — adding a second country
            pack walks the same wizard. */}
        <PayrollSetupLauncher variant="button" {...launcher} />
      </header>
      {launcher.missing > 0 && <PayrollSetupLauncher variant="banner" {...launcher} />}
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" aria-label={t('tabsAria')}>
        {groups.map((item) => (
          <Link
            key={item.key}
            href={`/admin/setup/payroll?tab=${item.tabs[0]}` as never}
            aria-current={group.key === item.key ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              group.key === item.key
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400',
            )}
          >
            {t(`groups.${item.key}`)}
          </Link>
        ))}
      </nav>
      <ModuleHomeTabs tabs={subTabs} />
      {tab === 'packs' ? <PacksTab orgId={orgId} /> : null}
      {tab === 'accounts' ? <AccountsTab orgId={orgId} /> : null}
      {tab === 'payday' ? <PaydayTab orgId={orgId} /> : null}
      {tab === 'rates' ? <StatutoryRatesSection /> : null}
      {isEntityTab(tab) ? (
        <SetupEntitySection
          entity={SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab])!}
          orgId={orgId}
          searchParams={sp}
          basePath="/admin/setup/payroll"
          canManage={canManageEntities}
        />
      ) : null}
      {tab === 'derived' ? (
        <SetupEntitySection
          entity={derivedRulesEntity()}
          orgId={orgId}
          searchParams={sp}
          basePath="/admin/setup/payroll"
          canManage={canManageEntities}
        />
      ) : null}
      {tab === 'derivedPreview' ? (
        <DerivedRulePreviewSection orgId={orgId} searchParams={sp} />
      ) : null}
      {tab === 'holidays' ? (
        <>
          {/* The stat-pay election lives WITH the holiday elections it governs. */}
          <StatHolidayPaySection statutoryHolidayPay={await statHolidayPayEnabled(orgId)} />
          <SetupEntitySection
            entity={holidaysEntity()}
            orgId={orgId}
            searchParams={sp}
            basePath="/admin/setup/payroll"
            canManage={canManageEntities}
          />
        </>
      ) : null}
      {tab === 'holidayCalendar' ? (
        <HolidayCalendarSection orgId={orgId} searchParams={sp} />
      ) : null}
      {tab === 'workSchedules' ? (
        <WorkSchedulesSection canManage={canManageEntities} />
      ) : null}
    </div>
  )
}

/** Everything the "Set up payroll" wizard launcher needs, computed once. */
async function launcherData(orgId: string, canManageEntities: boolean) {
  const [setup, bankProfiles, schedulesRes] = await Promise.all([
    payrollSetupState(orgId),
    payrollBankProfiles(orgId),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from pay_schedules
       where org_id = ${orgId} and is_active order by name`),
  ])
  // The pay-schedule form options come from the registry entity's OWN field
  // declaration — the wizard renders the same select the setup drawer does.
  const scheduleEntity = SETUP_ENTITY_BY_KEY.get('pay-schedules')
  const frequencies = (scheduleEntity?.fields.find((f) => f.key === 'frequency')?.options ?? [])
    .filter((option): option is { value: string; labelKey: string } => Boolean(option.labelKey))
    .map((option) => ({ value: option.value, labelKey: option.labelKey }))
  // Vendor fields per pack come from the pack declarations, so a new pack's
  // vendors step exists the moment the pack declares its keys.
  const vendorKeysByCountry = Object.fromEntries(
    Object.keys(PAYROLL_COUNTRY_PACKS).map((country) => [
      country, packRemittanceVendorSettingsKeys(country),
    ]),
  )
  const missing = setup.checks.filter((check) => !check.ok && check.severity === 'blocker').length
  return {
    missing,
    vendorKeysByCountry,
    frequencies,
    canManageEntities,
    schedules: schedulesRes.rows,
    bankProfiles: bankProfiles.map((p) => ({
      id: p.id, name: p.name, format: p.format, configured: p.configured,
    })),
  }
}

async function statHolidayPayEnabled(orgId: string): Promise<boolean> {
  const res = (await db.execute<{ v: string | null }>(sql`
    select settings#>>'{payroll,statutoryHolidayPay}' as v from orgs where id = ${orgId}
  `))
  return res.rows[0]?.v === 'true'
}

async function PacksTab({ orgId }: { orgId: string }) {
  const [countriesRes, componentsRes] = (await Promise.all([
    db.execute<{ countries: unknown }>(sql`select settings#>'{payroll,countries}' as countries from orgs where id = ${orgId}`),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from pay_components
       where org_id = ${orgId} and system_key is not null`),
  ]))
  const raw = countriesRes.rows[0]?.countries
  const installedCountries = Array.isArray(raw) ? raw.map(String) : []
  const componentCount = Number(componentsRes.rows[0]?.n ?? 0)

  return (
    <PayrollCountryPacks
      installedCountries={installedCountries}
      componentCount={componentCount}
      /* The packs' OWN tax-year declarations — every installed pack's loaded
         years and editions, not one country's constants imported by name. */
      coverage={payrollTaxYearCoverage().map((entry) => ({
        country: entry.country,
        supported: entry.supported,
        draft: entry.draft,
        ratesModule: entry.ratesModule,
        editions: entry.editions.map((edition) => ({
          year: edition.year,
          label: edition.label,
          effectiveFrom: edition.effectiveFrom,
          status: edition.status,
          region: edition.region ?? null,
        })),
      }))}
    />
  )
}

async function AccountsTab({ orgId }: { orgId: string }) {
  const [settings, blobRes, accountsRes, vendorsRes] = (await Promise.all([
    payrollSettings(orgId),
    db.execute<{ p: Record<string, unknown> | null }>(sql`select settings->'payroll' as p from orgs where id = ${orgId}`),
    db.execute<{ id: string; number: string | null; name: string }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute<{ id: string; name: string }>(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`),
  ]))
  const blob = blobRes.rows[0]?.p ?? {}
  const installed = Array.isArray(blob.countries) ? blob.countries.map(String) : []
  const packs = await packSlotState(orgId, installed, blob)

  return (
    <PayrollSetupWorkspace
      settings={settings}
      packs={packs}
      accounts={accountsRes.rows.map((account) => ({
        id: account.id,
        label: account.number ? `${account.number} · ${account.name}` : account.name,
      }))}
      vendors={vendorsRes.rows.map((vendor) => ({ id: vendor.id, label: vendor.name }))}
    />
  )
}

async function PaydayTab({ orgId }: { orgId: string }) {
  const [paymentMethods, stubPassword, encryptionAvailable, bankProfiles] = await Promise.all([
    payrollPaymentMethodSettings(orgId),
    stubPasswordPolicy(orgId),
    pdfEncryptionAvailable(),
    payrollBankProfiles(orgId),
  ])
  return (
    <PayrollPaydaySettings
      paymentMethods={paymentMethods}
      stubPassword={stubPassword}
      encryptionAvailable={encryptionAvailable}
      bankProfiles={bankProfiles.map((p) => ({
        id: p.id, name: p.name, format: p.format, configured: p.configured,
      }))}
    />
  )
}
