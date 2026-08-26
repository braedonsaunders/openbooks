import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  InformationReturnError,
  updateFilingRecipient,
} from '@openbooks/engine/src/information-returns.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Adjust or exclude one recipient of a filing.
 *
 * This route owns NO filing logic of its own. It used to read the filing
 * status outside any transaction and then update the recipient row with an
 * unguarded WHERE, so a finalize that committed between its read and its write
 * still mutated frozen evidence. Every mutation now goes through
 * `updateFilingRecipient` — the engine's one guarded path, which locks the
 * filing row and restates the freeze in the UPDATE itself — so an edit racing
 * a finalize either commits before the freeze or is refused after it, and can
 * never land on a frozen filing.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; recipientId: string }> },
) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id, recipientId } = await params
  if (!isUuid(id) || !isUuid(recipientId)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    adjustments?: Record<string, string>
    adjustmentReason?: string | null
    status?: 'included' | 'excluded'
    exclusionReason?: string | null
  }

  try {
    await updateFilingRecipient({
      orgId,
      filingId: id,
      recipientId,
      actorId,
      adjustments: body.adjustments,
      adjustmentReason: body.adjustmentReason ?? null,
      status: body.status,
      exclusionReason: body.exclusionReason ?? null,
    })
    return NextResponse.json({ id: recipientId })
  } catch (e) {
    if (e instanceof InformationReturnError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'save failed' }, { status: 500 })
  }
}
