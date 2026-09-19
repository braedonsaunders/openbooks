import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { sealSecret } from '@openbooks/engine/src/secrets.ts'
import { listFilingAccounts } from '@openbooks/engine/src/payroll-filing.ts'
import {
  employmentJurisdictionsOf,
  labourJurisdictionProblem,
  PAYROLL_COUNTRY_PACKS,
  payrollPack,
  validatePackEmployeeIdentifier,
} from '@openbooks/engine/src/payroll/packs.ts'
import {
  packCertificates,
  profileColumnChoices,
  profileColumnCountBounds,
  type PayrollCertificate,
} from '@openbooks/engine/src/payroll/certificates.ts'
import type { PayrollProfileExemptionFlag } from '@openbooks/engine/src/payroll/packs.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { guardPayrollFilingAccounts, payrollVisibleScheduleFilter } from '../subsidiary-scope'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Employee payroll profiles (TD1/W-4 facts: schedule, jurisdiction, claims,
 * exemptions, vacation policy). One profile per employee — POST upserts on the
 * employee. Claim amounts and exemptions are confidential; the whole surface
 * is gated on payroll.manage.
 */

/** employee_payroll_profiles.stub_delivery. */
const STUB_DELIVERIES = new Set(['email', 'print', 'both'])

/**
 * employee_payroll_profiles.payment_method — the payroll-owned override of the
 * rail. Empty/absent means "inherit the party preference"; the resolver
 * (engine/src/payroll-payment-method.ts) decides from there.
 */
const PAYMENT_METHODS = new Set(['eft', 'cheque'])

const optionalCount = z.union([z.number().int(), z.string().trim().regex(/^\d*$/)]).nullable().optional()
const profileBodySchema = z.looseObject({
  employeePartyId: z.string(),
  payScheduleId: z.string(),
  country: z.string().optional(),
  province: z.string().optional(),
  labourJurisdiction: z.string().nullable().optional(),
  payBasis: z.enum(['hourly', 'salary']).optional(),
  vacationMethod: z.enum(['accrue', 'pay_each_period']).optional(),
  filingStatus: z.string().nullable().optional(),
  filingAccountId: z.string().nullable().optional(),
  stubDelivery: z.string().optional(),
  paymentMethod: z.string().nullable().optional(),
  federalClaimCode: optionalCount,
  provincialClaimCode: optionalCount,
  w4Allowances: optionalCount,
  multipleJobs: z.boolean().optional(),
  w4Pre2020: z.boolean().optional(),
  ficaExempt: z.boolean().optional(),
  futaExempt: z.boolean().optional(),
  cppExempt: z.boolean().optional(),
  eiExempt: z.boolean().optional(),
  taxExempt: z.boolean().optional(),
  // Standing commission-pay status for statutory-holiday rules that read it.
  // Nullable three-state: true/false answers, null un-answers. Omit to keep.
  paidOnCommission: z.boolean().nullable().optional(),
  isActive: z.boolean().optional(),
  sin: z.string().nullable().optional(),
})

// Match the compliance editor's explicit, non-secret audit projection. A
// sealed taxpayer identifier is sensitive too; retain only presence/last3.
const PROFILE_AUDIT_COLUMNS = sql`
  id, org_id, employee_party_id, pay_schedule_id, country, province,
  residence_region, labour_jurisdiction, pay_basis,
  federal_claim_code, federal_claim_amount, provincial_claim_code, provincial_claim_amount,
  additional_tax_per_period, prescribed_zone_deduction, authorized_annual_deductions,
  authorized_federal_credits, authorized_provincial_credits,
  cpp_exempt, ei_exempt, tax_exempt, vacation_percent, vacation_method, is_active,
  union_agreement_id, union_classification_id,
  filing_status, multiple_jobs, dependent_credits, other_income_annual, deductions_annual,
  w4_pre_2020, w4_allowances, fica_exempt, futa_exempt,
  (sin_encrypted is not null) as sin_present, sin_last3,
  filing_account_id, stub_delivery, payment_method, paid_on_commission,
  created_at, created_by, updated_at, updated_by`

const MONEY_KEYS = [
  'federalClaimAmount',
  'provincialClaimAmount',
  'additionalTaxPerPeriod',
  'prescribedZoneDeduction',
  'authorizedAnnualDeductions',
  'authorizedFederalCredits',
  'authorizedProvincialCredits',
  'dependentCredits',
  'otherIncomeAnnual',
  'deductionsAnnual',
] as const

