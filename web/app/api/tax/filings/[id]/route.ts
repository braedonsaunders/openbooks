import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { TaxFilingError, markTaxFilingFiled } from '@openbooks/engine/src/tax-filing.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Record the one-way prepared → filed transition and government reference. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { filingReference?: unknown }
  const filingReference = typeof body.filingReference === 'string' ? body.filingReference.trim() : ''
  if (filingReference.length > 200) return NextResponse.json({ error: 'reference is too long' }, { status: 422 })

  try {
    const updated = await markTaxFilingFiled(gate.user.orgId, id, gate.user.id, filingReference || null)
    return NextResponse.json({ id: updated.id, filed_at: updated.filedAt })
  } catch (error) {
    if (error instanceof TaxFilingError) {
      if (error.code === 'not-found') return NextResponse.json({ error: 'not found' }, { status: 404 })
      if (error.code === 'already-filed') return NextResponse.json({ error: 'filing is already filed' }, { status: 409 })
      // Stale or ungoverned: the state conflicts with what would be certified.
      if (error.code === 'stale' || error.code === 'period-not-closed') {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
    }
    return NextResponse.json({ error: 'could not update filing' }, { status: 422 })
  }
}
