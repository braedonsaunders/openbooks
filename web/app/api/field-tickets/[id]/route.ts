import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { rendererUnavailableResponse } from '@/lib/api/pdf-renderer'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isFeatureEnabled } from '../../../../lib/features'
import { DocumentEditError, requireDocumentEditRevision } from "../../../../../engine/src/records/document-edit-policy.ts";
import {
  addTicketLine,
  discardEmptyTicketDraft,
  FieldTicketError,
  FieldTicketNotFoundError,
  loadFieldTicket,
  removeTicketLine,
  saveCrewGrid,
  submitFieldTicket,
  updateTicketHeader,
} from '../../../../lib/field-tickets'
import { sendTicketForSignature } from '../../../../lib/field-ticket-signing'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])
const ticketHeaderBody = z.object({
  expectedRevision: z.string().min(1),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  projectId: z.string().uuid().nullable().optional(),
  foremanPartyId: z.string().uuid().nullable().optional(),
  period: z.enum(['shift', 'daily', 'weekly']).optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
}).strict()
const crewRowBody = z.object({
  employeePartyId: z.string().uuid(),
  itemId: z.string().uuid().nullable(),
  projectTaskId: z.string().uuid().nullable().optional(),
  timeTypeId: z.string().uuid().nullable(),
  hours: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.union([z.string(), z.number()])),
}).strict()
const ticketActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save-grid'), expectedRevision: z.string().min(1), rows: z.array(crewRowBody) }).strict(),
  z.object({
    action: z.literal('patch'), expectedRevision: z.string().min(1),
    foremanPartyId: z.string().uuid().nullable().optional(),
    workDescription: z.string().nullable().optional(), poNumber: z.string().nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal('add-line'), expectedRevision: z.string().min(1), itemId: z.string().uuid(), quantity: z.string().min(1),
    equipmentUnitId: z.string().uuid().nullable().optional(), rateUnitCode: z.string().nullable().optional(),
    employeeId: z.string().uuid().nullable().optional(), description: z.string().nullable().optional(),
  }).strict(),
  z.object({ action: z.literal('remove-line'), expectedRevision: z.string().min(1), lineId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('submit') }).strict(),
  z.object({ action: z.literal('send-signature'), to: z.string().min(1), message: z.string().nullable().optional() }).strict(),
])
const ticketDiscardBody = z.object({ expectedRevision: z.string().min(1) }).strict()

function fail(e: unknown): Promise<NextResponse> {
  // The send-for-signature action renders the ticket PDF: a renderer outage
  // answers with the named 503 refusal, never the generic 500 below.
  const rendererRefusal = rendererUnavailableResponse(e)
  if (rendererRefusal) return Promise.resolve(rendererRefusal)
  // DocumentEditError and FieldTicketNotFoundError carry their own 4xx
  // status; a bare FieldTicketError answers 422; anything else sanitizes
  // to a 500 with a request id.
  if (e instanceof FieldTicketError && !(e instanceof FieldTicketNotFoundError)) {
    return apiErrorResponse(e, { safeStatus: 422 })
  }
  return apiErrorResponse(e)
}

/** Resolve the canonical document subsidiary before any ticket disclosure or write. */
async function guardTicketScope(authz: Authz, ticketId: string): Promise<NextResponse | null> {
  const owned = await db.execute<{ subsidiaryId: string | null }>(sql`
    select d.subsidiary_id as "subsidiaryId"
      from documents d
      join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
     where d.id = ${ticketId} and d.org_id = ${authz.user.orgId} and d.kind = 'field_ticket'
  `)
  if (!owned.rows[0]) return notFound("record")
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
  if (!project.rows[0]) return notFound("record")
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
async function requireRevision(value: unknown): Promise<string | NextResponse> {
  try {
    return requireDocumentEditRevision(value)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return apiErrorResponse(e)
    }
    throw e
  }
}

export const GET = defineRoute({
  permission: 'time.read',
  feature: 'fieldTickets',
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return notFound("record")
  const denied = await guardTicketScope(gate, id)
  if (denied) return denied
  try {
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
  } catch (e) {
    return fail(e)
  }
  },
})

