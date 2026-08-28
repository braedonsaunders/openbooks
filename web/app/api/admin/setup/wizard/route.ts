import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { FEATURE_BY_KEY, featureDisableBlocked, featureRequirements } from '../../../../../lib/features'
import { INDUSTRY_BY_KEY, canSwitchIndustry } from '../../../../../lib/industries'
import { normalizeCountryCode } from '../../../../../lib/countries'
import {
  periodDerivationSql,
  periodDerivationStagingSql,
} from '../../../../../lib/fiscal-periods'
import { ONBOARDING_SCHEMA_VERSION, onboardingRecord } from '../../../../../lib/onboarding'
import { isBookStart, isCloseCadence, isComplexityLevel, isMonthlyActivityLevel, isTaxPosition, isTeamSize } from '../../../../../lib/workspace-profile'

/** A feature the wizard was asked to disable still has load-bearing data. */
class WizardFeatureBlocked extends Error {
  constructor(readonly key: string) {
    super(`feature ${key} cannot be disabled`)
  }
}

class WizardReportingFrameworkBlocked extends Error {
  constructor() {
    super('reporting framework cannot change after accounting evidence exists')
  }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Setup wizard apply endpoint. One audited transaction:
 *   1. Updates org identity (name, legal name, country, base currency, fiscal-year start).
 *   2. Inserts the industry COA template (idempotent by account number via on conflict).
 *   3. Maps control accounts by account number → inserted account IDs.
 *   4. Merges the industry feature presets into orgs.settings.features.
 *   5. Stores orgs.settings.industry and orgs.settings.onboarding.setupComplete.
 *
 * Safety:
 *   - Industry, base currency, and fiscal-calendar changes are blocked once
 *     journal_lines exist (canSwitchIndustry probe).
 *   - Feature input is allowlisted and parent/child dependencies are enforced.
 *   - COA rows use `on conflict (org_id, number) do nothing` so re-running never
 *     duplicates accounts; control-account mapping uses `lookup by number` so it
 *     picks up existing accounts on re-run.
 */
export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const {
    name: inputName,
    legalName: inputLegalName,
    country: inputCountry,
    baseCurrency: inputCurrency,
    fiscalYearStartMonth: inputFiscalMonth,
    reportingFramework: inputReportingFramework,
    industry: inputIndustry,
    features: inputFeatureOverrides,
    workspaceProfile: inputWorkspaceProfile,
  } = body as {
    name?: string
    legalName?: string
    country?: string
    baseCurrency?: string
    fiscalYearStartMonth?: number
    reportingFramework?: string
    industry?: string
    features?: Record<string, boolean>
    workspaceProfile?: { teamSize?: unknown; complexity?: unknown; bookStart?: unknown; taxPosition?: unknown; monthlyActivity?: unknown; closeCadence?: unknown }
  }

