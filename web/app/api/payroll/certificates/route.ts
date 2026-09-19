import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { normalizeDecimal } from '@openbooks/engine/src/money.ts'
import { compareDecimal } from '@openbooks/engine/src/exact-decimal.ts'
import { PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import {
  payrollCertificate,
  type PayrollCertificate,
  type PayrollCertificateField,
} from '@openbooks/engine/src/payroll/certificates.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Employee tax-certificate filings (answers on pack-declared certificates that
 * store in `employee_tax_certificates` rows rather than profile columns).
 *
 * The packs DECLARE; this route validates PURELY from the declaration — kinds,
 * required-ness, choices, bounds, scope — and names the declaration in every
 * refusal. Nothing here names a country, a form, or a field: a new pack's
 * certificates file through this route with no edit to it.
 *
 * Effective dating is the load-bearing invariant: a new filing for the same
 * (employee, certificate, scope slot) SUPERSEDES the current row instead of
 * overwriting it, because the engine deliberately re-runs prior periods
 * against the certificate in force on the pay date. Overwriting would silently
 * change historical pay runs. The partial unique index on current rows
 * enforces the same rule in the database; the supersede-then-insert runs in
 * one transaction so the two cannot disagree.
 */

const certificateBodySchema = z.looseObject({
  employeePartyId: z.string(),
  country: z.string().optional(),
  certificateKey: z.string().optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  effectiveFrom: z.string().nullable().optional(),
})

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function validDate(value: string): boolean {
  const match = DATE_RE.exec(value.trim())
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const roundTrip = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
  return roundTrip === `${match[1]}-${match[2]}-${match[3]}`
}

const FLAG_TRUE = new Set(['true', '1', 'yes'])
const FLAG_FALSE = new Set(['false', '0', 'no'])

/**
 * One raw answer validated and normalized against its declared field, or a
 * refusal naming the field. Empty input means "unanswered" for every kind —
 * the engine falls through to the pack's declared default, so an unanswered
 * field is omitted rather than stored as an empty string.
 */
