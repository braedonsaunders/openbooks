import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { resolveDraftSubsidiary } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { createOrderDraft, OrderDraftError } from '../../../../lib/order-cycle'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an empty draft purchase order and return its id.
 *
 * Idempotent through the shared draft factory
 * (createOrderDraft in web/lib/order-cycle.ts): the caller's `Idempotency-Key`
 * header is a UUID that becomes the document id, so a lost-response retry
 * replays the same purchase order (200) instead of creating a second one and
 * burning a second PO number. A reused key with different
 * request-controlled details is a 409, never the older order returned as
 * though it matched.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('ap.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  // The UI contract requires a UUID key (like the canonical order create);
  // opaque keys are a v1-only shape the factory hashes, never a drawer key.
  const idempotencyKey = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(idempotencyKey)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }
  try {
    // The draft must land in a subsidiary the actor's own reads can observe:
    // a restricted caller gets their single allowed subsidiary, or a named
    // refusal — never an implicit null.
    const resolved = resolveDraftSubsidiary(gate.allowedSubsidiaryIds)
    if (!resolved.ok) throw new OrderDraftError(resolved.error)
    const doc = await createOrderDraft(
      user.orgId,
      user.id,
      'purchase_order',
      idempotencyKey,
      resolved.subsidiaryId,
    )
    return NextResponse.json({ id: doc.id, document_number: doc.document_number }, { status: doc.replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof OrderDraftError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
