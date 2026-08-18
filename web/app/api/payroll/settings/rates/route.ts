import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { listFilingAccounts } from '@openbooks/engine/src/payroll-filing.ts'
import { installedPayrollCountries, payrollStatutoryRateGaps } from '@openbooks/engine/src/payroll-readiness.ts'
import { PayrollPackError, payrollPack } from '@openbooks/engine/src/payroll/packs.ts'
import {
  deleteStatutoryRate,
  listStatutoryRates,
  packRates,
  statutoryRateProblem,
  upsertStatutoryRate,
} from '@openbooks/engine/src/payroll/statutory-rates.ts'
import {
  payrollTaxYearCoverage,
  payrollTaxYearForDate,
} from '@openbooks/engine/src/payroll/tax-years.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Tenant-entered statutory RATES — the ones a pack cannot publish because they
 * are experience-rated per filing account, or are published per region per year.
 *
 * This route knows no jurisdiction. It enumerates the installed packs' declared
 * rate slots (engine/src/payroll/statutory-rates.ts), validates a write against
 * the SAME declaration (`statutoryRateProblem` + the slot's declared fields), and
 * writes rows keyed by their scope point. There is no `us`/`ca` shape here and
 * no per-country branch: a pack that declares a levy gets a surface for it the
 * moment it declares one.
 *
 * The pre-scoping `orgs.settings.payroll.us` / `.ca` blobs are READ ONLY now —
 * the pack declarations expose them as a fallback resolution so an untouched
 * tenant calculates byte-identically, and every write lands on a row. Two
 * writable homes for one statutory number is exactly the parallel source of
 * truth the repository standard forbids.
 */

interface RatePayload {
  country: string
  rateKey: string
  region: string | null
  /** The taxing unit below the region, for a slot declared at sub_region scope. */
  subRegion: string | null
  filingAccountId: string | null
  taxYear: number
  values: Record<string, unknown>
}

function parseBody(body: unknown): RatePayload | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'invalid body'
  const raw = body as Record<string, unknown>
  const country = String(raw.country ?? '')
  const rateKey = String(raw.rateKey ?? '')
  if (!country || !rateKey) return 'country and rateKey are required'
  const region = raw.region == null || raw.region === '' ? null : String(raw.region)
  // Carried, not dropped. Without it a sub_region-scoped slot (an Ohio
  // municipal rate, a Michigan city's rate pair, a PA Act 32 PSD) had no
  // writable home at all: the engine has resolved, validated and stored them
  // per jurisdiction all along, and this route silently wrote every one of them
  // to the region-wide point — one row for the whole state, last write wins.
  const subRegion = raw.subRegion == null || raw.subRegion === ''
    ? null
    : String(raw.subRegion).trim()
  const filingAccountId = raw.filingAccountId == null || raw.filingAccountId === ''
    ? null
    : String(raw.filingAccountId)
  if (filingAccountId !== null && !isUuid(filingAccountId)) return 'invalid filingAccountId'
  const taxYear = Number(raw.taxYear)
  if (!Number.isInteger(taxYear)) return 'invalid taxYear'
  const values = raw.values
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return 'invalid values'
  return {
    country, rateKey, region, subRegion, filingAccountId, taxYear,
    values: values as Record<string, unknown>,
  }
}

/** The year the surface opens on: the pack's own current tax year. */
function defaultYear(countries: string[]): number {
  const today = new Date().toISOString().slice(0, 10)
  for (const country of countries) {
    try {
      return payrollTaxYearForDate(country, today).taxYear
    } catch {
      // A country with no pack declaration cannot name a year; try the next.
    }
  }
  return Number(today.slice(0, 4))
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const url = new URL(req.url)

  const blobRes = (await db.execute(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
  )) as unknown as { rows: { p: Record<string, unknown> | null }[] }
  const installed = await installedPayrollCountries(orgId, blobRes.rows[0]?.p ?? {})
  const requestedYear = Number(url.searchParams.get('year'))
  const year = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
    ? requestedYear
    : defaultYear(installed)

  const [rows, accounts] = await Promise.all([
    listStatutoryRates(orgId, { taxYear: year }),
    listFilingAccounts(orgId),
  ])

  // Only the installed packs' declarations — an org that runs one country is not
  // shown another's levies.
  const packs = []
  const gaps = []
  for (const country of installed) {
    let declaration
    try {
      declaration = packRates(country)
    } catch (error) {
      if (!(error instanceof PayrollPackError)) throw error
      continue // a pack that declares no tenant-entered rates has no surface
    }
    const regions = payrollPack(country).regions
    packs.push({
      country,
      regionLabel: regions.label,
      knownRegions: [...regions.known],
      slots: declaration.slots.map((slot) => ({
        key: slot.key,
        label: slot.label,
        scope: slot.scope,
        programType: slot.programType ?? null,
        regions: slot.regions ? [...slot.regions] : null,
        citation: slot.citation,
        variesBecause: slot.variesBecause,
        systemKeys: [...slot.systemKeys],
        fields: slot.fields.map((field) => ({ ...field })),
      })),
      accounts: accounts
        .filter((account) => account.country === country)
        .map((account) => ({
          id: account.id,
          accountNumber: account.accountNumber,
          name: account.name,
          programType: account.programType,
          stateCode: account.stateCode,
        })),
    })
    gaps.push(...await payrollStatutoryRateGaps(orgId, country, year))
  }

  return NextResponse.json({
    year,
    installed,
    packs,
    rows: rows.filter((row) => installed.includes(row.country)),
    gaps,
    // What the packs' statutory tables are loaded for — the same declaration the
    // readiness blocker and the year-end refusal read.
    coverage: payrollTaxYearCoverage().filter((entry) => installed.includes(entry.country)),
  })
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const parsed = parseBody(await req.json().catch(() => null))
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 422 })

  const account = parsed.filingAccountId
    ? (await listFilingAccounts(gate.user.orgId)).find((a) => a.id === parsed.filingAccountId) ?? null
    : null
  // The pack declaration is the only validator — scope, region, program type and
  // every field's scale and range come from it, exactly as filing-account
  // program types are validated against the pack's filing declaration.
  const problem = statutoryRateProblem({
    country: parsed.country,
    rateKey: parsed.rateKey,
    region: parsed.region,
    subRegion: parsed.subRegion,
    filingAccountId: parsed.filingAccountId,
    taxYear: parsed.taxYear,
    account: account
      ? { country: account.country, programType: account.programType, stateCode: account.stateCode }
      : null,
  })
  if (problem) return NextResponse.json({ error: problem }, { status: 422 })

  try {
    const saved = await upsertStatutoryRate({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      country: parsed.country,
      rateKey: parsed.rateKey,
      region: parsed.region,
      subRegion: parsed.subRegion,
      filingAccountId: parsed.filingAccountId,
      taxYear: parsed.taxYear,
      values: parsed.values,
    })
    return NextResponse.json({ ok: true, ...saved })
  } catch (error) {
    if (error instanceof PayrollPackError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

export async function DELETE(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid id' }, { status: 422 })
  const removed = await deleteStatutoryRate(gate.user.orgId, gate.user.id, id)
  if (!removed) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
