import 'server-only'

import Link from 'next/link'
import { cn } from '@openbooks/ui'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  payrollSettings,
  statutoryHolidayPayEnabled,
  type PayrollSubsidiaryScope,
} from '@openbooks/engine/src/payroll-run.ts'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { payrollSetupState } from '@openbooks/engine/src/payroll-readiness.ts'
import { payrollBankProfiles } from '@openbooks/engine/src/payroll-bank-file.ts'
import {
  packRemittanceVendorSettingsKeys,
  packSlotState,
  PAYROLL_COUNTRY_PACKS,
} from '@openbooks/engine/src/payroll/packs.ts'
import { payrollTaxYearCoverage } from '@openbooks/engine/src/payroll/tax-years.ts'
import { pdfEncryptionAvailable } from '@openbooks/pdf'
import { stubPasswordPolicy } from '../../../../../lib/payroll-outputs'
import { can, getAuthz } from '../../../../../lib/authz'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { PAY_DERIVED_RULES_ENTITY } from '../../../../../lib/setup/payroll-derived-rules'
import { PAYROLL_HOLIDAYS_ENTITY } from '../../../../../lib/setup/payroll-holidays'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { DerivedRulePreviewSection } from './DerivedRulePreviewSection'
import { HolidayCalendarSection } from './HolidayCalendarSection'
import { PayrollCountryPacks, type PackCoverage } from './PayrollCountryPacks'
import { PayrollPaydaySettings } from './PayrollPaydaySettings'
import { PayrollSetupLauncher } from './PayrollSetupLauncher'
import { PayrollSetupWorkspace } from './PayrollSetupWorkspace'
import { StatHolidayPaySection } from './StatHolidayPaySection'
import { StatutoryRatesSection } from './StatutoryRatesSection'
import { WorkSchedulesSection } from './WorkSchedulesSection'

/**
 * Tab-body slots for the payroll setup workspace, plus the header chrome the
 * spec cannot express.
 *
 * This page is the setup workspace's odd sibling: it owns its own two-level
 * tab strip rather than arriving through the generic entity list, and its
 * tabs are mutually exclusive bodies behind one `?tab=` param. Presence
 * flags (`onPacks`, `onAccounts`, …) choose exactly one of them; the spec
 * never branches, it only places blocks and lets all but one vanish — the
 * accounts-page precedent (`onList`/`onSearch`/`onHierarchy`) at its widest
 * so far.
 *
 * Every body needs an org id (a capability), and the entity-backed bodies
 * additionally need a live registry entry plus the manage gate. None of
 * those travel through a spec, so each body renders through a SLOT below
 * that re-derives them from the session — the same rule that put
 * EntityListView behind `entity-list-view` and SetupEntitySection behind
 * `setup-section`. A slot takes only the tab key it renders (as its NAME),
 * the URL it was already rendering with (`sp`), and the base path.
 *
 * The group strip + ModuleHomeTabs pill row is shared chrome, not spec
 * vocabulary: `PayrollSetupTabs` renders the conditional PAIR (active link
 * vs plain link per group) verbatim, and the page imports it back so both
 * render paths share one implementation.
 */

