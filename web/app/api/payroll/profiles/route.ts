import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sealSecret } from '@openbooks/engine/src/secrets.ts'
import { listFilingAccounts } from '@openbooks/engine/src/payroll-filing.ts'
import {
  employmentJurisdictionsOf,
  labourJurisdictionProblem,
  PAYROLL_COUNTRY_PACKS,
  payrollPack,
} from '@openbooks/engine/src/payroll/packs.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { guardPayrollFilingAccounts } from '../subsidiary-scope'
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

const FILING_STATUSES = new Set(['single', 'married_joint', 'head_household'])

/** employee_payroll_profiles.stub_delivery. */
const STUB_DELIVERIES = new Set(['email', 'print', 'both'])

/**
 * employee_payroll_profiles.payment_method — the payroll-owned override of the
 * rail. Empty/absent means "inherit the party preference"; the resolver
 * (engine/src/payroll-payment-method.ts) decides from there.
 */
const PAYMENT_METHODS = new Set(['eft', 'cheque'])

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

function claimCode(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 10) return 'invalid'
  return n
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
               prof.additional_tax_per_period, prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
               prof.filing_status, prof.multiple_jobs, prof.dependent_credits,
               prof.other_income_annual, prof.deductions_annual,
               prof.w4_pre_2020, prof.w4_allowances, prof.fica_exempt, prof.futa_exempt,
               prof.vacation_percent, prof.vacation_method, prof.is_active, prof.sin_last3,
               prof.filing_account_id, fa.account_number as filing_account_number,
               prof.stub_delivery, prof.payment_method
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          left join pay_schedules s on s.id = prof.pay_schedule_id and s.org_id = prof.org_id
          left join payroll_filing_accounts fa on fa.id = prof.filing_account_id and fa.org_id = prof.org_id
         where prof.org_id = ${gate.user.orgId} and prof.employee_party_id = ${employee}`),
      db.execute(sql`
        select id, name, frequency from pay_schedules
         where org_id = ${gate.user.orgId} and is_active
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
         order by name`),
    ]))
    return NextResponse.json({
      profile: profileRes.rows[0] ?? null,
      schedules: schedulesRes.rows,
      filingAccounts: await visibleFilingAccounts(gate),
      labourJurisdictions: labourJurisdictionOptions(),
      defaultCountry,
    })
  }
  const profiles = (await db.execute<Record<string, unknown>>(sql`
    select prof.id, prof.employee_party_id, p.display_name as employee_name,
           prof.pay_schedule_id, s.name as schedule_name, prof.country, prof.province,
           prof.labour_jurisdiction, prof.pay_basis,
           prof.federal_claim_code, prof.federal_claim_amount,
           prof.provincial_claim_code, prof.provincial_claim_amount,
           prof.additional_tax_per_period, prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
           prof.filing_status, prof.multiple_jobs, prof.dependent_credits,
           prof.other_income_annual, prof.deductions_annual,
           prof.w4_pre_2020, prof.w4_allowances, prof.fica_exempt, prof.futa_exempt,
           prof.vacation_percent, prof.vacation_method, prof.is_active,
           prof.filing_account_id, fa.account_number as filing_account_number,
           prof.stub_delivery, prof.payment_method
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join pay_schedules s on s.id = prof.pay_schedule_id and s.org_id = prof.org_id
      left join payroll_filing_accounts fa on fa.id = prof.filing_account_id and fa.org_id = prof.org_id
     where prof.org_id = ${gate.user.orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}
     order by p.display_name`))
  return NextResponse.json({
    profiles: profiles.rows,
    filingAccounts: await visibleFilingAccounts(gate),
    labourJurisdictions: labourJurisdictionOptions(),
  })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  const parsedBody = await parseJsonBody(req, jsonObject);
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
  // reason — but a region that does not exist is a typo, refused here.
  const province = String(body.province ?? '')
  if (!payrollPack(country).regions.known.includes(province)) {
    return NextResponse.json(
      { error: `invalid ${payrollPack(country).regions.label}` },
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

  const filingStatus = body.filingStatus == null || body.filingStatus === ''
    ? null : String(body.filingStatus)
  if (filingStatus !== null && !FILING_STATUSES.has(filingStatus)) {
    return NextResponse.json({ error: 'invalid filingStatus' }, { status: 422 })
  }
  let w4Allowances: number | null = null
  if (body.w4Allowances !== null && body.w4Allowances !== undefined && body.w4Allowances !== '') {
    const n = Number(body.w4Allowances)
    if (!Number.isInteger(n) || n < 0 || n > 99) {
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

  const federalClaimCode = claimCode(body.federalClaimCode)
  const provincialClaimCode = claimCode(body.provincialClaimCode)
  if (federalClaimCode === 'invalid' || provincialClaimCode === 'invalid') {
    return NextResponse.json({ error: 'claim codes must be 0–10' }, { status: 422 })
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
    if (value === null || compareDecimal(value, '0') < 0) {
      return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    }
    money[key] = normalizeMoney(value)
  }
  let vacationPercent: string | null = null
  if (body.vacationPercent !== null && body.vacationPercent !== undefined && body.vacationPercent !== '') {
    const vacationRaw = canonicalDecimal(body.vacationPercent, 4)
    if (vacationRaw === null || compareDecimal(vacationRaw, '0') < 0) {
      return NextResponse.json({ error: 'invalid vacationPercent' }, { status: 422 })
    }
    vacationPercent = normalizeMoney(vacationRaw)
  }

  const refs = (await Promise.all([
    db.execute(sql`
      select p.subsidiary_id as "subsidiaryId" from parties p
       join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId} and p.id = ${body.employeePartyId} and p.is_active`),
    db.execute(sql`
      select subsidiary_id as "subsidiaryId"
        from pay_schedules where org_id = ${orgId} and id = ${body.payScheduleId} and is_active`),
  ]))
  if (refs.some((result) => result.rows.length !== 1)) {
    return NextResponse.json({ error: 'employee or pay schedule is not available' }, { status: 422 })
  }
  // The employee and schedule are both payroll records. Resolve their legal
  // entities before the upsert so a restricted operator cannot re-home a
  // profile or edit another subsidiary by guessing an employee id.
  const employeeDenied = guardSubsidiaryScope(gate, (refs[0].rows[0] as { subsidiaryId: string | null }).subsidiaryId)
  if (employeeDenied) return employeeDenied
  const scheduleDenied = guardSubsidiaryScope(gate, (refs[1].rows[0] as { subsidiaryId: string | null }).subsidiaryId)
  if (scheduleDenied) return scheduleDenied
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

  // Sealed SIN/SSN: write-only from the client (send `sin` to set/replace;
  // omit to keep). Never echoed back — GET exposes sin_last3 only.
  let sinEncrypted: string | null | undefined
  let sinLast3: string | null | undefined
  if ('sin' in body) {
    const sin = String(body.sin ?? '').replace(/\D/g, '')
    if (sin === '') {
      sinEncrypted = null
      sinLast3 = null
    } else if (!/^\d{9}$/.test(sin)) {
      return NextResponse.json({ error: 'SIN/SSN must be 9 digits' }, { status: 422 })
    } else {
      sinEncrypted = sealSecret(sin)
      sinLast3 = sin.slice(-3)
    }
  }

  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, labour_jurisdiction, pay_basis,
       federal_claim_code, federal_claim_amount, provincial_claim_code, provincial_claim_amount,
       additional_tax_per_period, prescribed_zone_deduction, authorized_annual_deductions,
       authorized_federal_credits, authorized_provincial_credits,
       filing_status, multiple_jobs, dependent_credits, other_income_annual, deductions_annual,
       w4_pre_2020, w4_allowances, fica_exempt, futa_exempt,
       cpp_exempt, ei_exempt, tax_exempt, vacation_percent, vacation_method, is_active,
       sin_encrypted, sin_last3, filing_account_id, stub_delivery, payment_method,
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
                  sin_encrypted = case when ${sinEncrypted !== undefined} then excluded.sin_encrypted
                                       else employee_payroll_profiles.sin_encrypted end,
                  sin_last3 = case when ${sinLast3 !== undefined} then excluded.sin_last3
                                   else employee_payroll_profiles.sin_last3 end,
                  updated_at = now(), updated_by = ${userId}
    where employee_payroll_profiles.org_id = ${orgId}`)
  return NextResponse.json({ ok: true })
}