/**
 * The labour jurisdictions the installed packs declare, per country pack, for
 * the profile editor's optional override select.
 *
 * Employment scope only (`employmentJurisdictionsOf`): a tax administration's
 * own office calendar moves remittance due dates and governs nobody's
 * employment standards, so it is never offered. The editor renders whatever
 * this returns — adding a jurisdiction to a pack offers it with no edit here,
 * and the POST below refuses anything this list does not contain.
 */
function labourJurisdictionOptions(): Record<string, { key: string; name: string }[]> {
  const byCountry: Record<string, { key: string; name: string }[]> = {}
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    byCountry[country] = employmentJurisdictionsOf(country).map((jurisdiction) => ({
      key: jurisdiction.key,
      name: jurisdiction.name,
    }))
  }
  return byCountry
}

/**
 * What the profile editor renders, per country pack — served the same way as
 * `labourJurisdictions`, from the same registry, for the same reason: the
 * editor must render whatever the installed packs declare, never a
 * CA-or-US union with hardcoded subdivision lists.
 *
 * Subdivisions come from the pack's `regions` coverage (label, known codes,
 * supported subset with refusal reasons); the withholding section comes from
 * the pack's DECLARED certificates — every one of them, whichever storage
 * they use — plus its `profileExemptionFlags`. Row-backed certificates (state
 * DE 4, IT-2104, the P6/P9 notice…) render from the same declaration; their
 * answers file through POST /api/payroll/certificates and arrive here as
 * `storedCertificates` for prefill, so the editor renders fields the page can
 * actually populate.
 */
export interface PackProfileDeclaration {
  subdivisionLabel: string
  subdivisions: string[]
  supportedSubdivisions: string[]
  unsupportedReason: string
  unsupportedReasons: Record<string, string>
  certificates: PayrollCertificate[]
  exemptionFlags: readonly PayrollProfileExemptionFlag[]
  /**
   * The pack's employee identifier, served so the editor labels the sealed
   * field with the pack's own local name and shape — never a hardcoded
   * "SIN / SSN". Labels, examples and purposes are pack data shown exactly
   * as declared, like certificate labels and citations.
   */
  identifier: {
    label: string
    formatHelp: string
    example: string
    required: boolean
    neededFor: string | null
    numericEntry: boolean
  }
}

function packProfileDeclarations(): Record<string, PackProfileDeclaration> {
  const byCountry: Record<string, PackProfileDeclaration> = {}
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const pack = PAYROLL_COUNTRY_PACKS[country]!
    byCountry[country] = {
      subdivisionLabel: pack.regions.label,
      subdivisions: [...pack.regions.known],
      supportedSubdivisions: [...pack.regions.supported],
      unsupportedReason: pack.regions.unsupportedReason,
      unsupportedReasons: { ...(pack.regions.unsupportedReasons ?? {}) },
      certificates: [...packCertificates(country).certificates],
      exemptionFlags: pack.profileExemptionFlags ?? [],
      identifier: {
        label: pack.employeeIdentifier.label,
        formatHelp: pack.employeeIdentifier.formatHelp,
        example: pack.employeeIdentifier.example,
        required: pack.employeeIdentifier.requiredForPayroll,
        neededFor: pack.employeeIdentifier.neededFor,
        numericEntry: pack.employeeIdentifier.numericEntry,
      },
    }
  }
  return byCountry
}

/**
 * A column-mapped `count` answer (TD1 claim codes 0–10) against the band the
 * pack declares for the column. A non-empty answer for a column the pack does
 * not declare is refused rather than stored where no engine reads it.
 */
function claimCode(
  value: unknown,
  bounds: { min: number; max: number } | null,
): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null
  if (!bounds) return 'invalid'
  const n = Number(value)
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) return 'invalid'
  return n
}

