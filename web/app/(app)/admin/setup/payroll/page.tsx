import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  payrollSettings,
  statutoryHolidayPayEnabled,
  type PayrollSubsidiaryScope,
} from '@openbooks/engine/src/payroll-run.ts'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { payrollBankProfiles } from '@openbooks/engine/src/payroll-bank-file.ts'
import { packSlotState, PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import { payrollTaxYearCoverage } from '@openbooks/engine/src/payroll/tax-years.ts'
import { pdfEncryptionAvailable } from '@openbooks/pdf'
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
import { PayrollSetupWorkspace } from './PayrollSetupWorkspace'
import { StatutoryRatesSection } from './StatutoryRatesSection'
import { StatHolidayPaySection } from './StatHolidayPaySection'
import { WorkSchedulesSection } from './WorkSchedulesSection'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPayrollSetup, payrollSetupSpec } from './view'
import { PayrollSetupBanner, PayrollSetupHeader, PayrollSetupTabs, launcherDataFor } from './sections'

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
 * spread into SETUP_ENTITIES yet.
 * Prefer the registered descriptor the moment it exists so there is never a
 * second copy of the entity's shape in play.
 */
const derivedRulesEntity = (): SetupEntity =>
  SETUP_ENTITY_BY_KEY.get(PAY_DERIVED_RULES_ENTITY.key) ?? PAY_DERIVED_RULES_ENTITY

/** Same arrangement for observed statutory holidays. */
const holidaysEntity = (): SetupEntity =>
  SETUP_ENTITY_BY_KEY.get(PAYROLL_HOLIDAYS_ENTITY.key) ?? PAYROLL_HOLIDAYS_ENTITY

export default async function PayrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadPayrollSetup(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={payrollSetupSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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
  const group = GROUPS.find((g) => g.tabs.includes(tab)) ?? GROUPS[0]!
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

  const launcher = await launcherDataFor({ orgId, canManageEntities, allowedSubsidiaryIds: authz.allowedSubsidiaryIds })

  return (
    <div className="space-y-5">
      <PayrollSetupHeader title={t('title')} description={t('description')} launcher={launcher} />
      <PayrollSetupBanner launcher={launcher} />
      <PayrollSetupTabs
        groups={groups.map((g) => ({ key: g.key, label: t(`groups.${g.key}`), firstTab: g.tabs[0]! }))}
        activeGroup={group.key}
        tabsAria={t('tabsAria')}
        subTabs={subTabs}
      />
      {tab === 'packs' ? <PacksTab orgId={orgId} /> : null}
      {tab === 'accounts' ? <AccountsTab orgId={orgId} allowedSubsidiaryIds={authz.allowedSubsidiaryIds} /> : null}
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
          <StatHolidayPaySection
            statutoryHolidayPay={await statutoryHolidayPayEnabled(orgId, undefined, authz.allowedSubsidiaryIds)}
          />
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

async function AccountsTab({
  orgId,
  allowedSubsidiaryIds,
}: {
  orgId: string
  allowedSubsidiaryIds?: PayrollSubsidiaryScope
}) {
  const [settings, blobRes, accountsRes, vendorsRes] = (await Promise.all([
    payrollSettings(orgId, allowedSubsidiaryIds),
    db.execute<{ p: Record<string, unknown> | null }>(sql`select settings->'payroll' as p from orgs where id = ${orgId}`),
    db.execute<{ id: string; number: string | null; name: string }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute<{ id: string; name: string }>(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active
         and (${allowedSubsidiaryIds == null
           ? sql`true`
           : allowedSubsidiaryIds.size > 0
             ? sql`coalesce(p.subsidiary_id, (select root.id from subsidiaries root
                    where root.org_id = ${orgId} and root.parent_id is null and root.is_active
                    order by root.created_at limit 1)) in (${sql.join(
                      [...allowedSubsidiaryIds].map((id) => sql`${id}`), sql`, `,
                    )})`
             : sql`false`})
       order by p.display_name`),
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
