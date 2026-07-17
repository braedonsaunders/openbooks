import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { pdfResponse, safeName } from '../../../../../lib/export'
import { assembleInvoiceBackup, loadInvoiceBackup, type BackupType } from '../../../../../lib/invoice-backup'

export const runtime = 'nodejs'

/** Resolve a billing request's generated invoice + its backup type. */
async function requestInvoice(orgId: string, requestId: string) {
  const r = (await db.execute(sql`
    select invoice_document_id, backup_type from billing_requests where id = ${requestId} and org_id = ${orgId}
  `)) as unknown as { rows: { invoice_document_id: string | null; backup_type: string }[] }
  return r.rows[0] ?? null
}

/** POST — assemble + persist the backup package for the request's invoice. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const req = await requestInvoice(gate.user.orgId, id)
  if (!req?.invoice_document_id) return NextResponse.json({ error: 'This request has no invoice to back up yet' }, { status: 422 })
  try {
    const result = await assembleInvoiceBackup(gate.user.orgId, gate.user.id, req.invoice_document_id, req.backup_type as BackupType)
    return NextResponse.json({ fileId: result.fileId, pageCount: result.pageCount })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/** GET — stream the stored backup PDF (assembling on the fly if missing). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const req = await requestInvoice(gate.user.orgId, id)
  if (!req?.invoice_document_id) return NextResponse.json({ error: 'No invoice to back up' }, { status: 404 })
  let backup = await loadInvoiceBackup(gate.user.orgId, req.invoice_document_id)
  if (!backup) {
    await assembleInvoiceBackup(gate.user.orgId, gate.user.id, req.invoice_document_id, req.backup_type as BackupType)
    backup = await loadInvoiceBackup(gate.user.orgId, req.invoice_document_id)
  }
  if (!backup) return NextResponse.json({ error: 'Backup could not be assembled' }, { status: 500 })
  return pdfResponse(backup.bytes, safeName(backup.filename))
}
