import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { isValidEmailAddress } from '@openbooks/emails'
import { can, guardPermission, guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isDocKindEnabled } from '../../../../../../lib/documents'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../../lib/pdf-templates/catalog'
import { resolveRecordRecipient, sendRecordPdfEmail } from '../../../../../../lib/pdf-templates/send'
import { loadRecordSubsidiaryScope } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Outbound-send authority per PDF record type — the write-side twin of the
 * catalog's readPermission. Emailing a record to any recipient discloses and
 * acts on it, so sending requires the record family's own write/post/run
 * authority and is never authorized by read access alone. Keys mirror
 * PDF_RECORD_TYPE_BY_KEY (an unmapped type fails closed below); each value
 * reuses the family's existing gate: document/order creates (ar.create,
 * ap.create), payment drafts (ar.pay / ap.pay), journals post (gl.post),
 * expense submit (expenses.create), field-ticket manage (time.manage), and
 * payroll run delivery (payroll.run).
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
  journal: 'gl.post',
  journal_entry: 'gl.post',
  pay_stub: 'payroll.run',
  payroll_cheque: 'payroll.run',
}

/** GET — default recipient + labels to prefill the send dialog. */
export async function GET(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  if (!(await isDocKindEnabled(gate.user.orgId, recordType))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const owned = await loadRecordSubsidiaryScope(recordType, gate.user.orgId, id)
  if (!owned) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId)
  if (denied) return denied
  const info = await resolveRecordRecipient(recordType, gate.user.orgId, id)
  if (!info) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  return NextResponse.json(info)
}

/** POST — render the record PDF and email it to the party. */
export async function POST(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  if (!(await isDocKindEnabled(gate.user.orgId, recordType))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { to?: string; message?: string; template?: string }
  // Recipient policy at this boundary: an explicitly addressed send must name
  // one syntactically valid address; blank falls through to the party email
  // on file inside the sender. Refused before any render/log/send work.
  const requestedTo = typeof body.to === 'string' ? body.to.trim() : ''
  if (requestedTo !== '' && !isValidEmailAddress(requestedTo)) {
    return NextResponse.json({ error: 'invalid recipient email address' }, { status: 400 })
  }
  try {
    const result = await sendRecordPdfEmail({
      recordType,
      orgId: gate.user.orgId,
      id,
      to: requestedTo || undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      templateId: typeof body.template === 'string' ? body.template : null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'send failed' }, { status: 422 })
  }
}