export function PayrollSetupTabs({
  groups,
  activeGroup,
  tabsAria,
  subTabs,
}: {
  groups: { key: string; label: string; firstTab: string }[]
  activeGroup: string
  tabsAria: string
  subTabs: { href: string; label: string; active: boolean }[]
}) {
  return (
    <>
      <nav
        className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
        aria-label={tabsAria}
      >
        {groups.map((item) => (
          <Link
            key={item.key}
            href={`/admin/setup/payroll?tab=${item.firstTab}` as never}
            aria-current={activeGroup === item.key ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              activeGroup === item.key
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <ModuleHomeTabs tabs={subTabs} />
    </>
  )
}

/**
 * The page header: h1 + description + launcher button. The native page owns
 * a `<header>` element here — no PageHeader block vocabulary for it — so the
 * whole row is one shared component over loader-resolved strings plus the
 * launcher payload. The native branch imports it back; both paths share the
 * h1, the description, and the button chrome by construction.
 */
export function PayrollSetupHeader({
  title,
  description,
  launcher,
}: {
  title: string
  description: string
  launcher: PayrollLauncherData
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {/* Re-launchable from the settings page — adding a second country
          pack walks the same wizard. */}
      <PayrollSetupLauncher variant="button" {...launcher} />
    </header>
  )
}

/**
 * The launcher banner: rendered below the header only while blockers are
 * open. Presence (`missing > 0`) lives in the component — the same rule the
 * empty state follows — so the spec places this widget unconditionally and
 * both paths share the banner chrome.
 */
export function PayrollSetupBanner({ launcher }: { launcher: PayrollLauncherData }) {
  return launcher.missing > 0 ? <PayrollSetupLauncher variant="banner" {...launcher} /> : null
}

export interface PayrollLauncherData {
  missing: number
  vendorKeysByCountry: Record<string, string[]>
  frequencies: { value: string; labelKey: string }[]
  canManageEntities: boolean
  schedules: { id: string; name: string }[]
  bankProfiles: { id: string; name: string; format: string; configured: boolean }[]
}

/**
 * Everything the "Set up payroll" wizard launcher needs, computed once.
 * Loader work: the native page calls this verbatim, and the spec loader
 * calls it to build the header/banner payload. The `missing` count is a
 * loader-resolved number — presence (`missing > 0`) lives in the shared
 * banner component above.
 */
export async function launcherDataFor({
  orgId,
  canManageEntities,
  allowedSubsidiaryIds,
}: {
  orgId: string
  canManageEntities: boolean
  allowedSubsidiaryIds?: PayrollSubsidiaryScope
}): Promise<PayrollLauncherData> {
  const [setup, bankProfiles, schedulesRes] = await Promise.all([
    payrollSetupState(orgId, allowedSubsidiaryIds),
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
  const vendorKeysByCountry: Record<string, string[]> = Object.fromEntries(
    Object.keys(PAYROLL_COUNTRY_PACKS).map((country) => [country, packRemittanceVendorSettingsKeys(country)]),
  )
  const missing = setup.checks.filter((check) => !check.ok && check.severity === 'blocker').length
  return {
    missing,
    vendorKeysByCountry,
    frequencies,
    canManageEntities,
    schedules: schedulesRes.rows,
    bankProfiles: bankProfiles.map((p) => ({
      id: p.id,
      name: p.name,
      format: p.format,
      configured: p.configured,
    })),
  }
}

/** Country packs tab: installed countries, component count, tax-year coverage. */
export async function PacksTabSlot() {
  const authz = await getAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
  const [countriesRes, componentsRes] = await Promise.all([
    db.execute<{ countries: unknown }>(sql`select settings#>'{payroll,countries}' as countries from orgs where id = ${orgId}`),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from pay_components
       where org_id = ${orgId} and system_key is not null`),
  ])
  const raw = countriesRes.rows[0]?.countries
  const installedCountries = Array.isArray(raw) ? raw.map(String) : []
  const componentCount = Number(componentsRes.rows[0]?.n ?? 0)
  return (
    <PayrollCountryPacks
      installedCountries={installedCountries}
      componentCount={componentCount}
      /* The packs' OWN tax-year declarations — every installed pack's loaded
         years and editions, not one country's constants imported by name. */
      coverage={payrollTaxYearCoverage().map(
        (entry): PackCoverage => ({
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
        }),
      )}
    />
  )
}

/** Accounts & posting tab: settings blob, statutory slots, pickers. */
export async function AccountsTabSlot() {
  const authz = await getAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
  const allowedSubsidiaryIds = authz.allowedSubsidiaryIds ?? undefined
  const [settings, blobRes, accountsRes, vendorsRes] = await Promise.all([
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
  ])
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

/** Payday tab: rails, stub delivery, EFT originators. */
export async function PaydayTabSlot() {
  const authz = await getAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
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
        id: p.id,
        name: p.name,
        format: p.format,
        configured: p.configured,
      }))}
    />
  )
}

/** Statutory rates tab: fully client-rendered over pack-declared slots. */
export function RatesTabSlot() {
  return <StatutoryRatesSection />
}

/** Work schedules tab: manage gate re-derived from the session. */
export async function WorkSchedulesTabSlot() {
  const authz = await getAuthz()
  if (!authz) return null
  return <WorkSchedulesSection canManage={can(authz, 'admin.setup.manage')} />
}

/** Derived-rule preview tab: org-derived server computation over ?rule/?from/?to. */
export async function DerivedPreviewTabSlot({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return <DerivedRulePreviewSection orgId={authz.user.orgId} searchParams={sp} />
}

/** Holidays tab: stat-pay election plus the registry entity list. */
export async function HolidaysTabSlot({
  sp,
  basePath,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  // Prefer the registered descriptor the moment it exists so there is never
  // a second copy of the entity's shape in play.
  const entity = SETUP_ENTITY_BY_KEY.get(PAYROLL_HOLIDAYS_ENTITY.key) ?? PAYROLL_HOLIDAYS_ENTITY
  const enabled = await statutoryHolidayPayEnabled(authz.user.orgId, undefined, authz.allowedSubsidiaryIds)
  return (
    <>
      {/* The stat-pay election lives WITH the holiday elections it governs. */}
      <StatHolidayPaySection statutoryHolidayPay={enabled} />
      <SetupEntitySection
        entity={entity}
        orgId={authz.user.orgId}
        searchParams={sp}
        basePath={basePath}
        canManage={can(authz, 'admin.setup.manage')}
      />
    </>
  )
}

/** Resolved holiday calendar tab: org-derived server computation. */
export async function HolidayCalendarTabSlot({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return <HolidayCalendarSection orgId={authz.user.orgId} searchParams={sp} />
}

/** Derived-rules tab: an ordinary registry entity not yet spread into SETUP_ENTITIES. */
export async function DerivedTabSlot({
  sp,
  basePath,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  // Prefer the registered descriptor the moment it exists so there is never
  // a second copy of the entity's shape in play.
  const entity = SETUP_ENTITY_BY_KEY.get(PAY_DERIVED_RULES_ENTITY.key) ?? PAY_DERIVED_RULES_ENTITY
  return (
    <SetupEntitySection
      entity={entity}
      orgId={authz.user.orgId}
      searchParams={sp}
      basePath={basePath}
      canManage={can(authz, 'admin.setup.manage')}
    />
  )
}

/** Registry-entity tabs (filing, schedules, components, union, entitlements…). */
export async function EntityTabSlot({
  entityKey,
  sp,
  basePath,
}: {
  entityKey: string
  sp: Record<string, string | string[] | undefined>
  basePath: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!entity) return null
  return (
    <SetupEntitySection
      entity={entity}
      orgId={authz.user.orgId}
      searchParams={sp}
      basePath={basePath}
      canManage={can(authz, 'admin.setup.manage')}
    />
  )
}
