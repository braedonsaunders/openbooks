import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../lib/api/idempotency'
import { cmp, sum } from '@openbooks/engine/src/money/money.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { PaymentError } from '@openbooks/engine/src/payments/payment-errors.ts'
import { PAYMENT_KIND_SIDE, type PaymentKind } from '@openbooks/engine/src/payments/payment-contracts.ts'
import {
  validateAllocationInputs,
  validateSettlementEvidence,
  type AllocationInput,
} from '@openbooks/engine/src/payments/settlement-policy.ts'
import { loadPaymentDocument, openItemsForParty } from '@openbooks/engine/src/payments/payment-queries.ts'
import { can, getAuthz, guardSubsidiaryScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody } from '../../../lib/api/json'
import { assertAllocationTargetsInScope, isPaymentKind, paymentErrorResponse, paymentPermission } from './lib'

export const runtime = 'nodejs'

const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: 'PAY-',
  customer_payment: 'RCPT-',
}

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

/** One open-item application — the same shape PATCH accepts, so the create
 *  path and the edit path validate identical allocations. */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  sourceTransactionAmount: exactMoney(),
  targetTransactionAmount: exactMoney(),
  targetBaseAmount: exactMoney().optional(),
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(['same_currency', 'provider', 'manual', 'contractual', 'imported']),
  settlementRateReference: z.string(),
  settlementFxRateId: nullableUuidId.optional(),
})

const paymentCreateBody = z.object({
  kind: z.enum(['vendor_payment', 'customer_payment'], {
    error: 'kind must be vendor_payment or customer_payment',
  }),
  partyId: nullableUuidId.optional(),
  bankAccountId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  allocations: z.array(allocationInput).optional(),
})

function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/**
 * Create one draft vendor payment or customer receipt with its open-item
 * applications. The kind is fixed by the entry surface (the payments list
 * creates vendor payments, the receipts list creates customer receipts) and
 * each kind gates on its own permission (ap.pay / ar.pay).
 *
 * The caller supplies a UUID idempotency key, which becomes the document ID.
 * The first write allocates the PAY-/RCPT- number inside the locked save
 * transaction and inserts exactly one document, its bank line, and one audit
 * row carrying the key as its request correlation. Retrying the exact
 * request replays the same payment (200); reusing the key for a changed
 * payload, or for a key minted in another org, is a 409 — never the older
 * payment returned as though it matched.
 *
 * This is the only first-party write path for new payments: the lists open
 * an unsaved drawer (zero writes) and this endpoint persists it exactly
 * once. The legacy draft factory stays for backward-compatible
 * integrations only.
 */
