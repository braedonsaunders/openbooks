import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { encryptAccountNumber } from '@openbooks/engine/src/payments.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/run.ts'
import { BANK_ACCOUNT_SUBJECT_KIND } from '@openbooks/engine/src/flows/bank-accounts-adapter.ts'
import { guardPermission, guardSubsidiaryScope, type Authz } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { normalizeCountryCode } from '../../../../../lib/countries'

export const runtime = 'nodejs'

/**
 * Party bank details — the fraud-sensitive record behind the replicated
 * source platform "Vendor Bank Details Approval" workflow.
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
  expectedUpdatedAt?: string
  changeReason?: string
  retirementReason?: string
}

function validateBody(body: Body, creating: boolean): string | null {
  if (body.bankName !== undefined && !body.bankName?.trim()) return 'bankName required'
  if (creating && !body.bankName?.trim()) return 'bankName required'
  if (body.country && !normalizeCountryCode(body.country)) return 'country must be a valid ISO country code'
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

/** Party record boundary shared by every verb here (null-subsidiary parties are org-wide). */
async function denyOutsidePartyScope(gate: Authz, partyId: string): Promise<NextResponse | null> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${gate.user.orgId}`,
  ))
  if (!row.rows[0]) return NextResponse.json({ error: 'party not found' }, { status: 404 })
  return guardSubsidiaryScope(gate, row.rows[0].subsidiaryId, { orgWideNull: true })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id: partyId } = await params
  if (!isUuid(partyId)) return NextResponse.json({ error: 'bad party id' }, { status: 400 })

  const scopeDenied = await denyOutsidePartyScope(gate, partyId)
  if (scopeDenied) return scopeDenied

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  // Party bank-account currency is Multi-currency configuration. Turning that
  // switch off must refuse a new write; omitting currency keeps the create
  // path and stored accounts with a null currency.
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(user.orgId, 'multiCurrency'))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const validationError = validateBody(body, true)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
  const accountNumber = (body.accountNumber ?? '').trim()
  if (!accountNumber || accountNumber.length < 4) {
    return NextResponse.json({ error: 'accountNumber required' }, { status: 400 })
  }
  const country = normalizeCountryCode(body.country) ?? null

  const inserted = (await db.execute<{ id: string }>(sql`
    insert into party_bank_accounts
      (org_id, party_id, bank_name, country, currency, routing,
       account_number_encrypted, account_last_four, approval_status, is_active,
       approved_at, approved_by, submitted_by, submitted_at, created_by)
    values (${user.orgId}, ${partyId}, ${body.bankName?.trim() ?? null}, ${country},
            ${body.currency !== undefined ? (body.currency?.trim().toUpperCase() || null) : null}, ${JSON.stringify(body.routing ?? {})}::jsonb,
            ${encryptAccountNumber(accountNumber)}, ${accountNumber.slice(-4)},
            'pending', false, null, null, ${user.id}, now(), ${user.id})
    returning id
  `))
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
  const partyDenied = await denyOutsidePartyScope(gate, partyId)
  if (partyDenied) return partyDenied
  const existing = (await db.execute<{ approvalStatus: string; updatedAt: Date }>(sql`
    select approval_status as "approvalStatus", updated_at as "updatedAt"
      from party_bank_accounts
     where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
  `))
  if (existing.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Body
  // Party bank-account currency is Multi-currency configuration. Turning that
  // switch off must refuse a currency write; omitting currency keeps the
  // stored account.
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(user.orgId, 'multiCurrency'))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const validationError = validateBody(body, false)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
  const changedFields = MATERIAL_COLUMNS.filter((k) => body[k as keyof Body] !== undefined)
  if (changedFields.length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  const reason = body.changeReason?.trim() ?? ''
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: 'a change reason between 5 and 500 characters is required' }, { status: 422 })
  }
  if (!body.expectedUpdatedAt || new Date(body.expectedUpdatedAt).getTime() !== new Date(existing.rows[0]!.updatedAt).getTime()) {
    return NextResponse.json(
      { error: 'these bank details changed after you opened them; reload and review the latest revision' },
      { status: 409 },
    )
  }
  // A material edit re-enters approval (below), so it must never mutate the
  // evidence an in-flight payment instruction was approved against: those
  // instructions keep paying exactly what their file generation locked, but a
  // fresh edit here would leave them pointing at unapproved details. Refuse at
  // the mutation boundary — same dependency rule as retirement (DELETE).
  const dependencies = (await db.execute<{ inFlightPayment: boolean }>(sql`
    select exists (
      select 1
        from payment_instructions instruction
       where instruction.org_id = ${user.orgId}
         and instruction.payee_bank_account_id = ${accountId}
         and instruction.status in ('pending', 'approved', 'generated', 'sent')
    ) as "inFlightPayment"
  `))
  if (dependencies.rows[0]?.inFlightPayment) {
    return NextResponse.json(
      { error: 'cancel in-flight payment instructions referencing these bank details before editing them' },
      { status: 422 },
    )
  }

  const accountNumber = body.accountNumber?.trim()
  const country = body.country === undefined ? undefined : normalizeCountryCode(body.country)
  // Any material edit re-enters approval: pending + inactive + approval
  // cleared (the source platform workflow's @OLDRECORD@ comparison, done natively).
  const updated = (await db.execute<{ id: string }>(sql`
    update party_bank_accounts set
      bank_name = ${body.bankName !== undefined ? body.bankName?.trim() || null : sql`bank_name`},
      country = ${body.country !== undefined ? country : sql`country`},
      currency = ${body.currency !== undefined ? body.currency?.trim().toUpperCase() || null : sql`currency`},
      routing = ${body.routing !== undefined ? sql`${JSON.stringify(body.routing)}::jsonb` : sql`routing`},
      account_number_encrypted = ${accountNumber ? encryptAccountNumber(accountNumber) : sql`account_number_encrypted`},
      account_last_four = ${accountNumber ? accountNumber.slice(-4) : sql`account_last_four`},
      approval_status = 'pending', is_active = false, approved_at = null, approved_by = null,
      submitted_by = ${user.id}, submitted_at = now(),
      updated_at = now(), updated_by = ${user.id}
    where id = ${accountId}
      and party_id = ${partyId}
      and org_id = ${user.orgId}
      and updated_at = ${existing.rows[0]!.updatedAt}
      and retired_at is null
    returning id
  `))
  if (!updated.rows[0]) {
    return NextResponse.json(
      { error: 'these bank details changed or were retired; reload and review the latest revision' },
      { status: 409 },
    )
  }
  const cancelledRuns = (await db.execute<{ run_id: string }>(sql`
    update flow_gates
       set status = 'cancelled', updated_at = now()
     where org_id = ${user.orgId}
       and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
       and subject_id = ${accountId}
       and status in ('pending', 'escalated')
     returning run_id
  `))
  const runIds = [...new Set(cancelledRuns.rows.map((row) => row.run_id))]
  if (runIds.length > 0) {
    await db.execute(sql`
      update flow_runs
         set status = 'completed',
             error = null,
             finished_at = now()
       where id = any(${`{${runIds.join(',')}}`}::uuid[])
         and org_id = ${user.orgId}
         and status = 'waiting'
    `)
  }
  await db.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
      ${JSON.stringify({
        mode: 'bank_detail_material_change',
        reason,
        changedFields,
        approvalStatus: 'pending',
      })}::jsonb,
      ${user.id}, 'ui'
    )
  `)

  await runRecordFlows(
    { kind: 'on_update', source: 'ui', changedFields },
    BANK_ACCOUNT_SUBJECT_KIND,
    accountId,
    { orgId: user.orgId, userId: user.id },
  )
  return NextResponse.json({ id: accountId, approvalStatus: 'pending', changedFields })
}

