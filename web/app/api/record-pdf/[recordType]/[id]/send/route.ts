import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission, guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isDocKindEnabled } from '../../../../../../lib/documents'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../../lib/pdf-templates/catalog'
import { resolveRecordRecipient, sendRecordPdfEmail } from '../../../../../../lib/pdf-templates/send'
import { loadRecordSubsidiaryScope } from '../../../lib'

export const runtime = 'nodejs'

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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { to?: string; message?: string; template?: string }
  try {
    const result = await sendRecordPdfEmail({
      recordType,
      orgId: gate.user.orgId,
      id,
      to: typeof body.to === 'string' ? body.to : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      templateId: typeof body.template === 'string' ? body.template : null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'send failed' }, { status: 422 })
  }
}