export async function POST(request: Request) {
  // Authenticate before parsing: the kind selects the permission, so no
  // schema oracle reaches an unauthenticated caller.
  const session = await getAuthz()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsedBody = await parseJsonBody(request, paymentCreateBody, { status: 422 })
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data
  if (!isPaymentKind(body.kind)) return bad('kind must be vendor_payment or customer_payment', 'kind')
  const kind: PaymentKind = body.kind

  const perm = paymentPermission(kind)
  if (!can(session, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }
  const gate = session
  const user = gate.user

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  const side = PAYMENT_KIND_SIDE[kind]
  const allocations: AllocationInput[] = body.allocations ?? []
  const partyId = body.partyId ?? null
  const bankAccountId = body.bankAccountId ?? null

  // -- party: must be an active counterparty of the right kind ----------------
  let partySubsidiaryId: string | null = null
  if (partyId) {
    const party = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select id, subsidiary_id as "subsidiaryId" from parties
       where id = ${partyId} and org_id = ${user.orgId} and is_active`)).rows[0]
    if (!party) return NextResponse.json({ error: 'party not found in this organization' }, { status: 404 })
    const roleTable = side === 'ap' ? 'vendor_roles' : 'customer_roles'
    const role = (await db.execute<{ id: string }>(sql`
      select party_id as id from ${sql.raw(roleTable)}
       where party_id = ${partyId} and org_id = ${user.orgId} and is_active`))
    if (!role.rows[0]) {
      return bad(
        side === 'ap' ? 'payment party must be an active vendor' : 'receipt party must be an active customer',
        'partyId',
      )
    }
    partySubsidiaryId = party.subsidiaryId
  }
  if (allocations.length > 0 && !partyId) {
    return bad('select a party before applying open items', 'partyId')
  }

  // -- bank account: an active bank-type account of this org -------------------
  if (bankAccountId) {
    const bank = (await db.execute<{ id: string }>(sql`
      select id from accounts
       where id = ${bankAccountId} and org_id = ${user.orgId}
         and type = 'asset_bank' and is_active and not is_summary`))
    if (!bank.rows[0]) {
      return NextResponse.json({ error: 'bank account not found in this organization' }, { status: 404 })
    }
  }

  // -- legal entity + currency --------------------------------------------------
  // The payment inherits the party's subsidiary, else the org root — the
  // same derivation the legacy draft factory used, minus the write. A
  // restricted caller outside that entity sees the tenant-opaque 404.
  let subsidiaryId: string | null = partySubsidiaryId
  if (!subsidiaryId) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${user.orgId} and parent_id is null`))
    subsidiaryId = root.rows[0]?.id ?? null
    if (!subsidiaryId) return bad('org has no root subsidiary', undefined, 500)
  }
  const denied = guardSubsidiaryScope(gate, subsidiaryId)
  if (denied) return denied
  const org = (await db.execute<{ baseCurrency: string }>(sql`
    select base_currency as "baseCurrency" from orgs where id = ${user.orgId}`)).rows[0]
  if (!org) return bad('org not found', undefined, 500)
  const currency = org.baseCurrency

  // -- allocations: real open items of this party, within open balance --------
  try {
    validateAllocationInputs(allocations)
  } catch (e) {
    return paymentErrorResponse(e)
  }
  const allocationTargetsDenied = await assertAllocationTargetsInScope(
    gate,
    allocations.map((a) => a.openLineId),
  )
  if (allocationTargetsDenied) return allocationTargetsDenied
  if (allocations.length > 0) {
    const openItems = await openItemsForParty(partyId!, side, user.orgId, new Set(subsidiaryId ? [subsidiaryId] : []))
    const byLine = new Map(openItems.map((i) => [i.lineId, i]))
    for (const a of allocations) {
      const item = byLine.get(a.openLineId)
      if (!item) return bad('an allocated item is not an open item for this party', 'allocations')
      try {
        validateSettlementEvidence(a, currency, item.currency)
      } catch (e) {
        return paymentErrorResponse(e)
      }
      if (cmp(a.targetTransactionAmount, item.transactionOpen) > 0) {
        return bad(
          `applying ${a.targetTransactionAmount} ${item.currency} exceeds the open transaction balance ${item.transactionOpen} on ${item.documentNumber ?? item.entryNumber}`,
          'allocations',
        )
      }
    }
  }

  const documentDate = body.documentDate ?? (await businessToday(user.orgId))
  const referenceNumber = trimOrNull(body.referenceNumber)
  const memo = trimOrNull(body.memo)
  // documents.total on a payment is the CASH frame by contract: the bank
  // line carries this total (same derivation as the draft edit path).
  const total = sum(allocations.map((a) => a.sourceTransactionAmount))
  const custom = { bankAccountId, allocations }
  // The replay match is the canonical request-controlled subset: the kind
  // and the caller's fields exactly as supplied. Server-derived values —
  // the defaulted date, the resolved subsidiary and currency, the derived
  // total, the allocated number — are EXCLUDED: they depend on live
  // clock/config/sequence state, so comparing them would turn a genuine
  // retry into a conflict. They still persist in the full snapshot below.
  // A null date here means "the caller omitted it", which is itself part of
  // the request identity.
  const match = {
    kind,
    partyId,
    bankAccountId,
    documentDate: body.documentDate ?? null,
    referenceNumber: body.referenceNumber ?? null,
    memo: body.memo ?? null,
    allocations: body.allocations ?? [],
  }
  // The persisted image is the full immutable create snapshot (derived
  // values included) plus the request match above, so audit evidence stays
  // complete while replay compares only what the caller controlled.
  const snapshot = {
    request: match,
    id: requestId,
    org_id: user.orgId,
    kind,
    subsidiary_id: subsidiaryId,
    document_date: documentDate,
    currency,
    party_id: partyId,
    reference_number: referenceNumber,
    memo,
    subtotal: total,
    total,
    custom,
  }

  let created = false
  try {
    created = await db.transaction(async (tx) => {
      // Serialize every request carrying this key: without the lock, two
      // concurrent identical Saves could both read no row, both allocate a
      // number, and the loser would 409 on the insert conflict instead of
      // replaying 200. The lock is keyed only — it carries no tenant read.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`)
      // Same-org claim only — never a bare by-id read: a key minted in
      // another org must not be observable here. A foreign/global UUID
      // collision surfaces below at the insert conflict, without reading it.
      const claim = await claimIdempotentCreate(tx, { orgId: user.orgId, table: 'documents', key: requestId })
      // Replay compares the immutable request image in the insert audit
      // event — not today's row, and not the derived values — so an
      // unchanged retry still succeeds after the clock/config moved under a
      // defaulted field.
      const replayMatch = { request: match }
      if (claim === 'exists') {
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId, table: 'documents', key: requestId, match: replayMatch,
        })
        if (replay !== 'replay') throw new Error('idempotency_key_conflict')
        return false
      }
      // First write for this key: the number is allocated here, inside the
      // locked save transaction — opening the drawer never consumed one.
      const documentNumber = await allocateDocumentNumber(tx, user.orgId, kind, NUMBER_PREFIX[kind])
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into documents
          (id, org_id, kind, status, subsidiary_id, document_number, document_date,
           currency, fx_rate, party_id, reference_number, memo, custom,
           subtotal, tax_total, total, created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, ${kind}, 'draft', ${subsidiaryId}, ${documentNumber},
           ${documentDate}, ${currency}, '1', ${partyId}, ${referenceNumber}, ${memo},
           ${JSON.stringify(custom)}::jsonb, ${total}, '0', ${total}, ${user.id}, ${user.id})
        on conflict (id) do nothing
        returning id`))
      if (!inserted.rows[0]) {
        // Lost insert race or foreign/global UUID collision: the re-read
        // decides — a genuine retry replays, anything else conflicts, all
        // without reading another org's row.
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId, table: 'documents', key: requestId, match: replayMatch,
        })
        if (replay !== 'replay') throw new Error('idempotency_key_conflict')
        return false
      }
      if (bankAccountId && cmp(total, '0') !== 0) {
        await tx.execute(sql`
          insert into document_lines (org_id, document_id, line_number, account_id,
                                      quantity, unit_price, amount, tax_amount)
          values (${user.orgId}, ${requestId}, 1, ${bankAccountId}, '1', ${total}, ${total}, '0')`)
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${requestId}, 'insert',
                ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
                ${user.id}, ${requestId})`)
      return true
    })
  } catch (error) {
    if (error instanceof PaymentError) return paymentErrorResponse(error)
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('idempotency_key_conflict')) return bad('invalid_idempotency_key', undefined, 409)
    throw error
  }

  const payment = await loadPaymentDocument(requestId, kind, user.orgId)
  if (!payment) return bad('save_failed', undefined, 500)
  return NextResponse.json(payment, { status: created ? 201 : 200 })
}