  if (typeof inputName !== 'string' || !inputName.trim()) {
    return NextResponse.json({ error: 'company-name-required' }, { status: 422 })
  }
  if (inputLegalName !== undefined && typeof inputLegalName !== 'string') {
    return NextResponse.json({ error: 'legal-name-must-be-text' }, { status: 422 })
  }
  if (typeof inputCountry !== 'string' || !normalizeCountryCode(inputCountry)) {
    return NextResponse.json({ error: 'invalid-country' }, { status: 422 })
  }
  if (typeof inputCurrency !== 'string' || !/^[A-Z]{3}$/.test(inputCurrency)) {
    return NextResponse.json({ error: 'invalid-base-currency' }, { status: 422 })
  }
  const knownCurrency = (await db.execute(
    sql`select 1 from currencies where code = ${inputCurrency} limit 1`,
  ))
  if (!knownCurrency.rows[0]) {
    return NextResponse.json(
      {
        error: 'unsupported-base-currency',
        message: `${inputCurrency} is not available in this installation. Run deployment bootstrap or choose a supported currency.`,
      },
      { status: 422 },
    )
  }
  if (
    typeof inputFiscalMonth !== 'number'
    || !Number.isInteger(inputFiscalMonth)
    || inputFiscalMonth < 1
    || inputFiscalMonth > 12
  ) {
    return NextResponse.json({ error: 'invalid-fiscal-year-start-month' }, { status: 422 })
  }
  if (
    inputReportingFramework !== undefined
    && inputReportingFramework !== 'us_gaap'
    && inputReportingFramework !== 'ifrs'
  ) {
    return NextResponse.json({ error: 'invalid-reporting-framework' }, { status: 422 })
  }
  if (
    !inputWorkspaceProfile
    || !isTeamSize(inputWorkspaceProfile.teamSize)
    || !isComplexityLevel(inputWorkspaceProfile.complexity)
    || !isBookStart(inputWorkspaceProfile.bookStart)
    || !isTaxPosition(inputWorkspaceProfile.taxPosition)
    || !isMonthlyActivityLevel(inputWorkspaceProfile.monthlyActivity)
    || !isCloseCadence(inputWorkspaceProfile.closeCadence)
  ) {
    return NextResponse.json({ error: 'invalid-workspace-profile' }, { status: 422 })
  }
  if (
    inputFeatureOverrides === null
    || typeof inputFeatureOverrides !== 'object'
    || Array.isArray(inputFeatureOverrides)
  ) {
    return NextResponse.json({ error: 'invalid-feature-overrides' }, { status: 422 })
  }
  for (const [key, value] of Object.entries(inputFeatureOverrides)) {
    if (!FEATURE_BY_KEY.has(key) || typeof value !== 'boolean') {
      return NextResponse.json({ error: 'invalid-feature-override', key }, { status: 422 })
    }
  }
  const industry = typeof inputIndustry === 'string' ? INDUSTRY_BY_KEY.get(inputIndustry) : undefined
  if (!industry) {
    return NextResponse.json({ error: 'unknown-industry', key: inputIndustry }, { status: 422 })
  }

  // Accounting-foundation fields stop being mutable once postings exist.
  // Re-running setup can still update identity and feature choices, but cannot
  // reinterpret historical books through a new industry, currency, or fiscal
  // calendar.
  const accountingFoundationMutable = await canSwitchIndustry(orgId)
  if (!accountingFoundationMutable) {
    const existing = (await db.execute<{
        base_currency: string
        industry: string | null
        fiscal_year_start_month: number
      }>(sql`
      select base_currency, settings->>'industry' as industry,
             coalesce((settings->>'fiscalYearStartMonth')::int, 1) as fiscal_year_start_month
        from orgs where id = ${orgId}`))
    const current = existing.rows[0]
    if (!current) {
      return NextResponse.json({ error: 'org-not-found' }, { status: 404 })
    }
    if (industry && current.industry !== null && current.industry !== industry.key) {
      return NextResponse.json(
        { error: 'industry-locked', message: 'Cannot change industry after postings exist.' },
        { status: 409 },
      )
    }
    if (
      typeof inputCurrency === 'string'
      && /^[A-Z]{3}$/.test(inputCurrency)
      && inputCurrency !== current.base_currency
    ) {
      return NextResponse.json(
        { error: 'base-currency-locked', message: 'Cannot change base currency after postings exist.' },
        { status: 409 },
      )
    }
    if (
      typeof inputFiscalMonth === 'number'
      && inputFiscalMonth >= 1
      && inputFiscalMonth <= 12
      && inputFiscalMonth !== current.fiscal_year_start_month
    ) {
      return NextResponse.json(
        { error: 'fiscal-calendar-locked', message: 'Cannot change the fiscal calendar after postings exist.' },
        { status: 409 },
      )
    }
  }

  const changes: Record<string, unknown> = {}
  const orgSets: SQL[] = []
  let nextSettings: Record<string, unknown> | null = null

