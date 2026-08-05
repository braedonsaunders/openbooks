import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Employee payroll profiles (TD1 facts: schedule, province, claim codes,
 * exemptions, vacation policy). One profile per employee — POST upserts on the
 * employee. TD1 amounts and exemptions are confidential; the whole surface is
 * gated on payroll.manage.
 */

const PROVINCES = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT', 'ZZ',
])

const MONEY_KEYS = [
  'federalClaimAmount',
  'provincialClaimAmount',
  'additionalTaxPerPeriod',
  'prescribedZoneDeduction',
  'authorizedAnnualDeductions',
  'authorizedFederalCredits',
  'authorizedProvincialCredits',
] as const

function claimCode(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 10) return 'invalid'
  return n
}

export async function GET() {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const profiles = (await db.execute(sql`
    select prof.id, prof.employee_party_id, p.display_name as employee_name,
           prof.pay_schedule_id, s.name as schedule_name, prof.province, prof.pay_basis,
           prof.federal_claim_code, prof.federal_claim_amount,
           prof.provincial_claim_code, prof.provincial_claim_amount,
           prof.additional_tax_per_period, prof.cpp_exempt, prof.ei_exempt, prof.tax_exempt,
           prof.vacation_percent, prof.vacation_method, prof.is_active
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join pay_schedules s on s.id = prof.pay_schedule_id
     where prof.org_id = ${gate.user.orgId}
     order by p.display_name`)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ profiles: profiles.rows })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  const body = await req.json().catch(() => ({}))

  if (!isUuid(body.employeePartyId)) return NextResponse.json({ error: 'employeePartyId required' }, { status: 422 })
  if (!isUuid(body.payScheduleId)) return NextResponse.json({ error: 'payScheduleId required' }, { status: 422 })
  const province = String(body.province ?? '')
  if (!PROVINCES.has(province)) return NextResponse.json({ error: 'invalid province' }, { status: 422 })
  const payBasis = body.payBasis === 'salary' ? 'salary' : 'hourly'
  const vacationMethod = body.vacationMethod === 'pay_each_period' ? 'pay_each_period' : 'accrue'

  const federalClaimCode = claimCode(body.federalClaimCode)
  const provincialClaimCode = claimCode(body.provincialClaimCode)
  if (federalClaimCode === 'invalid' || provincialClaimCode === 'invalid') {
    return NextResponse.json({ error: 'claim codes must be 0–10' }, { status: 422 })
  }

  const money: Record<(typeof MONEY_KEYS)[number], string | null> = {
    federalClaimAmount: null,
    provincialClaimAmount: null,
    additionalTaxPerPeriod: null,
    prescribedZoneDeduction: null,
    authorizedAnnualDeductions: null,
    authorizedFederalCredits: null,
    authorizedProvincialCredits: null,
  }
  for (const key of MONEY_KEYS) {
    const raw = body[key]
    if (raw === null || raw === undefined || raw === '') continue
    const value = canonicalDecimal(raw, 2)
    if (value === null || compareDecimal(value, '0') < 0) {
      return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    }
    money[key] = value
  }
  let vacationPercent: string | null = null
  if (body.vacationPercent !== null && body.vacationPercent !== undefined && body.vacationPercent !== '') {
    vacationPercent = canonicalDecimal(body.vacationPercent, 4)
    if (vacationPercent === null || compareDecimal(vacationPercent, '0') < 0) {
      return NextResponse.json({ error: 'invalid vacationPercent' }, { status: 422 })
    }
  }

  const refs = (await Promise.all([
    db.execute(sql`
      select 1 from parties p
       join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId} and p.id = ${body.employeePartyId} and p.is_active`),
    db.execute(sql`
      select 1 from pay_schedules where org_id = ${orgId} and id = ${body.payScheduleId} and is_active`),
  ])) as unknown as { rows: unknown[] }[]
  if (refs.some((result) => result.rows.length !== 1)) {
    return NextResponse.json({ error: 'employee or pay schedule is not available' }, { status: 422 })
  }

  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       federal_claim_code, federal_claim_amount, provincial_claim_code, provincial_claim_amount,
       additional_tax_per_period, prescribed_zone_deduction, authorized_annual_deductions,
       authorized_federal_credits, authorized_provincial_credits,
       cpp_exempt, ei_exempt, tax_exempt, vacation_percent, vacation_method, is_active,
       created_by, updated_by)
    values (${orgId}, ${body.employeePartyId}, ${body.payScheduleId}, ${province}, ${payBasis},
            ${federalClaimCode}, ${money.federalClaimAmount}, ${provincialClaimCode}, ${money.provincialClaimAmount},
            ${money.additionalTaxPerPeriod}, ${money.prescribedZoneDeduction}, ${money.authorizedAnnualDeductions},
            ${money.authorizedFederalCredits}, ${money.authorizedProvincialCredits},
            ${body.cppExempt === true}, ${body.eiExempt === true}, ${body.taxExempt === true},
            ${vacationPercent}, ${vacationMethod}, ${body.isActive !== false},
            ${userId}, ${userId})
    on conflict (org_id, employee_party_id)
    do update set pay_schedule_id = excluded.pay_schedule_id, province = excluded.province,
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
                  cpp_exempt = excluded.cpp_exempt, ei_exempt = excluded.ei_exempt,
                  tax_exempt = excluded.tax_exempt, vacation_percent = excluded.vacation_percent,
                  vacation_method = excluded.vacation_method, is_active = excluded.is_active,
                  updated_at = now(), updated_by = ${userId}`)
  return NextResponse.json({ ok: true })
}
