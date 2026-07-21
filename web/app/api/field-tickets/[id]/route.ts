import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  addTicketLine,
  approveFieldTicket,
  FieldTicketError,
  loadFieldTicket,
  patchTicketCustom,
  rejectFieldTicket,
  removeTicketLine,
  saveCrewGrid,
  submitFieldTicket,
  updateTicketHeader,
} from '../../../../lib/field-tickets'
import { sendTicketForSignature } from '../../../../lib/field-ticket-signing'

export const runtime = 'nodejs'

function fail(e: unknown) {
  const status = e instanceof FieldTicketError ? 422 : 500
  return NextResponse.json({ error: (e as Error).message }, { status })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('time.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await isFeatureEnabled(gate.user.orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id))
  } catch (e) {
    return fail(e)
  }
}

/** Standard-form header save (project/date/PO/memo/period/foreman). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('time.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await isFeatureEnabled(gate.user.orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  try {
    await updateTicketHeader(gate.user.orgId, gate.user.id, id, {
      ...(('projectId' in body) ? { projectId: isUuid(body.projectId) ? body.projectId : null } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(body.documentDate ?? '') ? { documentDate: body.documentDate } : {}),
      ...(('referenceNumber' in body) ? { referenceNumber: body.referenceNumber ? String(body.referenceNumber).slice(0, 100) : null } : {}),
      ...(('memo' in body) ? { memo: body.memo ? String(body.memo).slice(0, 2000) : null } : {}),
      ...(['shift', 'daily', 'weekly'].includes(body.period) ? { period: body.period } : {}),
      ...(('foremanPartyId' in body) ? { foremanPartyId: isUuid(body.foremanPartyId) ? body.foremanPartyId : null } : {}),
    })
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id))
  } catch (e) {
    return fail(e)
  }
}

/**
 * Ticket actions. Editing needs time.manage; approve/reject need time.approve
 * (the same split as personal timesheets).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  const permission = action === 'approve' || action === 'reject' ? 'time.approve' : 'time.manage'
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    if (action === 'save-grid') {
      await saveCrewGrid(orgId, userId, id, Array.isArray(body.rows) ? body.rows : [])
    } else if (action === 'patch') {
      const patch: Record<string, unknown> = {}
      if ('workDescription' in body) patch.workDescription = body.workDescription ? String(body.workDescription).slice(0, 2000) : null
      if ('poNumber' in body) patch.poNumber = body.poNumber ? String(body.poNumber).slice(0, 100) : null
      if ('foremanPartyId' in body) patch.foremanPartyId = isUuid(body.foremanPartyId) ? body.foremanPartyId : null
      await patchTicketCustom(orgId, id, patch)
    } else if (action === 'add-line') {
      await addTicketLine(orgId, userId, id, {
        itemId: body.itemId,
        quantity: Number(body.quantity),
        description: body.description ?? null,
        billRate: body.billRate != null && body.billRate !== '' ? Number(body.billRate) : null,
      })
    } else if (action === 'remove-line') {
      if (!isUuid(body.lineId)) return NextResponse.json({ error: 'invalid lineId' }, { status: 422 })
      await removeTicketLine(orgId, id, body.lineId)
    } else if (action === 'submit') {
      await submitFieldTicket(orgId, userId, id)
    } else if (action === 'approve') {
      await approveFieldTicket(orgId, userId, id)
    } else if (action === 'reject') {
      await rejectFieldTicket(orgId, userId, id, String(body.reason ?? ''))
    } else if (action === 'send-signature') {
      const base = process.env.OPENBOOKS_APP_URL || new URL(req.url).origin
      await sendTicketForSignature({
        orgId,
        userId,
        ticketId: id,
        to: String(body.to ?? ''),
        message: body.message ? String(body.message).slice(0, 1000) : null,
        appBaseUrl: base,
      })
    } else {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
    return NextResponse.json(await loadFieldTicket(orgId, id))
  } catch (e) {
    return fail(e)
  }
}