/** Whole-digit width of a canonical decimal, for column-range guards. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

async function visibleFilingAccounts(gate: Parameters<typeof guardPayrollFilingAccounts>[0]) {
  const accounts = await listFilingAccounts(gate.user.orgId)
  if (gate.allowedSubsidiaryIds === null) return accounts
  const visible = await Promise.all(accounts.map(async (account) => ({
    account,
    denied: await guardPayrollFilingAccounts(gate, [account.id]),
  })))
  return visible.filter(({ denied }) => !denied).map(({ account }) => account)
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const employee = new URL(req.url).searchParams.get('employee')
  if (employee) {
    // Drawer-tab variant: one employee's profile (or null) + the schedules.
    if (!isUuid(employee)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
    const employeeScope = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId"
        from parties
       where org_id = ${gate.user.orgId} and id = ${employee}`)).rows[0]
    if (!employeeScope) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const denied = guardSubsidiaryScope(gate, employeeScope.subsidiaryId)
    if (denied) return denied
    // The default country for a NEW profile: the employee's own legal entity,
    // falling back to the root subsidiary, falling back to the org's sole
    // installed pack. Never a literal — the employer of record decides which
    // statutory engine runs, so it decides the default too. Null when nothing
    // answers; the operator then chooses explicitly.
    const defaultCountryRes = (await db.execute<{ country: string | null }>(sql`
      select coalesce(emp_sub.country, root_sub.country) as country
        from parties p
        left join subsidiaries emp_sub
          on emp_sub.id = p.subsidiary_id and emp_sub.org_id = p.org_id
        left join subsidiaries root_sub
          on root_sub.org_id = p.org_id and root_sub.parent_id is null and root_sub.is_active
       where p.org_id = ${gate.user.orgId} and p.id = ${employee}
       order by root_sub.created_at limit 1
    `))
    const subsidiaryCountry = defaultCountryRes.rows[0]?.country ?? null
    const installedRes = (await db.execute<{ countries: unknown }>(sql`
      select coalesce(settings#>'{payroll,countries}', '[]'::jsonb) as countries
        from orgs where id = ${gate.user.orgId}
    `))
    const installed = Array.isArray(installedRes.rows[0]?.countries)
      ? (installedRes.rows[0]!.countries as unknown[]).map(String).filter((c) => c in PAYROLL_COUNTRY_PACKS)
      : []
    const defaultCountry = subsidiaryCountry && subsidiaryCountry in PAYROLL_COUNTRY_PACKS
      ? subsidiaryCountry
      : installed.length === 1 ? installed[0]! : null
    const [profileRes, schedulesRes] = (await Promise.all([
      db.execute(sql`
        select prof.id, prof.employee_party_id, p.display_name as employee_name,
               prof.pay_schedule_id, s.name as schedule_name, prof.country, prof.province,
               prof.labour_jurisdiction, prof.pay_basis,
               prof.federal_claim_code, prof.federal_claim_amount,
               prof.provincial_claim_code, prof.provincial_claim_amount,
               prof.additional_tax_per_period, prof.prescribed_zone_deduction,
               prof.authorized_annual_deductions, prof.authorized_federal_credits,
               prof.authorized_provincial_credits,
               prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
               prof.filing_status, prof.multiple_jobs, prof.dependent_credits,
               prof.other_income_annual, prof.deductions_annual,
               prof.w4_pre_2020, prof.w4_allowances, prof.fica_exempt, prof.futa_exempt,
               prof.vacation_percent, prof.vacation_method, prof.is_active, prof.sin_last3,
               prof.filing_account_id, fa.account_number as filing_account_number,
               prof.stub_delivery, prof.payment_method, prof.paid_on_commission
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          left join pay_schedules s on s.id = prof.pay_schedule_id and s.org_id = prof.org_id
          left join payroll_filing_accounts fa on fa.id = prof.filing_account_id and fa.org_id = prof.org_id
         where prof.org_id = ${gate.user.orgId} and prof.employee_party_id = ${employee}`),
      db.execute(sql`
        select id, name, frequency from pay_schedules
         where org_id = ${gate.user.orgId} and is_active
           ${payrollVisibleScheduleFilter(gate)}
         order by name`),
    ]))
    const profileAccountDenied = await guardPayrollFilingAccounts(
      gate,
      [((profileRes.rows[0] as { filing_account_id?: string | null } | undefined)?.filing_account_id) ?? null],
    )
    if (profileAccountDenied) return profileAccountDenied
    // The employee's current (unsuperseded) row-backed certificate filings,
    // for prefilling the editor's row-backed fields. Superseded rows stay on
    // file for prior-period re-runs but never prefill: the editor files a new
    // current row, it does not edit history.
    const storedRes = await db.execute<{
      certificateKey: string; country: string; region: string | null; subRegion: string | null;
      answers: Record<string, string>; effectiveFrom: string | null;
    }>(sql`
      select certificate_key as "certificateKey", country, region,
             sub_region as "subRegion", answers,
             effective_from::text as "effectiveFrom"
        from employee_tax_certificates
       where org_id = ${gate.user.orgId} and employee_party_id = ${employee}
         and superseded_on is null
       order by certificate_key`)
    return NextResponse.json({
      profile: profileRes.rows[0] ?? null,
      storedCertificates: storedRes.rows,
      schedules: schedulesRes.rows,
      filingAccounts: await visibleFilingAccounts(gate),
      labourJurisdictions: labourJurisdictionOptions(),
      defaultCountry,
      countries: Object.keys(PAYROLL_COUNTRY_PACKS),
      packProfiles: packProfileDeclarations(),
    })
  }
  const profiles = (await db.execute<Record<string, unknown>>(sql`
    select prof.id, prof.employee_party_id, p.display_name as employee_name,
           prof.pay_schedule_id, s.name as schedule_name, prof.country, prof.province,
           prof.labour_jurisdiction, prof.pay_basis,
           prof.federal_claim_code, prof.federal_claim_amount,
           prof.provincial_claim_code, prof.provincial_claim_amount,
           prof.additional_tax_per_period, prof.prescribed_zone_deduction,
           prof.authorized_annual_deductions, prof.authorized_federal_credits,
           prof.authorized_provincial_credits,
           prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
           prof.filing_status, prof.multiple_jobs, prof.dependent_credits,
           prof.other_income_annual, prof.deductions_annual,
           prof.w4_pre_2020, prof.w4_allowances, prof.fica_exempt, prof.futa_exempt,
           prof.vacation_percent, prof.vacation_method, prof.is_active,
           prof.filing_account_id, fa.account_number as filing_account_number,
           prof.stub_delivery, prof.payment_method, prof.paid_on_commission
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join pay_schedules s on s.id = prof.pay_schedule_id and s.org_id = prof.org_id
      left join payroll_filing_accounts fa on fa.id = prof.filing_account_id and fa.org_id = prof.org_id
     where prof.org_id = ${gate.user.orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}
     order by p.display_name`))
  // A profile can name a filing account attached to another legal entity even
  // when its employee is visible. Refuse the aggregate rather than returning
  // account metadata that the caller cannot otherwise inspect.
  for (const profile of profiles.rows) {
    const denied = await guardPayrollFilingAccounts(
      gate,
      [typeof profile.filing_account_id === 'string' ? profile.filing_account_id : null],
    )
    if (denied) return denied
  }
  const filingAccounts = await visibleFilingAccounts(gate)
  return NextResponse.json({
    profiles: profiles.rows,
    filingAccounts,
    labourJurisdictions: labourJurisdictionOptions(),
    countries: Object.keys(PAYROLL_COUNTRY_PACKS),
    packProfiles: packProfileDeclarations(),
  })
}

/**
 * What the operator supplied, safe to put in a refusal. The body is arbitrary
 * JSON: an object would stringify to "[object Object]" and tell them nothing,
 * and a pasted megabyte would come back whole. Name the type instead, and cap
 * the echo — a refusal has to be readable in a toast.
 */
