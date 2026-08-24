import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from '../../../../lib/documents'
import {
  addTicketLine,
  FieldTicketError,
  loadFieldTicket,
  removeTicketLine,
  saveCrewGrid,
  submitFieldTicket,
  updateTicketHeader,
} from '../../../../lib/field-tickets'
import { sendTicketForSignature } from '../../../../lib/field-ticket-signing'

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function fail(e: unknown) {
  const status = e instanceof DocumentEditError ? e.status : e instanceof FieldTicketError ? 422 : 500
  return NextResponse.json({ error: (e as Error).message }, { status })
}

/**
 * Full-state ticket mutations are fenced by the ticket's exact revision: the
 * caller echoes the `revision` token it loaded, and a stale or missing token
 * is rejected with 409 instead of silently overwriting a competing save.
 */
function requireRevision(value: unknown): string | NextResponse {
  try {
    return requireDocumentEditRevision(value)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const expectedRevision = requireRevision(body.expectedRevision)
  if (expectedRevision instanceof NextResponse) return expectedRevision
  try {
    await updateTicketHeader(gate.user.orgId, gate.user.id, id, {
      ...(('projectId' in body) ? { projectId: isUuid(body.projectId) ? body.projectId : null } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(body.documentDate ?? '') ? { documentDate: body.documentDate } : {}),
      ...(('referenceNumber' in body) ? { referenceNumber: body.referenceNumber ? String(body.referenceNumber).slice(0, 100) : null } : {}),
      ...(('memo' in body) ? { memo: body.memo ? String(body.memo).slice(0, 2000) : null } : {}),
      ...(['shift', 'daily', 'weekly'].includes(body.period) ? { period: body.period } : {}),
      ...(('foremanPartyId' in body) ? { foremanPartyId: isUuid(body.foremanPartyId) ? body.foremanPartyId : null } : {}),
    }, expectedRevision)
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id))
  } catch (e) {
    return fail(e)
  }
}

/** Ticket drafting/submission actions. Approval decisions live only in Flows. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = parsedBody2.data
  const action = String(body.action ?? '')

  const gate = await guardPermission('time.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    if (action === 'save-grid') {
      const expectedRevision = requireRevision(body.expectedRevision)
      if (expectedRevision instanceof NextResponse) return expectedRevision
      await saveCrewGrid(orgId, userId, id, Array.isArray(body.rows) ? body.rows : [], expectedRevision)
    } else if (action === 'patch') {
      const expectedRevision = requireRevision(body.expectedRevision)
      if (expectedRevision instanceof NextResponse) return expectedRevision
      await updateTicketHeader(orgId, userId, id, {
        ...(('workDescription' in body)
          ? { memo: body.workDescription ? String(body.workDescription).slice(0, 2000) : null }
          : {}),
        ...(('poNumber' in body)
          ? { referenceNumber: body.poNumber ? String(body.poNumber).slice(0, 100) : null }
          : {}),
        ...(('foremanPartyId' in body)
          ? { foremanPartyId: isUuid(body.foremanPartyId) ? body.foremanPartyId : null }
          : {}),
      }, expectedRevision)
    } else if (action === 'add-line') {
      const equipmentUnitId = isUuid(body.equipmentUnitId) ? body.equipmentUnitId : null
      if (equipmentUnitId && !(await isFeatureEnabled(orgId, 'equipment'))) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      if (isUuid(body.itemId) && !(await isFeatureEnabled(orgId, 'equipment'))) {
        const item = (await db.execute<{ kind: string }>(sql`
          select kind from items where id = ${body.itemId} and org_id = ${orgId}`))
        if (item.rows[0]?.kind === 'equipment_charge') {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
      }
      if (isUuid(body.itemId) && !(await isFeatureEnabled(orgId, 'inventory'))) {
        const item = (await db.execute<{ kind: string }>(sql`
          select kind from items where id = ${body.itemId} and org_id = ${orgId}`))
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
      }
      await addTicketLine(orgId, userId, id, {
        itemId: body.itemId,
        quantity: body.quantity,
        rateUnitCode: typeof body.rateUnitCode === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.rateUnitCode)
          ? body.rateUnitCode
          : null,
        equipmentUnitId,
        employeeId: isUuid(body.employeeId) ? body.employeeId : null,
        description: body.description ?? null,
      })
    } else if (action === 'remove-line') {
      if (!isUuid(body.lineId)) return NextResponse.json({ error: 'invalid lineId' }, { status: 422 })
      await removeTicketLine(orgId, id, body.lineId)
    } else if (action === 'submit') {
      await submitFieldTicket(orgId, userId, id)
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
