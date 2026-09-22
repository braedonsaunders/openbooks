import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  applyStandaloneCredits,
  creditSettlementState,
  unapplyCreditSettlement,
} from '@openbooks/engine/src/payments/credit-settlement.ts'
import { exactMoney, isoDate, parseJsonBody, uuidId } from '@/lib/api/json'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

/**
 * Settle a posted credit memo against posted open items with NO cash.
 *
 * A credit that fully covers an invoice had no workflow at all: posting a
 * payment refuses zero cash allocations, so the balance stayed open on both
 * documents. This is the cash-free path — it writes the same `applications`
 * ledger a receipt writes and posts no journal entry, because netting two open
 * items on one control account moves no money.
 */

const applyBody = z.object({
  partyId: uuidId,
  side: z.enum(['ap', 'ar']),
  appliedOn: isoDate(),
  credits: z
    .array(
      z.object({
        fromLineId: uuidId,
        toLineId: uuidId,
        amount: exactMoney(),
        sourceDocumentId: uuidId,
      }),
    )
    .min(1, 'select at least one credit to apply'),
})

// The caller states which side it is releasing so the permission can be
// resolved before any tenant read. The settlement's ACTUAL side is checked
// against it below, inside the org scope — otherwise an AR-only user could
// name 'ar' and release an AP credit.
const releaseBody = z.object({ applicationId: uuidId, side: z.enum(['ap', 'ar']) })

async function guardParty(
  gate: Exclude<Awaited<ReturnType<typeof guardPermission>>, NextResponse>,
  partyId: string,
): Promise<NextResponse | null> {
  const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${gate.user.orgId}
  `))
  if (!party.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Null-subsidiary parties are org-wide, like every other party reader here.
  return guardSubsidiaryScope(gate, party.rows[0].subsidiaryId, { orgWideNull: true })
}

/**
 * What a posted credit has settled and what is left to apply. The panel reads
 * this so its remaining figure and the engine's open-balance check come from
 * the same rows.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const side = url.searchParams.get('side')
  if (side !== 'ap' && side !== 'ar') {
    return NextResponse.json({ error: 'side must be ap or ar' }, { status: 400 })
  }
  const documentId = url.searchParams.get('documentId') ?? ''
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  }
  const gate = await guardPermission(side === 'ap' ? 'ap.read' : 'ar.read')
  if (gate instanceof NextResponse) return gate
  // Bind the document to the side it claims before reading its settlements:
  // an AR reader must not learn what a vendor credit paid.
  const doc = (await db.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from documents
     where id = ${documentId} and org_id = ${gate.user.orgId}
       and kind = ${side === 'ap' ? 'vendor_credit' : 'customer_credit'}
  `))
  if (!doc.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (doc.rows[0].partyId) {
    const denied = await guardParty(gate, doc.rows[0].partyId)
    if (denied) return denied
  }
  return NextResponse.json({ state: await creditSettlementState(gate.user.orgId, documentId) })
}

export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, applyBody)
  if (!parsed.ok) return parsed.response
  const { partyId, side, appliedOn, credits } = parsed.data
  const gate = await guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate
  const denied = await guardParty(gate, partyId)
  if (denied) return denied
  try {
    const result = await applyStandaloneCredits(gate.user.orgId, gate.user.id, {
      partyId,
      side,
      appliedOn,
      credits,
    })
    return NextResponse.json(result)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

/**
 * Release a live credit settlement, reopening both balances. This is the arm
 * behind the void refusal "unapply them before voiding"; cash applications are
 * refused by name and pointed at the void that owns their evidence.
 */
export async function DELETE(req: Request) {
  const parsed = await parseJsonBody(req, releaseBody)
  if (!parsed.ok) return parsed.response
  const { applicationId, side } = parsed.data
  const gate = await guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate

  // Now inside the caller's org: confirm the settlement really is the side the
  // caller was gated on, and that its party is in scope. A mismatch is the
  // tenant-opaque 404 every other id lookup here returns — naming the other
  // side's kind would itself disclose it.
  const settlement = (await db.execute<{ kind: string | null; partyId: string | null }>(sql`
    select credit.kind, credit.party_id as "partyId"
      from applications a
      join journal_lines jl on jl.id = a.from_line_id and jl.org_id = a.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = a.org_id
      left join documents credit
        on credit.id = je.source_document_id and credit.org_id = a.org_id
     where a.id = ${applicationId} and a.org_id = ${gate.user.orgId}
  `))
  const row = settlement.rows[0]
  const actualSide = row?.kind === 'vendor_credit' ? 'ap' : row?.kind === 'customer_credit' ? 'ar' : null
  if (!row || actualSide !== side) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (row.partyId) {
    const denied = await guardParty(gate, row.partyId)
    if (denied) return denied
  }
  try {
    const result = await unapplyCreditSettlement(
      gate.user.orgId,
      gate.user.id,
      applicationId,
    )
    return NextResponse.json(result)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
