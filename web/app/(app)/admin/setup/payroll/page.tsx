import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { cn } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { caPayrollConfig, payrollSettings, usPayrollConfig } from '@openbooks/engine/src/payroll-run.ts'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { packSlotState } from '@openbooks/engine/src/payroll/packs.ts'
import { RATES_2026_JAN, RATES_2026_JUL } from '@openbooks/engine/src/payroll/canada/rates.ts'
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
import { PayrollSetupWorkspace } from './PayrollSetupWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Payroll setup — a subtabbed workspace in the Tax Setup mold. Country packs
 * (the statutory engines, presented as installable jurisdictions) are the
 * front door; accounts & posting own orgs.settings.payroll; schedules,
 * components, and union agreements are the re-homed registry entities that
 * left the setup rail to live here.
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
  'entitlements', 'limits', 'service', 'derived', 'derivedPreview',
  // Statutory holidays: the employer's elections, then the resolved calendar
  // those elections produce. Same edit-then-confirm pairing as derived rules.
  'holidays', 'holidayCalendar',
] as const
type Tab = (typeof TABS)[number]
type EntityTab = keyof typeof ENTITY_BY_TAB

const isEntityTab = (tab: Tab): tab is EntityTab => tab in ENTITY_BY_TAB

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
  const tab: Tab = requested && (available as readonly string[]).includes(requested) ? (requested as Tab) : 'packs'
  const t = await getTranslations('payroll.settingsPage')
  const canManageEntities = can(authz, 'admin.setup.manage')

  const tabLabel = (key: Tab, fallback: string) =>
    t.has(`tabs.${key}` as never) ? t(`tabs.${key}` as never) : fallback
  const tabs: { key: Tab; label: string }[] = available.map((key) => ({
    key,
    label: key === 'derived'
      ? tabLabel(key, 'Derived Earnings')
      : key === 'derivedPreview'
        ? tabLabel(key, 'Rule Preview')
        : key === 'holidays'
          ? tabLabel(key, 'Holidays')
          : key === 'holidayCalendar'
            ? tabLabel(key, 'Holiday Calendar')
            : t(`tabs.${key}`),
  }))

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" aria-label={t('tabsAria')}>
        {tabs.map((item) => (
          <Link
            key={item.key}
            href={`/admin/setup/payroll?tab=${item.key}` as never}
            aria-current={tab === item.key ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === item.key
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {tab === 'packs' ? <PacksTab orgId={orgId} /> : null}
      {tab === 'accounts' ? <AccountsTab orgId={orgId} /> : null}
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
        <SetupEntitySection
          entity={holidaysEntity()}
          orgId={orgId}
          searchParams={sp}
          basePath="/admin/setup/payroll"
          canManage={canManageEntities}
        />
      ) : null}
      {tab === 'holidayCalendar' ? (
        <HolidayCalendarSection orgId={orgId} searchParams={sp} />
      ) : null}
    </div>
  )
}

async function PacksTab({ orgId }: { orgId: string }) {
  const [countriesRes, componentsRes] = (await Promise.all([
    db.execute(sql`select settings#>'{payroll,countries}' as countries from orgs where id = ${orgId}`),
    db.execute(sql`
      select count(*)::int as n from pay_components
       where org_id = ${orgId} and system_key is not null`),
  ])) as unknown as [
    { rows: { countries: unknown }[] },
    { rows: { n: number }[] },
  ]
  const raw = countriesRes.rows[0]?.countries
  const installedCountries = Array.isArray(raw) ? raw.map(String) : []
  const componentCount = Number(componentsRes.rows[0]?.n ?? 0)

  return (
    <PayrollCountryPacks
      installedCountries={installedCountries}
      componentCount={componentCount}
      editions={[RATES_2026_JAN, RATES_2026_JUL].map((rates) => ({
        edition: rates.edition,
        effectiveFrom: rates.effectiveFrom,
      }))}
    />
  )
}

async function AccountsTab({ orgId }: { orgId: string }) {
  const [settings, blobRes, accountsRes, vendorsRes] = (await Promise.all([
    payrollSettings(orgId),
    db.execute(sql`select settings->'payroll' as p from orgs where id = ${orgId}`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`),
  ])) as unknown as [
    Awaited<ReturnType<typeof payrollSettings>>,
    { rows: { p: Record<string, unknown> | null }[] },
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; name: string }[] },
  ]
  const blob = blobRes.rows[0]?.p ?? {}
  const installed = Array.isArray(blob.countries) ? blob.countries.map(String) : []
  const [packs, us, ca, stubPassword, encryptionAvailable, paymentMethods] = await Promise.all([
    packSlotState(orgId, installed, blob),
    usPayrollConfig(orgId),
    caPayrollConfig(orgId),
    stubPasswordPolicy(orgId),
    pdfEncryptionAvailable(),
    payrollPaymentMethodSettings(orgId),
  ])

  return (
    <PayrollSetupWorkspace
      settings={settings}
      packs={packs}
      us={us}
      ca={ca}
      stubPassword={stubPassword}
      paymentMethods={paymentMethods}
      statutoryHolidayPay={blob.statutoryHolidayPay === true}
      encryptionAvailable={encryptionAvailable}
      accounts={accountsRes.rows.map((account) => ({
        id: account.id,
        label: account.number ? `${account.number} · ${account.name}` : account.name,
      }))}
      vendors={vendorsRes.rows.map((vendor) => ({ id: vendor.id, label: vendor.name }))}
    />
  )
}