  try {
  await db.transaction(async (tx) => {
    // Lock the org row and load current state.
    const cur = (
      (await tx.execute<{ name: string; legal_name: string | null; base_currency: string; country: string; settings: Record<string, unknown> }>(sql`
        select name, legal_name, base_currency, country, settings
          from orgs where id = ${orgId} for update`))
    ).rows[0]
    if (!cur) throw new Error('org not found')

    nextSettings = { ...(cur.settings ?? {}) }
    const settingsChanges: Record<string, unknown> = {}
    const currentIndustry = typeof nextSettings.industry === 'string' ? nextSettings.industry : null
    const industryChanged = Boolean(industry && industry.key !== currentIndustry)
    const currentReportingFramework =
      nextSettings.reportingFramework === 'ifrs' || nextSettings.reportingFramework === 'us_gaap'
        ? nextSettings.reportingFramework
        : null
    // Existing organizations retain the pre-0033 effective value when first
    // opened through setup (the migration normally makes this branch
    // unnecessary). New organizations receive an explicit policy, independent
    // from the income-tax framework seeded below.
    const seededReportingFramework =
      inputReportingFramework
      ?? (nextSettings.taxFramework === 'ias12'
        ? 'ifrs'
        : nextSettings.taxFramework === 'asc740'
          ? 'us_gaap'
          : normalizeCountryCode(inputCountry) === 'US' ? 'us_gaap' : 'ifrs')
    if (
      currentReportingFramework !== null
      && inputReportingFramework !== undefined
      && inputReportingFramework !== currentReportingFramework
    ) {
      const evidence = await tx.execute<{ leaseEvidence: boolean; inventoryEvidence: boolean }>(sql`
        select exists (select 1 from lease_agreements where org_id = ${orgId}) as "leaseEvidence",
               exists (select 1 from inventory_writedowns where org_id = ${orgId}) as "inventoryEvidence"`)
      if (evidence.rows[0]?.leaseEvidence || evidence.rows[0]?.inventoryEvidence) {
        throw new WizardReportingFrameworkBlocked()
      }
    }
    if (currentReportingFramework === null || inputReportingFramework !== undefined) {
      if (currentReportingFramework !== seededReportingFramework) {
        nextSettings.reportingFramework = seededReportingFramework
        settingsChanges.reportingFramework = [currentReportingFramework, seededReportingFramework]
      }
    }
    let effectiveBaseCurrency = cur.base_currency
    let fiscalStartChanged = false

    // 1. Org identity fields ------------------------------------------------
    if (inputName !== undefined && typeof inputName === 'string' && inputName.trim() && inputName.trim() !== cur.name) {
      orgSets.push(sql`name = ${inputName.trim()}`)
      changes.name = [cur.name, inputName.trim()]
    }
    if (inputLegalName !== undefined && typeof inputLegalName === 'string') {
      const ln = inputLegalName.trim() || null
      if (ln !== cur.legal_name) {
        orgSets.push(sql`legal_name = ${ln}`)
        changes.legalName = [cur.legal_name, ln]
      }
    }
    if (inputCountry !== undefined) {
      const country = normalizeCountryCode(inputCountry)
      if (country && country !== cur.country) {
        orgSets.push(sql`country = ${country}`)
        changes.country = [cur.country, country]
      }
      // Sensible income-tax framework default for the jurisdiction, set only
      // when the org has never made an explicit choice (Company Settings can
      // always override later — the setting is never clobbered here).
      if (country && nextSettings!.taxFramework === undefined) {
        nextSettings!.taxFramework = country === 'US' ? 'asc740' : 'ias12'
        settingsChanges.taxFramework = [null, nextSettings!.taxFramework]
      }
    }
    if (inputCurrency !== undefined && typeof inputCurrency === 'string' && /^[A-Z]{3}$/.test(inputCurrency) && inputCurrency !== cur.base_currency) {
      orgSets.push(sql`base_currency = ${inputCurrency}`)
      changes.baseCurrency = [cur.base_currency, inputCurrency]
      effectiveBaseCurrency = inputCurrency
    }
    if (inputFiscalMonth !== undefined && typeof inputFiscalMonth === 'number' && inputFiscalMonth >= 1 && inputFiscalMonth <= 12) {
      const curMonth = typeof nextSettings!.fiscalYearStartMonth === 'number' ? nextSettings!.fiscalYearStartMonth : 1
      if (inputFiscalMonth !== curMonth) {
        nextSettings!.fiscalYearStartMonth = inputFiscalMonth
        settingsChanges.fiscalYearStartMonth = [curMonth, inputFiscalMonth]
        fiscalStartChanged = true
      }
    }

    // 2. Insert COA template (idempotent) ---------------------------------
    // Never accept a client-controlled escape hatch for chart provisioning.
    // Existing posted books may be classified for the first time, but their
    // established chart and control-account mapping remain untouched.
    if (industry && industryChanged && accountingFoundationMutable) {
      const inserted = (await tx.execute<{ id: string; number: string }>(sql`
        with ins as (
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, currency_restriction, reconcilable, required_dimensions, created_at, created_by, updated_at, updated_by)
          select uuid_generate_v7(), ${orgId}::uuid, t.number, t.name, t.type::text, t.is_summary, true,
                 case when t.reconcilable then ${effectiveBaseCurrency} else null end,
                 t.reconcilable, t.required_dimensions, now(), ${actorId}::uuid, now(), ${actorId}::uuid
            from jsonb_to_recordset(${JSON.stringify(
              industry.coa.map((a) => ({
                number: a.number,
                name: a.name,
                type: a.type,
                is_summary: a.isSummary ?? false,
                reconcilable: a.reconcilable ?? false,
                required_dimensions: a.requiredDimensions ?? [],
              })),
            )}::jsonb) as t(number text, name text, type text, is_summary boolean, reconcilable boolean, required_dimensions jsonb)
          on conflict (org_id, number) do nothing
          returning id, number
        )
        select id, number from ins
        union all
        select id, number from accounts where org_id = ${orgId} and number in (${sql.join(
          industry.coa.map((a) => sql`${a.number}`),
          sql`, `,
        )})`))

      // Build number→id map.
      const acctMap = new Map(inserted.rows.map((r) => [r.number, r.id]))

      // 3. Map control accounts from the industry template.
      const curControl = (nextSettings!.controlAccounts ?? {}) as Record<string, string>
      const nextControl = { ...curControl }
      let controlChanged = false
      for (const [key, acctNumber] of Object.entries(industry.controlAccounts)) {
        const acctId = acctMap.get(acctNumber)
        if (acctId && nextControl[key] !== acctId) {
          nextControl[key] = acctId
          controlChanged = true
        }
      }
      if (controlChanged) {
        nextSettings!.controlAccounts = nextControl
        settingsChanges.controlAccounts = [curControl, nextControl]
      }
    }

    // A usable fresh company needs at least one ordinary due-date policy.
    // Seed a conservative Net 30 option only when the tenant has no terms at
    // all; never overwrite or compete with a company's own term library.
    await tx.execute(sql`
      insert into payment_terms (org_id, name, net_days, is_active)
      select ${orgId}, 'Net 30', 30, true
       where not exists (select 1 from payment_terms where org_id = ${orgId})
    `)

    // 4. Feature presets (merged through the authoritative feature model) --
    if (industryChanged || inputFeatureOverrides) {
      const curFeatures = (nextSettings!.features ?? {}) as Record<string, boolean>
      const nextFeatures = { ...curFeatures }

      // Industry defaults first, then explicit user overrides win.
      if (industryChanged && industry) {
        for (const [key, val] of Object.entries(industry.features)) {
          if (!FEATURE_BY_KEY.has(key)) continue
          nextFeatures[key] = val
        }
      }
      if (inputFeatureOverrides && typeof inputFeatureOverrides === 'object') {
        const overrides = Object.entries(inputFeatureOverrides).filter(
          (entry): entry is [string, boolean] => FEATURE_BY_KEY.has(entry[0]) && typeof entry[1] === 'boolean',
        )
        for (const [key, val] of overrides) nextFeatures[key] = val
      }
      // Normalize the complete dependency graph. Repeat to a fixed point so a
      // disabled root also suppresses grandchildren regardless of registry order.
      let dependencyChanged = true
      while (dependencyChanged) {
        dependencyChanged = false
        for (const def of FEATURE_BY_KEY.values()) {
          const missing = featureRequirements(def).some((requiredKey) =>
            !(nextFeatures[requiredKey] ?? FEATURE_BY_KEY.get(requiredKey)?.defaultEnabled ?? false),
          )
          if (missing && nextFeatures[def.key] !== false) {
            nextFeatures[def.key] = false
            dependencyChanged = true
          }
        }
      }

      // The wizard writes features through the same model as the Features page
      // and therefore owes the same integrity control. It previously wrote the
      // merged map straight to settings, so re-running setup was a way around
      // every refusal the switchboard enforces: an industry preset (or a
      // dependency cascade above, which silently forces dependents to false)
      // could switch off Payroll with posted pay runs, or multi-subsidiary with
      // a ledger already partitioned per entity, and return 200.
      //
      // Probed here rather than trusting the caller's intent: a feature turned
      // off by the cascade is just as load-bearing as one turned off by hand.
      const nowDisabled = Object.keys(nextFeatures).filter(
        (key) =>
          nextFeatures[key] === false
          && (curFeatures[key] ?? FEATURE_BY_KEY.get(key)?.defaultEnabled ?? false),
      )
      for (const key of nowDisabled) {
        if (await featureDisableBlocked(orgId, key)) {
          // Thrown, not returned: an early return from the transaction callback
          // COMMITS the partial setup written above it.
          throw new WizardFeatureBlocked(key)
        }
      }

      if (JSON.stringify(nextFeatures) !== JSON.stringify(curFeatures)) {
        nextSettings!.features = nextFeatures
        settingsChanges.features = { before: curFeatures, after: nextFeatures }
      }
    }

    // 5. Store industry + onboarding flag ----------------------------------
    if (industryChanged && industry) {
      const curIndustry = (nextSettings!.industry ?? null) as string | null
      if (curIndustry !== industry.key) {
        nextSettings!.industry = industry.key
        settingsChanges.industry = [curIndustry, industry.key]
      }
    }

    const currentWorkspaceProfile = (nextSettings!.workspaceProfile ?? null) as Record<string, unknown> | null
    const nextWorkspaceProfile = {
      teamSize: inputWorkspaceProfile.teamSize,
      complexity: inputWorkspaceProfile.complexity,
      bookStart: inputWorkspaceProfile.bookStart,
      taxPosition: inputWorkspaceProfile.taxPosition,
      monthlyActivity: inputWorkspaceProfile.monthlyActivity,
      closeCadence: inputWorkspaceProfile.closeCadence,
      assessedAt: new Date().toISOString(),
      assessedBy: actorId,
    }
    nextSettings!.workspaceProfile = nextWorkspaceProfile
    settingsChanges.workspaceProfile = {
      before: currentWorkspaceProfile,
      after: nextWorkspaceProfile,
    }

    // Onboarding mark
    const curOnboarding = onboardingRecord(nextSettings)
    const {
      deferredAt: _deferredAt,
      deferredBy: _deferredBy,
      skippedAt: _skippedAt,
      skippedBy: _skippedBy,
      ...retainedOnboarding
    } = curOnboarding
    const nextOnboarding = {
      ...retainedOnboarding,
      schemaVersion: ONBOARDING_SCHEMA_VERSION,
      setupComplete: true,
      completedAt: new Date().toISOString(),
      completedBy: actorId,
      startedAt: curOnboarding.startedAt ?? new Date().toISOString(),
    }
    nextSettings!.onboarding = nextOnboarding
    settingsChanges.onboarding = [curOnboarding, nextOnboarding]

    // Commit settings
    const hasSettingsChange = Object.keys(settingsChanges).length > 0
    if (hasSettingsChange || orgSets.length > 0) {
      orgSets.push(sql`settings = ${JSON.stringify(nextSettings)}::jsonb`)
      orgSets.push(sql`updated_at = now()`)
      orgSets.push(sql`updated_by = ${actorId}::uuid`)
    }
    if (orgSets.length > 0) {
      await tx.execute(sql`update orgs set ${sql.join(orgSets, sql`, `)} where id = ${orgId}`)
    }

    // A single-entity company should never have two competing identities.
    // Keep its sole root subsidiary aligned with Company until the tenant
    // explicitly enables and creates a multi-entity structure. Multi-entity
    // roots are intentionally left alone because the group name and parent
    // legal entity can legitimately differ.
    const singleRoot = (await tx.execute<{
        id: string
        name: string
        legal_name: string | null
        base_currency: string
        country: string
        entity_count: number
      }>(sql`
      select s.id, s.name, s.legal_name, s.base_currency, s.country,
             (select count(*)::int from subsidiaries x
               where x.org_id = ${orgId} and x.is_active and not x.is_elimination) as entity_count
        from subsidiaries s
       where s.org_id = ${orgId} and s.parent_id is null
       for update
    `))
    const root = singleRoot.rows[0]
    if (root && root.entity_count === 1) {
      const nextName = inputName.trim()
      const nextLegalName = inputLegalName?.trim() || null
      const nextCountry = normalizeCountryCode(inputCountry)!
      const rootChanges: Record<string, unknown> = {}
      if (root.name !== nextName) rootChanges.name = [root.name, nextName]
      if (root.legal_name !== nextLegalName) rootChanges.legalName = [root.legal_name, nextLegalName]
      if (root.base_currency !== inputCurrency) rootChanges.baseCurrency = [root.base_currency, inputCurrency]
      if (root.country !== nextCountry) rootChanges.country = [root.country, nextCountry]
      if (Object.keys(rootChanges).length > 0) {
        await tx.execute(sql`
          update subsidiaries
             set name = ${nextName}, legal_name = ${nextLegalName},
                 base_currency = ${inputCurrency}, country = ${nextCountry},
                 updated_at = now(), updated_by = ${actorId}
           where id = ${root.id} and org_id = ${orgId}
        `)
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'subsidiaries', ${root.id}, 'update',
                  ${JSON.stringify({ ...rootChanges, reason: 'single-entity company identity synchronized by setup' })},
                  ${actorId})
        `)
      }
    }
    if (fiscalStartChanged) {
      // Move existing labels outside the canonical range first so a calendar
      // rotation cannot collide with another period's old unique key. Keep
      // the tenant-shared index in place while changing this organization's
      // periods so unrelated tenants do not pay for global DDL locks.
      await tx.execute(periodDerivationStagingSql(orgId))
      await tx.execute(periodDerivationSql(orgId, inputFiscalMonth!))
      await tx.execute(sql`
        update fiscal_calendars
           set year_start_month = ${inputFiscalMonth!}, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and is_default`)
    }

    // Audit
    if (hasSettingsChange) {
      changes.settings = settingsChanges
    }
    if (Object.keys(changes).length > 0) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify(changes)}, ${actorId})`)
    }
  })
  } catch (error) {
    // Same status and body the Features switchboard returns, so the wizard is
    // not a second, weaker door onto the same decision.
    if (error instanceof WizardFeatureBlocked) {
      return NextResponse.json({ error: 'feature-blocked', key: error.key }, { status: 409 })
    }
    if (error instanceof WizardReportingFrameworkBlocked) {
      return NextResponse.json(
        {
          error: 'reporting-framework-locked',
          message: 'Cannot change the reporting framework after lease or inventory NRV evidence exists.',
        },
        { status: 409 },
      )
    }
    throw error
  }

  return NextResponse.json({ ok: true })
}

