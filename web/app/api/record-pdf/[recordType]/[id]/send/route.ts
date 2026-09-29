import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { z } from "zod";
import { NextResponse } from 'next/server'
import { isValidEmailAddress } from '@openbooks/emails'
import { can, guardPermission, guardSubsidiaryScope } from '../../../../../../lib/authz'
import { rendererUnavailableResponse } from '../../../../../../lib/api/pdf-renderer'
import { isDocKindEnabled } from "../../../../../../lib/documents.ts";
import { isUuid } from '../../../../../../lib/list-params'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../../lib/pdf-templates/catalog'
import { resolveRecordRecipient, sendRecordPdfEmail } from '../../../../../../lib/pdf-templates/send'
import { loadRecordSubsidiaryScope } from '../../../lib'
import { notFound } from "@/lib/api/responses";
import { defineRoute } from '@/lib/api/route'


export const runtime = 'nodejs'

const sendRecordBody = z.object({
  to: z.string().optional(),
  message: z.string().optional(),
  template: z.string().optional(),
}).strict();

/**
 * Outbound-send authority per PDF record type — the write-side twin of the
 * catalog's readPermission. Emailing a record to any recipient discloses and
 * acts on it, so sending requires the record family's own write/post/run
 * authority and is never authorized by read access alone. Keys mirror
 * PDF_RECORD_TYPE_BY_KEY (an unmapped type fails closed below); each value
 * reuses the family's existing gate: document/order creates (ar.create,
 * ap.create), payment drafts (ar.pay / ap.pay), journals post (gl.post),
 * expense submit (expenses.create), field-ticket manage (time.manage),
 * payroll run delivery (payroll.run), and the sales-order create grant for
 * a shipment's packing slip (ar.create): sending is customer correspondence,
 * stronger than the fulfilment grant that reads it.
 */
const RECORD_TYPE_SEND_PERMISSION: Record<string, string> = {
  customer_invoice: 'ar.create',
  customer_credit: 'ar.create',
  quote: 'ar.create',
  sales_order: 'ar.create',
  customer_payment: 'ar.pay',
  purchase_order: 'ap.create',
  vendor_bill: 'ap.create',
  vendor_credit: 'ap.create',
  vendor_payment: 'ap.pay',
  check: 'ap.create',
  card_charge: 'ap.create',
  card_refund: 'ap.create',
  expense_report: 'expenses.create',
  field_ticket: 'time.manage',
  shipment: 'ar.create',
  shipment_carton_label: 'ar.create',
  shipment_shipping_label: 'ar.create',
  journal: 'gl.post',
  journal_entry: 'gl.post',
  pay_stub: 'payroll.run',
  payroll_cheque: 'payroll.run',
}

/** GET — default recipient + labels to prefill the send dialog. */
async function getSendOptions(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  if (!(await isDocKindEnabled(gate.user.orgId, meta.docKind ?? meta.key))) {
    return notFound("record")
  }
  // A malformed id is a plain not-found, settled before any record lookup.
  if (!isUuid(id)) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const owned = await loadRecordSubsidiaryScope(recordType, gate.user.orgId, id)
  if (!owned) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
  if (denied) return denied
  const info = await resolveRecordRecipient(recordType, gate.user.orgId, id, gate.allowedSubsidiaryIds ?? null)
  if (!info) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  return NextResponse.json(info)
}

/** POST — render the record PDF and email it to the party. */
async function sendRecord(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  if (!(await isDocKindEnabled(gate.user.orgId, meta.docKind ?? meta.key))) {
    return notFound("record")
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const owned = await loadRecordSubsidiaryScope(recordType, gate.user.orgId, id)
  if (!owned) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
  if (denied) return denied

  // Emailing the record outbound is a write-side act on it: require the
  // record type's send authority — read access alone must never authorize a
  // delivery — and settle it BEFORE any body work, so denial leaves no
  // delivery or email_log trace.
  const sendPermission = RECORD_TYPE_SEND_PERMISSION[recordType]
  if (!sendPermission || !can(gate, sendPermission)) {
    return NextResponse.json(
      { error: `missing permission: ${sendPermission ?? 'outbound send'}` },
      { status: 403 },
    )
  }

  const parsedBody = await parseJsonBody(req, sendRecordBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  // Recipient policy at this boundary: an explicitly addressed send must name
  // one syntactically valid address; blank falls through to the party email
  // on file inside the sender. Refused before any render/log/send work.
  const requestedTo = typeof body.to === 'string' ? body.to.trim() : ''
  if (requestedTo !== '' && !isValidEmailAddress(requestedTo)) {
    return NextResponse.json({ error: 'invalid recipient email address' }, { status: 400 })
  }
  // A present template field (including empty) that is not a UUID is the
  // same 404 a missing template gets, settled before sendRecordPdfEmail
  // can bind it to pdf_templates.id. Only an omitted field may fall through
  // to the org default / starter.
  const requestedTemplate = typeof body.template === 'string' ? body.template : null
  if (requestedTemplate !== null && !isUuid(requestedTemplate)) {
    return NextResponse.json({ error: 'template not found' }, { status: 404 })
  }
  try {
    const result = await sendRecordPdfEmail({
      recordType,
      orgId: gate.user.orgId,
      id,
      to: requestedTo || undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      templateId: requestedTemplate,
      scope: gate.allowedSubsidiaryIds ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const rendererRefusal = rendererUnavailableResponse(e)
    if (rendererRefusal) return rendererRefusal
    return apiErrorResponse(e)
  }
}

const sendParams = z.object({ recordType: z.string(), id: z.string() })
const authorizeRecordRead = async ({ params }: { request: Request; params: unknown }) => {
  const recordType = (params as { recordType?: string } | undefined)?.recordType ?? ''
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
  return guardPermission(meta.readPermission)
}
const authorizeRecordSend = async ({ params }: { request: Request; params: unknown }) => {
  const recordType = (params as { recordType?: string } | undefined)?.recordType ?? ''
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  const sendPermission = RECORD_TYPE_SEND_PERMISSION[recordType]
  if (!sendPermission || !can(gate, sendPermission)) {
    return NextResponse.json({ error: `missing permission: ${sendPermission ?? 'outbound send'}` }, { status: 403 })
  }
  return gate
}

export const GET = defineRoute({
  authorize: authorizeRecordRead,
  feature: { none: 'Record-type availability is enforced by the document-kind gate in the send dialog handler.' },
  params: sendParams,
  handler: async ({ request, params }) => getSendOptions(request, { params: Promise.resolve(params) }),
})
export const POST = defineRoute({
  authorize: authorizeRecordSend,
  feature: { none: 'Record-type availability is enforced by the document-kind gate; outbound delivery also checks its write permission.' },
  params: sendParams,
  handler: async ({ request, params }) => sendRecord(request, { params: Promise.resolve(params) }),
})
