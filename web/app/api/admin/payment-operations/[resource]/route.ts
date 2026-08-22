import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import {
  createPaymentBankProfile,
  type PaymentBankProfileInput,
} from '@openbooks/engine/src/payment-operations.ts'
import { computeNextRunAt } from '@openbooks/engine/src/scripting.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { normalizeCountryCode } from '../../../../../lib/countries'

export const runtime = 'nodejs'

const RESOURCES = new Set(['formats', 'profiles', 'schedules', 'mandates'])

export async function GET(_req: Request, { params }: { params: Promise<{ resource: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { resource } = await params
  if (!RESOURCES.has(resource)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (resource === 'formats') {
    const rows = await db.execute(sql`
      select id, code, name, rail, direction, country, currency, file_extension,
             content_type, formatter_script is not null as has_formatter, is_active
        from payment_formats where org_id = ${gate.user.orgId} order by is_active desc, name
    `)
    return NextResponse.json({ rows: rows.rows })
  }
  if (resource === 'profiles') {
    const rows = await db.execute(sql`
      select p.id, p.name, p.bank_account_id, p.subsidiary_id, p.payment_format_id,
             p.currency, p.country, p.settings, p.sftp_server_id, p.sftp_folder,
             p.require_run_approval, p.require_file_approval, p.auto_remittance,
             p.originator_secrets_encrypted is not null as has_secrets, p.is_active,
             f.name as format_name, f.rail, a.number as bank_number, a.name as bank_name
        from payment_bank_profiles p
        join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
        join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
       where p.org_id = ${gate.user.orgId} order by p.is_active desc, p.name
    `)
    return NextResponse.json({ rows: rows.rows })
  }
  if (resource === 'schedules') {
    const rows = await db.execute(sql`
      select s.*, p.name as profile_name
        from payment_schedules s join payment_bank_profiles p on p.id = s.payment_bank_profile_id and p.org_id = s.org_id
       where s.org_id = ${gate.user.orgId} order by s.is_active desc, s.name
    `)
    return NextResponse.json({ rows: rows.rows })
  }
  const rows = await db.execute(sql`
    select m.*, p.display_name as party_name, b.bank_name, b.account_last_four
      from payment_mandates m
      join parties p on p.id = m.party_id and p.org_id = m.org_id
      join party_bank_accounts b on b.id = m.party_bank_account_id and b.org_id = m.org_id
     where m.org_id = ${gate.user.orgId} order by m.created_at desc
  `)
  return NextResponse.json({ rows: rows.rows })
}

export async function POST(req: Request, { params }: { params: Promise<{ resource: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { resource } = await params
  if (!RESOURCES.has(resource)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, any>
  try {
    if (resource === 'formats') {
      // Format currency is Multi-currency configuration. Turning that
      // switch off must refuse a new write; omitting currency keeps
      // stored formats and a null restriction.
      if (
        body.currency !== undefined &&
        !(await isFeatureEnabled(gate.user.orgId, 'multiCurrency'))
      ) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      if (!body.code?.trim() || !body.name?.trim() || !body.formatterScript?.trim()) {
        return NextResponse.json({ error: 'code, name, and formatterScript are required' }, { status: 400 })
      }
      const country = optionalCountry(body.country)
      if (country === undefined) return NextResponse.json({ error: 'country must be a valid ISO country code' }, { status: 400 })
      const [row] = await db.insert(schema.paymentFormats).values({
        orgId: gate.user.orgId,
        code: body.code.trim().toUpperCase(),
        name: body.name.trim(),
        rail: 'custom',
        direction: body.direction === 'debit' || body.direction === 'both' ? body.direction : 'credit',
        country,
        currency: body.currency !== undefined ? (body.currency?.trim().toUpperCase() || null) : null,
        fileExtension: body.fileExtension?.trim().replace(/^\./, '') || 'txt',
        contentType: body.contentType?.trim() || 'text/plain; charset=utf-8',
        formatterScript: body.formatterScript,
        settings: body.settings ?? {},
        isActive: body.isActive !== false,
        createdBy: gate.user.id,
        updatedBy: gate.user.id,
      }).returning({ id: schema.paymentFormats.id })
      return NextResponse.json(row, { status: 201 })
    }
    if (resource === 'profiles') {
      // Profile currency is Multi-currency configuration. Turning that
      // switch off must refuse a new write; omitting currency keeps the
      // format / subsidiary / org fallback so a profile can still be created.
      if (
        body.currency !== undefined &&
        !(await isFeatureEnabled(gate.user.orgId, 'multiCurrency'))
      ) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      const country = optionalCountry(body.country)
      if (country === undefined) return NextResponse.json({ error: 'country must be a valid ISO country code' }, { status: 400 })
      body.country = country
      if (!body.name || !isUuid(body.bankAccountId) || !isUuid(body.paymentFormatId)) {
        return NextResponse.json({ error: 'name, bankAccountId, and paymentFormatId are required' }, { status: 400 })
      }
      let currency =
        body.currency !== undefined ? String(body.currency).trim().toUpperCase() : ''
      if (body.currency === undefined) {
        const fallback = (await db.execute<{ currency: string | null }>(sql`
          select coalesce(nullif(f.currency, ''), s.base_currency, o.base_currency) as currency
            from orgs o
            left join payment_formats f on f.id = ${body.paymentFormatId} and f.org_id = o.id
            left join subsidiaries s on s.id = ${body.subsidiaryId ?? null} and s.org_id = o.id
           where o.id = ${gate.user.orgId}`))
        currency = fallback.rows[0]?.currency ?? ''
      }
      if (!/^[A-Z]{3}$/.test(currency)) {
        return NextResponse.json({ error: 'name, bankAccountId, paymentFormatId, and currency are required' }, { status: 400 })
      }
      const input = { ...body, currency } as unknown as PaymentBankProfileInput
      const row = await createPaymentBankProfile(gate.user.orgId, gate.user.id, input)
      return NextResponse.json(row, { status: 201 })
    }
    if (resource === 'schedules') {
      if (!body.name?.trim() || !isUuid(body.paymentBankProfileId) || !body.cron?.trim()) {
        return NextResponse.json({ error: 'name, paymentBankProfileId, and cron are required' }, { status: 400 })
      }
      const nextRunAt = computeNextRunAt(body.cron.trim(), new Date(), body.timezone?.trim() || 'UTC')
      if (!nextRunAt) return NextResponse.json({ error: 'cron expression is invalid' }, { status: 400 })
      const profile = (await db.execute(sql`select 1 from payment_bank_profiles p join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id where p.id = ${body.paymentBankProfileId} and p.org_id = ${gate.user.orgId} and p.is_active and f.direction <> 'debit'`))
      if (!profile.rows[0]) return NextResponse.json({ error: 'payment profile is invalid or inactive' }, { status: 400 })
      const [row] = await db.insert(schema.paymentSchedules).values({
        orgId: gate.user.orgId,
        name: body.name.trim(),
        paymentBankProfileId: body.paymentBankProfileId,
        cron: body.cron.trim(),
        timezone: body.timezone?.trim() || 'UTC',
        selectionCriteria: body.selectionCriteria ?? {},
        action: body.action === 'submit_for_approval' ? 'submit_for_approval' : 'create_draft',
        nextRunAt,
        isActive: body.isActive !== false,
        createdBy: gate.user.id,
        updatedBy: gate.user.id,
      }).returning({ id: schema.paymentSchedules.id })
      return NextResponse.json(row, { status: 201 })
    }
    if (!isUuid(body.partyId) || !isUuid(body.partyBankAccountId) || !body.mandateReference?.trim()) {
      return NextResponse.json({ error: 'partyId, partyBankAccountId, and mandateReference are required' }, { status: 400 })
    }
    const mandateBank = (await db.execute(sql`
      select 1 from party_bank_accounts b join parties p on p.id = b.party_id and p.org_id = b.org_id
       where b.id = ${body.partyBankAccountId} and b.party_id = ${body.partyId}
         and p.org_id = ${gate.user.orgId} and p.is_active and b.is_active and b.approved_at is not null
    `))
    if (!mandateBank.rows[0]) return NextResponse.json({ error: 'approved counterparty bank account is invalid' }, { status: 400 })
    const [row] = await db.insert(schema.paymentMandates).values({
      orgId: gate.user.orgId,
      partyId: body.partyId,
      partyBankAccountId: body.partyBankAccountId,
      scheme: ['nacha', 'sepa_core', 'sepa_b2b', 'custom'].includes(body.scheme) ? body.scheme : 'custom',
      mandateReference: body.mandateReference.trim(),
      status: ['pending', 'active', 'suspended', 'revoked', 'expired'].includes(body.status) ? body.status : 'pending',
      signedOn: body.signedOn || null,
      validFrom: body.validFrom || null,
      expiresOn: body.expiresOn || null,
      proofFileId: isUuid(body.proofFileId) ? body.proofFileId : null,
      createdBy: gate.user.id,
      updatedBy: gate.user.id,
    }).returning({ id: schema.paymentMandates.id })
    return NextResponse.json(row, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}

function optionalCountry(value: unknown): string | null | undefined {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  return normalizeCountryCode(value) ?? undefined
}
