import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  PAYROLL_COUNTRY_PACKS,
} from '@openbooks/engine/src/payroll/packs.ts'
import {
  certificateAnswersProblem,
  packCertificates,
  payrollCertificate,
} from '@openbooks/engine/src/payroll/certificates.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Employee tax certificates — the pack-declared forms an employee files to
 * set their own withholding (or the employer-collected facts the pack prices
 * from), stored as rows in `employee_tax_certificates`.
 *
 * Every pack declares its certificates with typed fields
 * (engine/src/payroll/certificates.ts); this surface renders and validates
 * whatever the declarations admit and NOTHING else. No country, form number
 * or field key appears below: adding a certificate to a pack offers it here
 * with no edit, and an answer for a field the pack does not declare is
 * refused rather than stored where no engine reads it.
 *
 * Column-backed certificates (the pre-model W-4/TD1 family) are NOT served
 * here — they are edited through the payroll profile, which owns their
 * columns. Only `certificate_rows` certificates are listed and accepted.
 */

const certificateBodySchema = z.looseObject({
  employeePartyId: z.string(),
  country: z.string(),
  certificateKey: z.string(),
  region: z.string().nullable().optional(),
  subRegion: z.string().nullable().optional(),
  answers: z.record(z.string(), z.unknown()),
  effectiveFrom: z.string().nullable().optional(),
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

interface StoredRow {
  certificate_key: string
  country: string
  region: string | null
  sub_region: string | null
  answers: Record<string, string>
  effective_from: string | null
  superseded_on: string | null
}

async function employeeSubsidiaryId(orgId: string, employee: string) {
  const rows = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where org_id = ${orgId} and id = ${employee}`)).rows
  return rows.length === 1 ? rows[0]!.subsidiaryId : undefined
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const employee = new URL(req.url).searchParams.get('employee')
  if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
  const subsidiaryId = await employeeSubsidiaryId(gate.user.orgId, employee)
  if (subsidiaryId === undefined) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, subsidiaryId)
  if (denied) return denied

  // Row-backed declarations per pack: the forms this surface may store
  // answers for. Column-backed certificates stay on the profile editor.
  const declarations: Record<string, ReturnType<typeof packCertificates>> = {}
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const declared = packCertificates(country)
    declarations[country] = {
      country: declared.country,
      certificates: declared.certificates.filter((certificate) => certificate.storage === 'certificate_rows'),
    }
  }
  const stored = (await db.execute<StoredRow>(sql`
    select certificate_key, country, region, sub_region, answers,
           effective_from::text as effective_from, superseded_on::text as superseded_on
      from employee_tax_certificates
     where org_id = ${gate.user.orgId} and employee_party_id = ${employee}
     order by certificate_key, coalesce(region, ''), coalesce(sub_region, ''),
              effective_from nulls first`)).rows
  return NextResponse.json({
    countries: Object.keys(PAYROLL_COUNTRY_PACKS),
    declarations,
    stored,
  })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  const parsedBody = await parseJsonBody(req, certificateBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  if (!isUuid(body.employeePartyId)) return NextResponse.json({ error: 'employeePartyId required' }, { status: 422 })
  const subsidiaryId = await employeeSubsidiaryId(orgId, body.employeePartyId)
  if (subsidiaryId === undefined) return NextResponse.json({ error: 'employee is not available' }, { status: 422 })
  const denied = guardSubsidiaryScope(gate, subsidiaryId)
  if (denied) return denied

  // The pack registry is the only validator for the country and the form.
  const country = String(body.country ?? '')
  if (!(country in PAYROLL_COUNTRY_PACKS)) {
    return NextResponse.json({ error: 'unknown payroll country pack' }, { status: 422 })
  }
  let certificate
  try {
    certificate = payrollCertificate(country, String(body.certificateKey ?? ''))
  } catch {
    return NextResponse.json({ error: `unknown certificate "${String(body.certificateKey ?? '')}" for ${country}` }, { status: 422 })
  }
  if (certificate.storage !== 'certificate_rows') {
    return NextResponse.json(
      { error: `certificate "${certificate.key}" is edited through the payroll profile, not here` },
      { status: 422 },
    )
  }
  // The stored jurisdiction point must be the certificate's own scope: a
  // country-level form carries no region, a region-level form carries its
  // region, a sub-region form carries both. Anything else would fork "which
  // certificate is in force" into ambiguous rows.
  const region = body.region == null || body.region === '' ? null : String(body.region)
  const subRegion = body.subRegion == null || body.subRegion === '' ? null : String(body.subRegion)
  const { level } = certificate.scope
  if (level === 'country' && (region !== null || subRegion !== null)) {
    return NextResponse.json({ error: `certificate "${certificate.key}" is country-level and carries no region` }, { status: 422 })
  }
  if (level === 'region' && (region !== certificate.scope.region || subRegion !== null)) {
    return NextResponse.json({ error: `certificate "${certificate.key}" is filed for region "${certificate.scope.region ?? ''}"` }, { status: 422 })
  }
  if (level === 'sub_region' && (region !== certificate.scope.region || subRegion !== certificate.scope.subRegion)) {
    return NextResponse.json({ error: `certificate "${certificate.key}" is filed for "${certificate.scope.region ?? ''}/${certificate.scope.subRegion ?? ''}"` }, { status: 422 })
  }

  const effectiveFrom = body.effectiveFrom == null || body.effectiveFrom === ''
    ? null : String(body.effectiveFrom)
  if (effectiveFrom !== null && !ISO_DATE.test(effectiveFrom)) {
    return NextResponse.json({ error: 'effectiveFrom must be an ISO date (YYYY-MM-DD)' }, { status: 422 })
  }

  // Canonicalize before validating: empty answers are "unanswered" (the
  // reader falls back to the declared default), so they are dropped rather
  // than stored as empty strings beside real answers.
  const raw = body.answers ?? {}
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text === '') continue
    answers[key] = text
  }
  const problem = certificateAnswersProblem(certificate, answers)
  if (problem) return NextResponse.json({ error: problem }, { status: 422 })

  return withOrgTransaction(orgId, async () => {
    // The open-row lock serializes concurrent saves for one employee and
    // form: whoever commits second supersedes the first's row rather than
    // forking two current certificates (the partial unique index would
    // refuse that fork with a storage error; the lock refuses it first).
    const open = (await db.execute<{ id: string; effective_from: string | null }>(sql`
      select id, effective_from::text as effective_from from employee_tax_certificates
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
         and certificate_key = ${certificate.key}
         and coalesce(region, '') = coalesce(${region}, '')
         and coalesce(sub_region, '') = coalesce(${subRegion}, '')
         and superseded_on is null
       for update`)).rows
    // Backdating across a later certificate would fork the history the
    // engine reads as of a pay date: refuse, so the operator supersedes
    // forward instead.
    const effective = effectiveFrom ?? new Date().toISOString().slice(0, 10)
    for (const row of open) {
      if (row.effective_from !== null && row.effective_from > effective) {
        return NextResponse.json(
          { error: `a later "${certificate.key}" certificate (effective ${row.effective_from}) is already on file` },
          { status: 422 },
        )
      }
    }
    await db.execute(sql`
      update employee_tax_certificates
         set superseded_on = ${effective}::date, updated_by = ${userId}, updated_at = clock_timestamp()
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
         and certificate_key = ${certificate.key}
         and coalesce(region, '') = coalesce(${region}, '')
         and coalesce(sub_region, '') = coalesce(${subRegion}, '')
         and superseded_on is null`)
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into employee_tax_certificates
        (org_id, employee_party_id, country, certificate_key, region, sub_region,
         answers, effective_from, created_by, updated_by)
      values (${orgId}, ${body.employeePartyId}, ${country}, ${certificate.key},
              ${region}, ${subRegion}, ${JSON.stringify(answers)}::jsonb,
              ${effective}::date, ${userId}, ${userId})
      returning id`)).rows[0]!
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
      values (${orgId}, 'employee_tax_certificates', ${inserted.id}, 'insert',
        ${JSON.stringify({
          after: {
            certificate_key: certificate.key, country, region, sub_region: subRegion,
            answers, effective_from: effective,
            superseded: open.map((row) => row.id),
          },
        })}::jsonb,
        ${userId}, ${req.headers.get('X-Request-Id')}, clock_timestamp())`)
    return NextResponse.json({ ok: true })
  })
}