/** Standard-form header save (project/date/PO/memo/period/foreman). */
export const PATCH = defineRoute({
  permission: 'time.manage',
  feature: 'fieldTickets',
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return notFound("record")
  const denied = await guardTicketScope(gate, id)
  if (denied) return denied
  const parsedBody = await parseJsonBody(req, ticketHeaderBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const expectedRevision = await requireRevision(body.expectedRevision)
  if (expectedRevision instanceof NextResponse) return expectedRevision
  // Present-but-malformed header inputs fail closed here. Silently dropping
  // them (or coercing a bad id to null) would answer 200 while the ticket
  // keeps its old date or loses its foreman — the caller can never tell the
  // save did not land. Explicit nulls still clear/keep their nullable fields.
  if (body.projectId) {
    const projectDenied = await guardProjectScope(gate, body.projectId)
    if (projectDenied) return projectDenied
  }
  try {
    await updateTicketHeader(gate.user.orgId, gate.user.id, id, {
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.documentDate !== undefined ? { documentDate: body.documentDate } : {}),
      ...(body.referenceNumber !== undefined ? { referenceNumber: body.referenceNumber?.slice(0, 100) || null } : {}),
      ...(body.memo !== undefined ? { memo: body.memo?.slice(0, 2000) || null } : {}),
      ...(body.period !== undefined ? { period: body.period } : {}),
      ...(body.foremanPartyId !== undefined ? { foremanPartyId: body.foremanPartyId } : {}),
    }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    return NextResponse.json(await loadFieldTicket(gate.user.orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
  } catch (e) {
    return fail(e)
  }
  },
})

/** Ticket drafting/submission actions. Approval decisions live only in Flows. */
export const POST = defineRoute({
  permission: 'time.manage',
  feature: 'fieldTickets',
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return notFound("record")

  const orgId = gate.user.orgId
  const userId = gate.user.id

  const denied = await guardTicketScope(gate, id)
  if (denied) return denied

  const parsedBody2 = await parseJsonBody(req, ticketActionBody);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = parsedBody2.data

  // Revision is a protocol requirement for every state-changing ticket edit,
  // including add/remove-line (not only the header/grid forms). Resolve the
  // record scope first so forbidden tickets always remain indistinguishable
  // 404s, even when the request body is malformed or stale.
  const preflightRevision = body.action === 'save-grid' || body.action === 'patch' || body.action === 'add-line' || body.action === 'remove-line'
    ? await requireRevision(body.expectedRevision)
    : null
  if (preflightRevision instanceof NextResponse) return preflightRevision

  try {
    if (body.action === 'save-grid') {
      const expectedRevision = preflightRevision as string
      // Null is the stored representation for an unclassified crew time type.
      await saveCrewGrid(orgId, userId, id, body.rows as Parameters<typeof saveCrewGrid>[3], expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (body.action === 'patch') {
      const expectedRevision = preflightRevision as string
      // Same fail-closed contract as PATCH above: a malformed foreman id
      // must not coerce to null and silently clear the stored foreman.
      await updateTicketHeader(orgId, userId, id, {
        ...(body.workDescription !== undefined ? { memo: body.workDescription?.slice(0, 2000) || null } : {}),
        ...(body.poNumber !== undefined ? { referenceNumber: body.poNumber?.slice(0, 100) || null } : {}),
        ...(body.foremanPartyId !== undefined ? { foremanPartyId: body.foremanPartyId } : {}),
      }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (body.action === 'add-line') {
      const expectedRevision = preflightRevision as string
      const equipmentUnitId = body.equipmentUnitId ?? null
      if (equipmentUnitId && !(await isFeatureEnabled(orgId, 'equipment'))) {
        return notFound("record")
      }
      if (!(await isFeatureEnabled(orgId, 'equipment'))) {
        const item = (await db.execute<{ kind: string }>(sql`
          select kind from items where id = ${body.itemId} and org_id = ${orgId}`))
        if (item.rows[0]?.kind === 'equipment_charge') {
          return notFound("record")
        }
      }
      if (!(await isFeatureEnabled(orgId, 'inventory'))) {
        const item = (await db.execute<{ kind: string }>(sql`
          select kind from items where id = ${body.itemId} and org_id = ${orgId}`))
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          return notFound("record")
        }
      }
      await addTicketLine(orgId, userId, id, {
        // Forwarded as received: the engine looks the item up (garbage fails
        // closed there, exactly as when this read `any`), and parses the
        // quantity — only the static shape is pinned down here.
        itemId: body.itemId,
        quantity: body.quantity,
        rateUnitCode: typeof body.rateUnitCode === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.rateUnitCode)
          ? body.rateUnitCode
          : null,
        equipmentUnitId,
        employeeId: body.employeeId ?? null,
        description: body.description ?? null,
      }, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (body.action === 'remove-line') {
      const expectedRevision = preflightRevision as string
      await removeTicketLine(orgId, id, body.lineId, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    } else if (body.action === 'submit') {
      await submitFieldTicket(orgId, userId, id)
    } else if (body.action === 'send-signature') {
      const base = process.env.OPENBOOKS_APP_URL || new URL(req.url).origin
      await sendTicketForSignature({
        orgId,
        userId,
        ticketId: id,
        to: body.to,
        message: body.message ? body.message.slice(0, 1000) : null,
        appBaseUrl: base,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
      })
    }
    return NextResponse.json(await loadFieldTicket(orgId, id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds ?? null,
    }))
  } catch (e) {
    return fail(e)
  }
  },
})

/**
 * Discard an untouched draft. New ticket persists an empty
 * server-side draft on click; this is its way back out. Anything with
 * content, signatures, links, or status refuses with the blocker named.
 */
export const DELETE = defineRoute({
  permission: 'time.manage',
  feature: 'fieldTickets',
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return notFound("record")
  const denied = await guardTicketScope(gate, id)
  if (denied) return denied
  const parsedBody = await parseJsonBody(req, ticketDiscardBody);
  if (!parsedBody.ok) return parsedBody.response;
  const expectedRevision = await requireRevision(parsedBody.data.expectedRevision)
  if (expectedRevision instanceof NextResponse) return expectedRevision
  try {
    await discardEmptyTicketDraft(gate.user.orgId, gate.user.id, id, expectedRevision, gate.allowedSubsidiaryIds ?? null)
    return NextResponse.json({ id })
  } catch (e) {
    return fail(e)
  }
  },
})