function suppliedValue(raw: unknown): string {
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw !== 'string') return Array.isArray(raw) ? 'a list' : `a ${raw === null ? 'null' : typeof raw}`
  return raw.length > 40 ? `${raw.slice(0, 40)}… (${raw.length} characters)` : raw
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  const parsedBody = await parseJsonBody(req, profileBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  if (!isUuid(body.employeePartyId)) return NextResponse.json({ error: 'employeePartyId required' }, { status: 422 })
  if (!isUuid(body.payScheduleId)) return NextResponse.json({ error: 'payScheduleId required' }, { status: 422 })
  // The pack registry is the only country validator. The old
  // `body.country === 'US' ? 'US' : 'CA'` cast turned every unrecognised
  // value — '' from a blank default included — into a Canadian profile.
  const country = String(body.country ?? '')
  if (!(country in PAYROLL_COUNTRY_PACKS)) {
    return NextResponse.json({ error: 'unknown payroll country pack' }, { status: 422 })
  }
  // The pack declares its own KNOWN regions (ZZ included for CA). A known but
  // unimplemented region is saveable — the run refuses it with the pack's own
  // reason — but a region that does not exist is a typo, refused here. The
  // refusal names the pack's own label, the received value (or its absence),
  // the valid codes, and a valid example: a bare "invalid state" names none
  // of those, so a missing region and a mistyped one refuse separately.
  const { label: regionLabel, known: knownRegions } = payrollPack(country).regions
  const province = String(body.province ?? '')
  if (!knownRegions.includes(province)) {
    const choices = knownRegions.join(', ')
    const example = knownRegions[0]!
    return NextResponse.json(
      {
        error: province.trim() === ''
          ? `No ${regionLabel} on this ${country} payroll profile — choose one of ${choices} (e.g. ${example})`
          : `Unknown ${regionLabel} "${province}" on this ${country} payroll profile — choose one of ${choices} (e.g. ${example})`,
      },
      { status: 422 },
    )
  }
  // The labour jurisdiction whose EMPLOYMENT STANDARDS govern the employment,
  // when it is not the one the work region implies. Empty = derive it from the
  // region, which is the answer for almost every employment. The pack's
  // declarations are the only validator — an undeclared key is refused BY NAME
  // here rather than accepted and then silently replaced by the region's
  // calendar deep inside a pay run.
  const labourJurisdiction = body.labourJurisdiction == null || body.labourJurisdiction === ''
    ? null : String(body.labourJurisdiction).trim().toUpperCase()
  const labourProblem = labourJurisdictionProblem(country, labourJurisdiction)
  if (labourProblem) {
    return NextResponse.json({ error: labourProblem }, { status: 422 })
  }

  // Withholding answers are validated against the pack's declared certificate
  // fields — the W-4's choice set, its 0–99 allowance band — never a hardcoded
  // copy of one pack's form. An answer for a column the pack does not declare
  // is refused rather than stored where no engine reads it.
  const filingStatus = body.filingStatus == null || body.filingStatus === ''
    ? null : String(body.filingStatus)
  const filingChoices = profileColumnChoices(country, 'filing_status')
  if (filingStatus !== null && (!filingChoices || !filingChoices.includes(filingStatus))) {
    return NextResponse.json({ error: 'invalid filingStatus' }, { status: 422 })
  }
  let w4Allowances: number | null = null
  if (body.w4Allowances !== null && body.w4Allowances !== undefined && body.w4Allowances !== '') {
    const allowanceBounds = profileColumnCountBounds(country, 'w4_allowances')
    const n = Number(body.w4Allowances)
    if (!allowanceBounds || !Number.isInteger(n) || n < allowanceBounds.min || n > allowanceBounds.max) {
      return NextResponse.json({ error: 'invalid w4Allowances' }, { status: 422 })
    }
    w4Allowances = n
  }
  const payBasis = body.payBasis === 'salary' ? 'salary' : 'hourly'
  const vacationMethod = body.vacationMethod === 'pay_each_period' ? 'pay_each_period' : 'accrue'
  // Filing identity + stub delivery. A null filing account means "the country
  // pack's default account", which is how single-account employers stay.
  const filingAccountId = body.filingAccountId == null || body.filingAccountId === ''
    ? null : String(body.filingAccountId)
  if (filingAccountId !== null && !isUuid(filingAccountId)) {
    return NextResponse.json({ error: 'invalid filingAccountId' }, { status: 422 })
  }
  const stubDelivery = STUB_DELIVERIES.has(String(body.stubDelivery ?? 'email'))
    ? String(body.stubDelivery ?? 'email')
    : null
  if (stubDelivery === null) {
    return NextResponse.json({ error: 'invalid stubDelivery' }, { status: 422 })
  }
  const paymentMethod = body.paymentMethod == null || body.paymentMethod === ''
    ? null : String(body.paymentMethod)
  if (paymentMethod !== null && !PAYMENT_METHODS.has(paymentMethod)) {
    return NextResponse.json({ error: 'invalid paymentMethod' }, { status: 422 })
  }

  const federalClaimBounds = profileColumnCountBounds(country, 'federal_claim_code')
  const provincialClaimBounds = profileColumnCountBounds(country, 'provincial_claim_code')
  const federalClaimCode = claimCode(body.federalClaimCode, federalClaimBounds)
  const provincialClaimCode = claimCode(body.provincialClaimCode, provincialClaimBounds)
  if (federalClaimCode === 'invalid' || provincialClaimCode === 'invalid') {
    // Name the band the pack actually declares: a hardcoded 0–10 here would
    // be a third copy of the TD1's shape.
    const band = federalClaimCode === 'invalid' ? federalClaimBounds : provincialClaimBounds
    return NextResponse.json(
      { error: band ? `claim code must be ${band.min}–${band.max}` : 'claim code is not declared by this pack' },
      { status: 422 },
    )
  }
  // TP-1015.3-V carries an AMOUNT (line 10) — Québec has no claim codes, so a
  // code on a QC profile is a data-entry error the engine would have to guess
  // at. Enter the TP-1015.3-V line 10 amount instead (provincialClaimAmount).
  if (country === 'CA' && province === 'QC' && provincialClaimCode !== null) {
    return NextResponse.json(
      { error: 'Québec uses a TP-1015.3-V claim AMOUNT, not a claim code — enter the amount and leave the provincial claim code empty' },
      { status: 422 },
    )
  }

  const money: Record<(typeof MONEY_KEYS)[number], string | null> = {
    federalClaimAmount: null,
    provincialClaimAmount: null,
    additionalTaxPerPeriod: null,
    prescribedZoneDeduction: null,
    authorizedAnnualDeductions: null,
    authorizedFederalCredits: null,
    authorizedProvincialCredits: null,
    dependentCredits: null,
    otherIncomeAnnual: null,
    deductionsAnnual: null,
  }
  for (const key of MONEY_KEYS) {
    const raw = body[key]
    if (raw === null || raw === undefined || raw === '') continue
    const value = canonicalDecimal(raw, 2)
    // The profile money columns are numeric(19,4): fifteen whole digits. The
    // shape check admits any magnitude, so a pasted 20-digit figure died in
    // the upsert with a storage error. Fail closed with the existing refusal.
    // Three distinct causes; name which one and what the operator supplied.
    // One message covering all three is what made the twenty-digit paste
    // undiagnosable in the first place.
    if (value === null) {
      return NextResponse.json(
        { error: `${key} must be an amount — "${suppliedValue(body[key])}" is not a number` },
        { status: 422 },
      )
    }
    if (compareDecimal(value, '0') < 0) {
      return NextResponse.json(
        { error: `${key} cannot be negative — got ${value}` },
        { status: 422 },
      )
    }
    if (wholeDigits(value) > 15) {
      return NextResponse.json(
        { error: `${key} is limited to 15 digits before the decimal point — got ${wholeDigits(value)}` },
        { status: 422 },
      )
    }
    money[key] = normalizeMoney(value)
  }
  let vacationPercent: string | null = null
  if (body.vacationPercent !== null && body.vacationPercent !== undefined && body.vacationPercent !== '') {
    const vacationRaw = canonicalDecimal(body.vacationPercent, 4)
    // vacation_percent is numeric(7,4): three whole digits for the same reason.
    if (vacationRaw === null) {
      return NextResponse.json(
        { error: `vacationPercent must be a percentage — "${suppliedValue(body.vacationPercent)}" is not a number` },
        { status: 422 },
      )
    }
    if (compareDecimal(vacationRaw, '0') < 0) {
      return NextResponse.json(
        { error: `vacationPercent cannot be negative — got ${vacationRaw}` },
        { status: 422 },
      )
    }
    if (wholeDigits(vacationRaw) > 3) {
      return NextResponse.json(
        { error: `vacationPercent is limited to 3 digits before the decimal point — got ${wholeDigits(vacationRaw)}` },
        { status: 422 },
      )
    }
    vacationPercent = normalizeMoney(vacationRaw)
  }

  return withOrgTransaction(orgId, async () => {
    const refs = (await Promise.all([
      db.execute(sql`
        select p.subsidiary_id as "subsidiaryId" from parties p
         join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
         where p.org_id = ${orgId} and p.id = ${body.employeePartyId} and p.is_active
         for no key update of p for share of er`),
      db.execute(sql`
        select subsidiary_id as "subsidiaryId"
          from pay_schedules where org_id = ${orgId} and id = ${body.payScheduleId} and is_active
          for share`),
    ]))
    // The two locking reads above stay exactly as they are: one round trip on
    // the success path. A zero-row inner join is a single outcome for three
    // employee-side causes (no such party, inactive party, no active role),
    // so the refusal below re-reads with a left join to resolve WHICH
    // predicate failed — but only on this failure path, never on success.
    if (refs[0].rows.length !== 1 || refs[1].rows.length !== 1) {
      if (refs[0].rows.length !== 1) {
        const employee = (await db.execute<{ partyActive: boolean | null; roleActive: boolean | null }>(sql`
          select p.is_active as "partyActive", er.is_active as "roleActive"
            from parties p left join employee_roles er
              on er.party_id = p.id and er.org_id = p.org_id
           where p.org_id = ${orgId} and p.id = ${body.employeePartyId}`)).rows[0]
        if (!employee) return NextResponse.json({ error: 'employee is not available' }, { status: 422 })
        if (!employee.partyActive) {
          return NextResponse.json(
            { error: 'this employee is still a draft — save the employee record first, then set up payroll' },
            { status: 422 },
          )
        }
        return NextResponse.json({ error: 'employee role is not active for this party' }, { status: 422 })
      }
      return NextResponse.json({ error: 'pay schedule is not available' }, { status: 422 })
    }
    // The employee and schedule are both payroll records. Resolve their legal
    // entities before the upsert so a restricted operator cannot re-home a
    // profile or edit another subsidiary by guessing an employee id.
    const employeeSubsidiaryId = (refs[0].rows[0] as { subsidiaryId: string | null }).subsidiaryId
    const scheduleSubsidiaryId = (refs[1].rows[0] as { subsidiaryId: string | null }).subsidiaryId
    const employeeDenied = guardSubsidiaryScope(gate, employeeSubsidiaryId)
    if (employeeDenied) return employeeDenied
    const scheduleDenied = guardSubsidiaryScope(gate, scheduleSubsidiaryId)
    if (scheduleDenied) return scheduleDenied
    // A scoped schedule pins the run's legal entity, currency, and employee
    // population. An org-wide NULL schedule deliberately remains a wildcard;
    // a non-NULL schedule may only be assigned to an employee of that entity.
    if (scheduleSubsidiaryId !== null && employeeSubsidiaryId !== scheduleSubsidiaryId) {
      return NextResponse.json(
        { error: 'employee and pay schedule must belong to the same subsidiary' },
        { status: 422 },
      )
    }
    const filingDenied = await guardPayrollFilingAccounts(gate, [filingAccountId])
    if (filingDenied) return filingDenied
    if (filingAccountId !== null) {
      // The account must exist, be active, and file under the same country pack
      // as the employee — a CA employee can never be filed on a US EIN.
      const account = (await db.execute(sql`
        select 1 from payroll_filing_accounts
         where org_id = ${orgId} and id = ${filingAccountId} and is_active and country = ${country}`,
      ))
      if (account.rows.length !== 1) {
        return NextResponse.json({ error: 'filing account is not available for this country' }, { status: 422 })
      }
    }

    // Standing commission-pay status: send true/false to answer, null to
    // un-answer, omit to keep. A full-profile save that is silent on the
    // fact must never reset it — null is "nobody has answered" and the
    // engine fails closed on it, so only an explicit key in the body moves
    // the column either way.
    const answersCommission = 'paidOnCommission' in body
    const paidOnCommission = body.paidOnCommission ?? null

    // Sealed national identifier: write-only from the client (send `sin` to
    // set/replace; omit to keep). Never echoed back — GET exposes sin_last3
    // only. The value is judged AS GIVEN against the country pack's own
    // `employeeIdentifier` declaration — never stripped, never counted to
    // nine, never named by country here. A pack whose identifier is not
    // required for payroll clears on empty.
    let sinEncrypted: string | null | undefined
    let sinLast3: string | null | undefined
    if ('sin' in body) {
      const verdict = validatePackEmployeeIdentifier(country, body.sin)
      if (!verdict.valid) {
        return NextResponse.json({ error: verdict.message }, { status: 422 })
      }
      if (verdict.saved === null) {
        sinEncrypted = null
        sinLast3 = null
      } else {
        sinEncrypted = sealSecret(verdict.saved)
        sinLast3 = verdict.saved.slice(-3)
      }
    }

    // The employee lock also serializes first creation, when no profile row
    // exists yet. Capture the committed predecessor before changing any field.
    const before = (await db.execute<Record<string, unknown>>(sql`
      select ${PROFILE_AUDIT_COLUMNS} from employee_payroll_profiles
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
       for update
    `)).rows[0]
    const after = (await db.execute<Record<string, unknown>>(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, labour_jurisdiction, pay_basis,
         federal_claim_code, federal_claim_amount, provincial_claim_code, provincial_claim_amount,
         additional_tax_per_period, prescribed_zone_deduction, authorized_annual_deductions,
         authorized_federal_credits, authorized_provincial_credits,
         filing_status, multiple_jobs, dependent_credits, other_income_annual, deductions_annual,
         w4_pre_2020, w4_allowances, fica_exempt, futa_exempt,
         cpp_exempt, ei_exempt, tax_exempt, vacation_percent, vacation_method, is_active,
         sin_encrypted, sin_last3, filing_account_id, stub_delivery, payment_method,
         paid_on_commission,
         created_by, updated_by)
      values (${orgId}, ${body.employeePartyId}, ${body.payScheduleId}, ${country}, ${province},
              ${labourJurisdiction}, ${payBasis},
              ${federalClaimCode}, ${money.federalClaimAmount}, ${provincialClaimCode}, ${money.provincialClaimAmount},
              ${money.additionalTaxPerPeriod}, ${money.prescribedZoneDeduction}, ${money.authorizedAnnualDeductions},
              ${money.authorizedFederalCredits}, ${money.authorizedProvincialCredits},
              ${filingStatus}, ${body.multipleJobs === true}, ${money.dependentCredits},
              ${money.otherIncomeAnnual}, ${money.deductionsAnnual},
              ${body.w4Pre2020 === true}, ${w4Allowances},
              ${body.ficaExempt === true}, ${body.futaExempt === true},
              ${body.cppExempt === true}, ${body.eiExempt === true}, ${body.taxExempt === true},
              ${vacationPercent}, ${vacationMethod}, ${body.isActive !== false},
              ${sinEncrypted ?? null}, ${sinLast3 ?? null}, ${filingAccountId}, ${stubDelivery},
              ${paymentMethod},
              ${paidOnCommission},
              ${userId}, ${userId})
      on conflict (org_id, employee_party_id)
      do update set pay_schedule_id = excluded.pay_schedule_id, country = excluded.country,
                    province = excluded.province,
                    labour_jurisdiction = excluded.labour_jurisdiction,
                    pay_basis = excluded.pay_basis,
                    federal_claim_code = excluded.federal_claim_code,
                    federal_claim_amount = excluded.federal_claim_amount,
                    provincial_claim_code = excluded.provincial_claim_code,
                    provincial_claim_amount = excluded.provincial_claim_amount,
                    additional_tax_per_period = excluded.additional_tax_per_period,
                    prescribed_zone_deduction = excluded.prescribed_zone_deduction,
                    authorized_annual_deductions = excluded.authorized_annual_deductions,
                    authorized_federal_credits = excluded.authorized_federal_credits,
                    authorized_provincial_credits = excluded.authorized_provincial_credits,
                    filing_status = excluded.filing_status, multiple_jobs = excluded.multiple_jobs,
                    dependent_credits = excluded.dependent_credits,
                    other_income_annual = excluded.other_income_annual,
                    deductions_annual = excluded.deductions_annual,
                    w4_pre_2020 = excluded.w4_pre_2020, w4_allowances = excluded.w4_allowances,
                    fica_exempt = excluded.fica_exempt, futa_exempt = excluded.futa_exempt,
                    cpp_exempt = excluded.cpp_exempt, ei_exempt = excluded.ei_exempt,
                    tax_exempt = excluded.tax_exempt, vacation_percent = excluded.vacation_percent,
                    vacation_method = excluded.vacation_method, is_active = excluded.is_active,
                    filing_account_id = excluded.filing_account_id,
                    stub_delivery = excluded.stub_delivery,
                    payment_method = excluded.payment_method,
                    paid_on_commission = case when ${answersCommission} then excluded.paid_on_commission
                                             else employee_payroll_profiles.paid_on_commission end,
                    sin_encrypted = case when ${sinEncrypted !== undefined} then excluded.sin_encrypted
                                         else employee_payroll_profiles.sin_encrypted end,
                    sin_last3 = case when ${sinLast3 !== undefined} then excluded.sin_last3
                                     else employee_payroll_profiles.sin_last3 end,
                    updated_at = greatest(clock_timestamp(), employee_payroll_profiles.updated_at + interval '1 microsecond'), updated_by = ${userId}
      where employee_payroll_profiles.org_id = ${orgId}
      returning ${PROFILE_AUDIT_COLUMNS}`)).rows[0]
    if (!after) throw new Error('payroll profile save returned no row')
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
      values (${orgId}, 'employee_payroll_profiles', ${after.id}, ${before ? 'update' : 'insert'},
        ${JSON.stringify({ ...(before ? { before } : {}), after })}::jsonb,
        ${userId}, ${req.headers.get('X-Request-Id')}, clock_timestamp())`)
    return NextResponse.json({ ok: true })
  })
}