/**
 * Defer first-run setup without claiming it was completed. The automatic
 * overlay closes, while Company Settings → Setup wizard remains the explicit
 * resume path. The before/after state and actor are recorded atomically.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user

  await db.transaction(async (tx) => {
    const current = (await tx.execute<{ settings: Record<string, unknown> }>(sql`
      select settings from orgs where id = ${orgId} for update
    `))
    const settings = current.rows[0]?.settings
    if (!settings) {
      throw new Error('org not found')
    }

    const before = onboardingRecord(settings)
    const deferredAt = new Date().toISOString()
    const after = {
      ...before,
      schemaVersion: ONBOARDING_SCHEMA_VERSION,
      setupComplete: false,
      startedAt: before.startedAt ?? deferredAt,
      deferredAt,
      deferredBy: actorId,
    }
    const nextSettings = { ...settings, onboarding: after }

    await tx.execute(sql`
      update orgs
         set settings = ${JSON.stringify(nextSettings)}::jsonb,
             updated_at = now(),
             updated_by = ${actorId}::uuid
       where id = ${orgId}`)

    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId},
        'orgs',
        ${orgId},
        'update',
        ${JSON.stringify({ onboarding: { before, after }, reason: 'first-run setup deferred' })},
        ${actorId}
      )`)
  })

  return NextResponse.json({ ok: true })
}