function normalizeAnswer(
  certificate: PayrollCertificate,
  field: PayrollCertificateField,
  raw: unknown,
): { answer?: string; error?: string } {
  const label = `${certificate.form} ${field.label} ("${field.key}")`
  if (raw === null || raw === undefined) return {}
  const text = typeof raw === 'boolean' ? (raw ? 'true' : 'false') : String(raw).trim()
  if (text === '') return {}
  switch (field.kind) {
    case 'choice': {
      const values = (field.choices ?? []).map((choice) => choice.value)
      if (!values.includes(text)) {
        return { error: `${label} must be one of ${values.join(', ')} — got "${text}"` }
      }
      return { answer: text }
    }
    case 'count': {
      if (!/^\d+$/.test(text)) {
        return { error: `${label} must be a whole number — got "${text}"` }
      }
      const count = Number(text)
      if (field.min != null && count < Number(field.min)) {
        return { error: `${label} is below the declared minimum ${field.min} — got "${text}"` }
      }
      if (field.max != null && count > Number(field.max)) {
        return { error: `${label} is above the declared maximum ${field.max} — got "${text}"` }
      }
      return { answer: text }
    }
    case 'amount': {
      let canonical: string
      try {
        canonical = normalizeDecimal(text, field.decimals ?? 2)
      } catch {
        return { error: `${label} is not a valid amount at the declared scale — got "${text}"` }
      }
      if (field.min != null && compareDecimal(canonical, field.min) < 0) {
        return { error: `${label} is below the declared minimum ${field.min} — got "${text}"` }
      }
      if (field.max != null && compareDecimal(canonical, field.max) > 0) {
        return { error: `${label} is above the declared maximum ${field.max} — got "${text}"` }
      }
      return { answer: canonical }
    }
    case 'flag': {
      const lowered = text.toLowerCase()
      if (FLAG_TRUE.has(lowered)) return { answer: 'true' }
      if (FLAG_FALSE.has(lowered)) return { answer: 'false' }
      return { error: `${label} is a checkbox — answer "true" or "false", got "${text}"` }
    }
    case 'code': {
      return { answer: text }
    }
  }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  const parsedBody = await parseJsonBody(req, certificateBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  if (!isUuid(body.employeePartyId)) {
    return NextResponse.json({ error: 'employeePartyId required' }, { status: 422 })
  }
  // The pack registry is the only country validator — the same rule the
  // profiles route enforces, so a certificate can never be filed under a pack
  // that does not exist.
  const country = String(body.country ?? '')
  if (!(country in PAYROLL_COUNTRY_PACKS)) {
    return NextResponse.json({ error: 'unknown payroll country pack' }, { status: 422 })
  }
  const key = String(body.certificateKey ?? '').trim()
  let certificate: PayrollCertificate
  try {
    certificate = payrollCertificate(country, key)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : `unknown certificate "${key}"` },
      { status: 422 },
    )
  }
  // Column-stored certificates predate this storage and are still read from
  // the profile: filing a row for one would shadow the column the engine
  // actually reads, so it is refused by name rather than stored where it
  // would silently win.
  if (certificate.storage === 'profile_columns') {
    return NextResponse.json(
      {
        error: `"${key}" stores its answers in payroll profile columns — file it through `
          + 'the payroll profile, not as a certificate row',
      },
      { status: 422 },
    )
  }

  // Every key in the filing must be a field the pack declared. The pack is
  // the contract: the API invents no field and accepts none the pack never
  // declared.
  const rawAnswers = body.answers ?? {}
  const declaredByKey = new Map(certificate.fields.map((field) => [field.key, field]))
  for (const answerKey of Object.keys(rawAnswers)) {
    if (!declaredByKey.has(answerKey)) {
      return NextResponse.json(
        {
          error: `${certificate.form} declares no "${answerKey}" field — it declares `
            + (certificate.fields.map((field) => field.key).join(', ') || 'none'),
        },
        { status: 422 },
      )
    }
  }
  const answers: Record<string, string> = {}
  for (const field of certificate.fields) {
    const normalized = normalizeAnswer(certificate, field, rawAnswers[field.key])
    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 422 })
    }
    if (normalized.answer !== undefined) answers[field.key] = normalized.answer
    // Required-ness mirrors the engine's own resolution: a required field
    // with a declared default is satisfied by that default (a statutory fact,
    // not a guess), so only a required field with NO answer AND no default is
    // missing. An empty filing answers nothing at all and must never satisfy
    // the engine — it is refused outright rather than stored as a blank row
    // that would read as "on file".
    if (normalized.answer === undefined && field.required && field.default == null) {
      return NextResponse.json(
        { error: `${certificate.form} ${field.label} ("${field.key}") is required` },
        { status: 422 },
      )
    }
  }
  if (Object.keys(answers).length === 0) {
    return NextResponse.json(
      { error: `"${key}" has no answers — nothing to file` },
      { status: 422 },
    )
  }

  const effectiveFrom = body.effectiveFrom == null || body.effectiveFrom === ''
    ? null
    : String(body.effectiveFrom).trim()
  if (effectiveFrom !== null && !validDate(effectiveFrom)) {
    return NextResponse.json({ error: 'effectiveFrom must be a real YYYY-MM-DD date' }, { status: 422 })
  }

  // region / sub_region come from the certificate's declared scope — never
  // inferred from the key's name, and never taken from the request body.
  const region = certificate.scope.region ?? null
  const subRegion = certificate.scope.subRegion ?? null

  return withOrgTransaction(orgId, async () => {
    const employee = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select p.subsidiary_id as "subsidiaryId" from parties p
       join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId} and p.id = ${body.employeePartyId} and p.is_active
       for no key update of p`)).rows[0]
    if (!employee) {
      return NextResponse.json({ error: 'employee is not available' }, { status: 422 })
    }
    const denied = guardSubsidiaryScope(gate, employee.subsidiaryId)
    if (denied) return denied
    // The scope check reads the employee's own profile: a region-scoped
    // certificate files only for an employee of that region. The declared
    // scope is the authority — the key's name is never parsed.
    const profile = (await db.execute<{ country: string; province: string }>(sql`
      select country, province from employee_payroll_profiles
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}`)).rows[0]
    if (!profile) {
      return NextResponse.json(
        { error: 'no payroll profile for this employee — save the profile before filing a certificate' },
        { status: 422 },
      )
    }
    if (profile.country !== country) {
      return NextResponse.json(
        {
          error: `"${key}" belongs to the ${country} payroll pack but this employee's profile `
            + `is under ${profile.country} — file the certificate the employee's own pack declares`,
        },
        { status: 422 },
      )
    }
    if (certificate.scope.level !== 'country' && profile.province !== region) {
      return NextResponse.json(
        {
          error: `"${key}" is scoped to ${region ?? '(unscoped)'} but this employee works in `
            + `${profile.province || '(no region)'} — a certificate files only for its own region`,
        },
        { status: 422 },
      )
    }

    // One transaction: supersede the current row, then insert the new one.
    // The partial unique index on current rows enforces the same rule in the
    // database, so a second current row fails rather than forking history.
    const current = (await db.execute<{ id: string; effectiveFrom: string | null }>(sql`
      select id, effective_from::text as "effectiveFrom" from employee_tax_certificates
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
         and certificate_key = ${key}
         and coalesce(region, '') = coalesce(${region}, '')
         and coalesce(sub_region, '') = coalesce(${subRegion}, '')
         and superseded_on is null
       for update`)).rows[0]
    const newEffective = effectiveFrom ?? new Date().toISOString().slice(0, 10)
    if (current?.effectiveFrom && newEffective < current.effectiveFrom) {
      return NextResponse.json(
        {
          error: `"${key}" is already on file effective ${current.effectiveFrom} — a filing effective `
            + `${newEffective} would rewrite history it does not own`,
        },
        { status: 422 },
      )
    }
    if (current) {
      await db.execute(sql`
        update employee_tax_certificates
           set superseded_on = ${newEffective}::date, updated_at = clock_timestamp(), updated_by = ${userId}
         where id = ${current.id} and org_id = ${orgId}`)
    }
    const inserted = (await db.execute<{ id: string; effectiveFrom: string | null }>(sql`
      insert into employee_tax_certificates
        (org_id, employee_party_id, country, certificate_key, region, sub_region,
         answers, effective_from, created_by, updated_by)
      values (${orgId}, ${body.employeePartyId}, ${country}, ${key}, ${region}, ${subRegion},
              ${JSON.stringify(answers)}::jsonb, ${newEffective}::date, ${userId}, ${userId})
      returning id, effective_from::text as "effectiveFrom"`)).rows[0]
    if (!inserted) throw new Error('certificate filing returned no row')
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
      values (${orgId}, 'employee_tax_certificates', ${inserted.id}, 'insert',
        ${JSON.stringify({
          ...(current ? { superseded: current.id } : {}),
          after: {
            employee_party_id: body.employeePartyId, country, certificate_key: key,
            region, sub_region: subRegion, answers, effective_from: inserted.effectiveFrom,
          },
        })}::jsonb,
        ${userId}, ${req.headers.get('X-Request-Id')}, clock_timestamp())`)
    return NextResponse.json({ ok: true, certificateKey: key, effectiveFrom: inserted.effectiveFrom })
  })
}