/** Retire approved or rejected bank details without destroying fraud evidence. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id: partyId } = await params
  const accountId = new URL(req.url).searchParams.get('accountId') ?? ''
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: 'bad ids' }, { status: 400 })
  }
  const partyDenied = await denyOutsidePartyScope(gate, partyId)
  if (partyDenied) return partyDenied
  const parsedBody3 = await parseJsonBody(req, jsonObject);
  if (!parsedBody3.ok) return parsedBody3.response;
  const body = (parsedBody3.data) as Body
  const reason = body.retirementReason?.trim() ?? ''
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: 'a retirement reason between 5 and 500 characters is required' }, { status: 422 })
  }
  if (!body.expectedUpdatedAt) {
    return NextResponse.json({ error: 'the bank-detail revision is required; reload and try again' }, { status: 409 })
  }
  const dependencies = (await db.execute<{ in_flight_payment: boolean; live_mandate: boolean }>(sql`
    select
      exists (
        select 1
          from payment_instructions instruction
         where instruction.org_id = ${user.orgId}
           and instruction.payee_bank_account_id = ${accountId}
           and instruction.status in ('pending', 'approved', 'generated', 'sent')
      ) as in_flight_payment,
      exists (
        select 1
          from payment_mandates mandate
         where mandate.org_id = ${user.orgId}
           and mandate.party_bank_account_id = ${accountId}
           and mandate.status in ('pending', 'active', 'suspended')
      ) as live_mandate
  `))
  if (dependencies.rows[0]?.in_flight_payment || dependencies.rows[0]?.live_mandate) {
    return NextResponse.json(
      { error: 'cancel in-flight payment instructions and revoke live mandates before retiring these bank details' },
      { status: 422 },
    )
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update party_bank_accounts
       set is_active = false,
           retired_at = now(),
           retired_by = ${user.id},
           retirement_reason = ${reason},
           updated_at = now(),
           updated_by = ${user.id}
     where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
       and retired_at is null
       and updated_at = ${body.expectedUpdatedAt}
     returning id
  `))
  if (!updated.rows[0]) {
    return NextResponse.json(
      { error: 'these bank details changed or were already retired; reload and review the latest revision' },
      { status: 409 },
    )
  }
  await db.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
      ${JSON.stringify({ mode: 'bank_detail_retired', reason })}::jsonb,
      ${user.id}, 'ui'
    )
  `)
  return NextResponse.json({ ok: true })
}
