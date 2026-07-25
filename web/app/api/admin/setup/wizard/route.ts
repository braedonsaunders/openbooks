import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { FEATURE_BY_KEY } from '../../../../../lib/features'
import { INDUSTRY_BY_KEY, canSwitchIndustry } from '../../../../../lib/industries'
import { normalizeCountryCode } from '../../../../../lib/countries'

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
 *   - Industry switch is blocked once journal_lines exist (canSwitchIndustry probe).
 *   - Feature presets that conflict with a hard-blocked disable are silently skipped
 *     (the user can always toggle features individually on the Features page).
 *   - COA rows use `on conflict (org_id, number) do nothing` so re-running never
 *     duplicates accounts; control-account mapping uses `lookup by number` so it
 *     picks up existing accounts on re-run.
 */
export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user

  const body = await req.json().catch(() => ({}))
  const {
    name: inputName,
    legalName: inputLegalName,
    country: inputCountry,
    baseCurrency: inputCurrency,
    fiscalYearStartMonth: inputFiscalMonth,
    industry: inputIndustry,
    features: inputFeatureOverrides,
    skipCoa,
  } = body as {
    name?: string
    legalName?: string
    country?: string
    baseCurrency?: string
    fiscalYearStartMonth?: number
    industry?: string
    features?: Record<string, boolean>
    skipCoa?: boolean
  }

  const industry = typeof inputIndustry === 'string' ? INDUSTRY_BY_KEY.get(inputIndustry) : undefined
  if (inputIndustry && !industry) {
    return NextResponse.json({ error: 'unknown-industry', key: inputIndustry }, { status: 422 })
  }

  // Block industry switch once postings exist.
  if (industry) {
    const ok = await canSwitchIndustry(orgId)
    if (!ok) {
      // Still allow non-industry fields (name, currency, etc.) but reject industry/COA change.
      const existing = (await db.execute(sql`
        select settings->>'industry' as industry from orgs where id = ${orgId}`)) as unknown as {
        rows: { industry: string | null }[]
      }
      if (existing.rows[0]?.industry && existing.rows[0].industry !== industry.key) {
        return NextResponse.json(
          { error: 'industry-locked', message: 'Cannot switch industry after postings exist.' },
          { status: 409 },
        )
      }
    }
  }

  const changes: Record<string, unknown> = {}
  const orgSets: SQL[] = []
  let nextSettings: Record<string, unknown> | null = null

  await db.transaction(async (tx) => {
    // Lock the org row and load current state.
    const cur = (
      (await tx.execute(sql`
        select name, legal_name, base_currency, country, settings
          from orgs where id = ${orgId} for update`)) as unknown as {
        rows: { name: string; legal_name: string | null; base_currency: string; country: string; settings: Record<string, unknown> }[]
      }
    ).rows[0]
    if (!cur) throw new Error('org not found')

    nextSettings = { ...(cur.settings ?? {}) }
    const settingsChanges: Record<string, unknown> = {}

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
      const known = (await tx.execute(sql`select 1 from currencies where code = ${inputCurrency} limit 1`)) as unknown as { rows: unknown[] }
      if (!known.rows[0]) {
        throw new Error(`unknown currency "${inputCurrency}"`)
      }
      orgSets.push(sql`base_currency = ${inputCurrency}`)
      changes.baseCurrency = [cur.base_currency, inputCurrency]
    }
    if (inputFiscalMonth !== undefined && typeof inputFiscalMonth === 'number' && inputFiscalMonth >= 1 && inputFiscalMonth <= 12) {
      const curMonth = typeof nextSettings!.fiscalYearStartMonth === 'number' ? nextSettings!.fiscalYearStartMonth : 1
      if (inputFiscalMonth !== curMonth) {
        nextSettings!.fiscalYearStartMonth = inputFiscalMonth
        settingsChanges.fiscalYearStartMonth = [curMonth, inputFiscalMonth]
      }
    }

    // 2. Insert COA template (idempotent) ---------------------------------
    if (industry && !skipCoa) {
      const inserted = (await tx.execute(sql`
        with ins as (
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, reconcilable, required_dimensions, created_at, created_by, updated_at, updated_by)
          select uuid_generate_v7(), ${orgId}::uuid, t.number, t.name, t.type::text, t.is_summary, true, t.reconcilable, t.required_dimensions, now(), ${actorId}::uuid, now(), ${actorId}::uuid
            from (select * from jsonb_array_elements(${JSON.stringify(
              industry.coa.map((a) => ({
                number: a.number,
                name: a.name,
                type: a.type,
                is_summary: a.isSummary ?? false,
                reconcilable: a.reconcilable ?? false,
                required_dimensions: a.requiredDimensions ?? [],
              })),
            )}::jsonb) as t(number text, name text, type text, is_summary boolean, reconcilable boolean, required_dimensions jsonb))
          on conflict (org_id, number) do nothing
          returning id, number
        )
        select id, number from ins
        union all
        select id, number from accounts where org_id = ${orgId} and number in ${sql.join(
          industry.coa.map((a) => sql`${a.number}`),
          sql`, `,
        )}`)) as unknown as { rows: { id: string; number: string }[] }

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

    // 4. Feature presets (merged — never overrides a hard-blocked disable) -
    if (industry || inputFeatureOverrides) {
      const curFeatures = (nextSettings!.features ?? {}) as Record<string, boolean>
      const nextFeatures = { ...curFeatures }

      // Industry defaults first, then explicit user overrides win.
      if (industry) {
        for (const [key, val] of Object.entries(industry.features)) {
          if (!FEATURE_BY_KEY.has(key)) continue
          nextFeatures[key] = val
        }
      }
      if (inputFeatureOverrides && typeof inputFeatureOverrides === 'object') {
        for (const [key, val] of Object.entries(inputFeatureOverrides)) {
          if (!FEATURE_BY_KEY.has(key) || typeof val !== 'boolean') continue
          // Respect parent dependency: a child can't be on while parent is off.
          const def = FEATURE_BY_KEY.get(key)!
          if (val && def.parentKey) {
            const parentVal = nextFeatures[def.parentKey] ?? FEATURE_BY_KEY.get(def.parentKey)?.defaultEnabled ?? false
            if (!parentVal) continue // skip — parent is off
          }
          nextFeatures[key] = val
        }
      }

      if (JSON.stringify(nextFeatures) !== JSON.stringify(curFeatures)) {
        nextSettings!.features = nextFeatures
        settingsChanges.features = { before: curFeatures, after: nextFeatures }
      }
    }

    // 5. Store industry + onboarding flag ----------------------------------
    if (industry) {
      const curIndustry = (nextSettings!.industry ?? null) as string | null
      if (curIndustry !== industry.key) {
        nextSettings!.industry = industry.key
        settingsChanges.industry = [curIndustry, industry.key]
      }
    }

    // Onboarding mark
    const curOnboarding = (nextSettings!.onboarding ?? {}) as Record<string, unknown>
    const nextOnboarding = {
      ...curOnboarding,
      setupComplete: true,
      completedAt: new Date().toISOString(),
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

  return NextResponse.json({ ok: true })
}

/**
 * Skip the wizard — marks onboarding as complete without changing anything.
 * Used by the "Skip for now" button on first login.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user

  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{onboarding}', ${JSON.stringify({
         setupComplete: true,
         skippedAt: new Date().toISOString(),
         startedAt: new Date().toISOString(),
       })}::jsonb)
     where id = ${orgId}`)

  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ wizard: 'skipped' })}, ${actorId})`)

  return NextResponse.json({ ok: true })
}
