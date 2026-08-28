import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from '../../../../lib/documents'
import {
  addTicketLine,
  FieldTicketError,
  FieldTicketNotFoundError,
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
  const status = e instanceof DocumentEditError ? e.status : e instanceof FieldTicketNotFoundError ? 404 : e instanceof FieldTicketError ? 422 : 500
  return NextResponse.json({ error: (e as Error).message }, { status })
}

/** Resolve the canonical document subsidiary before any ticket disclosure or write. */
async function guardTicketScope(authz: Authz, ticketId: string): Promise<NextResponse | null> {
  const owned = await db.execute<{ subsidiaryId: string | null }>(sql`
    select d.subsidiary_id as "subsidiaryId"
      from documents d
      join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
     where d.id = ${ticketId} and d.org_id = ${authz.user.orgId} and d.kind = 'field_ticket'
  `)
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // A few route unit fakes omit the optional field; production Authz always
  // supplies null (unrestricted) or a concrete set.
  const scopedAuthz = authz.allowedSubsidiaryIds === undefined
    ? { ...authz, allowedSubsidiaryIds: null }
    : authz
  return guardSubsidiaryScope(scopedAuthz, owned.rows[0].subsidiaryId)
}

/** A project re-home is itself a subsidiary boundary, not just an org check. */
async function guardProjectScope(authz: Authz, projectId: string): Promise<NextResponse | null> {
  const project = await db.execute<{ subsidiaryId: string | null }>(sql`
    select p.subsidiary_id as "subsidiaryId"
      from projects p
     where p.id = ${projectId} and p.org_id = ${authz.user.orgId} and p.is_active
  `)
  if (!project.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopedAuthz = authz.allowedSubsidiaryIds === undefined
    ? { ...authz, allowedSubsidiaryIds: null }
    : authz
  return guardSubsidiaryScope(scopedAuthz, project.rows[0].subsidiaryId)
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
  const denied = await guardTicketScope(gate, id)
  if (denied) return denied
  try {
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
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
  const denied = await guardTicketScope(gate, id)
  if (denied) return denied
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const expectedRevision = requireRevision(body.expectedRevision)
  if (expectedRevision instanceof NextResponse) return expectedRevision
  if ('projectId' in body && isUuid(body.projectId)) {
    const projectDenied = await guardProjectScope(gate, body.projectId)
    if (projectDenied) return projectDenied
  }
  try {
    await updateTicketHeader(gate.user.orgId, gate.user.id, id, {
      ...(('projectId' in body) ? { projectId: isUuid(body.projectId) ? body.projectId : null } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(body.documentDate ?? '') ? { documentDate: body.documentDate } : {}),
      ...(('referenceNumber' in body) ? { referenceNumber: body.referenceNumber ? String(body.referenceNumber).slice(0, 100) : null } : {}),
      ...(('memo' in body) ? { memo: body.memo ? String(body.memo).slice(0, 2000) : null } : {}),
      ...(['shift', 'daily', 'weekly'].includes(body.period) ? { period: body.period } : {}),
      ...(('foremanPartyId' in body) ? { foremanPartyId: isUuid(body.foremanPartyId) ? body.foremanPartyId : null } : {}),
    }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
  } catch (e) {
    return fail(e)
  }
}

/** Ticket drafting/submission actions. Approval decisions live only in Flows. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const gate = await guardPermission('time.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const userId = gate.user.id
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const denied = await guardTicketScope(gate, id)
  if (denied) return denied

  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = parsedBody2.data
  const action = String(body.action ?? '')

  // Revision is a protocol requirement for every state-changing ticket edit,
  // including add/remove-line (not only the header/grid forms). Resolve the
  // record scope first so forbidden tickets always remain indistinguishable
  // 404s, even when the request body is malformed or stale.
  const preflightRevision = ['save-grid', 'patch', 'add-line', 'remove-line'].includes(action)
    ? requireRevision(body.expectedRevision)
    : null
  if (preflightRevision instanceof NextResponse) return preflightRevision

  try {
    if (action === 'save-grid') {
      const expectedRevision = preflightRevision as string
      await saveCrewGrid(orgId, userId, id, Array.isArray(body.rows) ? body.rows : [], expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (action === 'patch') {
      const expectedRevision = preflightRevision as string
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
      }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (action === 'add-line') {
      const expectedRevision = preflightRevision as string
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
      }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (action === 'remove-line') {
      const expectedRevision = preflightRevision as string
      if (!isUuid(body.lineId)) return NextResponse.json({ error: 'invalid lineId' }, { status: 422 })
      await removeTicketLine(orgId, id, body.lineId, expectedRevision, gate.allowedSubsidiaryIds ?? null)
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
    return NextResponse.json(await loadFieldTicket(orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
  } catch (e) {
    return fail(e)
  }
}
