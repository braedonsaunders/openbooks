import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { encryptAccountNumber } from '@openbooks/engine/src/payments.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/run.ts'
import { BANK_ACCOUNT_SUBJECT_KIND } from '@openbooks/engine/src/flows/bank-accounts-adapter.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Party bank details — the fraud-sensitive record behind the replicated
 * NetSuite "Vendor Bank Details Approval" workflow.
 *
 * Every create lands PENDING (inactive, invisible to payment runs — see
 * payments.ts's `is_active AND approved_at IS NOT NULL` selection); a
 * material-field edit resets an approved row back to pending. Approval flows
 * on subject kind 'party_bank_account' route the gate; without an enabled
 * flow the row simply stays pending until an admin flow approves it (there is
 * deliberately NO auto-approve fallback for bank details).
 */

const MATERIAL_COLUMNS = ['bankName', 'country', 'currency', 'routing', 'accountNumber'] as const

type Body = {
  bankName?: string | null
  country?: string | null
  currency?: string | null
  routing?: Record<string, string>
  /** Plaintext on input only — stored envelope-encrypted with a last-four echo. */
  accountNumber?: string
}

function validateBody(body: Body, creating: boolean): string | null {
  if (body.bankName !== undefined && !body.bankName?.trim()) return 'bankName required'
  if (creating && !body.bankName?.trim()) return 'bankName required'
  if (body.currency && !/^[A-Za-z]{3}$/.test(body.currency.trim())) return 'currency must be a 3-letter code'
  if (body.routing !== undefined) {
    if (!body.routing || Array.isArray(body.routing) || typeof body.routing !== 'object') return 'routing must be an object'
    const entries = Object.entries(body.routing)
    if (entries.length > 20 || entries.some(([key, value]) => key.length > 50 || typeof value !== 'string' || value.length > 100)) {
      return 'routing details are too large'
    }
  }
  return null
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id: partyId } = await params
  if (!isUuid(partyId)) return NextResponse.json({ error: 'bad party id' }, { status: 400 })

  const owned = (await db.execute(
    sql`select 1 from parties where id = ${partyId} and org_id = ${user.orgId}`,
  )) as unknown as { rows: unknown[] }
  if (owned.rows.length === 0) return NextResponse.json({ error: 'party not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Body
  const validationError = validateBody(body, true)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
  const accountNumber = (body.accountNumber ?? '').trim()
  if (!accountNumber || accountNumber.length < 4) {
    return NextResponse.json({ error: 'accountNumber required' }, { status: 400 })
  }

  const inserted = (await db.execute(sql`
    insert into party_bank_accounts
      (org_id, party_id, bank_name, country, currency, routing,
       account_number_encrypted, account_last_four, approval_status, is_active,
       approved_at, approved_by, created_by)
    values (${user.orgId}, ${partyId}, ${body.bankName?.trim() ?? null}, ${body.country?.trim() || null},
            ${body.currency?.trim().toUpperCase() || null}, ${JSON.stringify(body.routing ?? {})}::jsonb,
            ${encryptAccountNumber(accountNumber)}, ${accountNumber.slice(-4)},
            'pending', false, null, null, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  const accountId = inserted.rows[0]!.id

  await runRecordFlows(
    { kind: 'on_create', source: 'ui' },
    BANK_ACCOUNT_SUBJECT_KIND,
    accountId,
    { orgId: user.orgId, userId: user.id },
  )
  return NextResponse.json({ id: accountId, approvalStatus: 'pending' }, { status: 201 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id: partyId } = await params

  const url = new URL(req.url)
  const accountId = url.searchParams.get('accountId') ?? ''
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: 'bad ids' }, { status: 400 })
  }
  const existing = (await db.execute(sql`
    select approval_status as "approvalStatus" from party_bank_accounts
     where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
  `)) as unknown as { rows: { approvalStatus: string }[] }
  if (existing.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Body
  const validationError = validateBody(body, false)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
  const changedFields = MATERIAL_COLUMNS.filter((k) => body[k as keyof Body] !== undefined)
  if (changedFields.length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const accountNumber = body.accountNumber?.trim()
  // Any material edit re-enters approval: pending + inactive + approval
  // cleared (the NetSuite workflow's @OLDRECORD@ comparison, done natively).
  await db.execute(sql`
    update party_bank_accounts set
      bank_name = ${body.bankName !== undefined ? body.bankName?.trim() || null : sql`bank_name`},
      country = ${body.country !== undefined ? body.country?.trim() || null : sql`country`},
      currency = ${body.currency !== undefined ? body.currency?.trim().toUpperCase() || null : sql`currency`},
      routing = ${body.routing !== undefined ? sql`${JSON.stringify(body.routing)}::jsonb` : sql`routing`},
      account_number_encrypted = ${accountNumber ? encryptAccountNumber(accountNumber) : sql`account_number_encrypted`},
      account_last_four = ${accountNumber ? accountNumber.slice(-4) : sql`account_last_four`},
      approval_status = 'pending', is_active = false, approved_at = null, approved_by = null,
      updated_at = now(), updated_by = ${user.id}
    where id = ${accountId}
  `)

  await runRecordFlows(
    { kind: 'on_update', source: 'ui', changedFields },
    BANK_ACCOUNT_SUBJECT_KIND,
    accountId,
    { orgId: user.orgId, userId: user.id },
  )
  return NextResponse.json({ id: accountId, approvalStatus: 'pending', changedFields })
}
