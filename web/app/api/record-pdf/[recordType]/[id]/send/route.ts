import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../../lib/authz'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../../lib/pdf-templates/catalog'
import { resolveRecordRecipient, sendRecordPdfEmail } from '../../../../../../lib/pdf-templates/send'

export const runtime = 'nodejs'

/** GET — default recipient + labels to prefill the send dialog. */
export async function GET(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate
  const info = await resolveRecordRecipient(recordType, gate.user.orgId, id)
  if (!info) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  return NextResponse.json(info)
}

/** POST — render the record PDF and email it to the party. */
export async function POST(req: Request, { params }: { params: Promise<{ recordType: string; id: string }> }) {
  const { recordType, id } = await params
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
  const gate = await guardPermission(meta.readPermission)
  if (gate instanceof NextResponse) return gate

  const body = (await req.json().catch(() => ({}))) as { to?: string; message?: string; template?: string }
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
