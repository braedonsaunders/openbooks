import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { pdfResponse, safeName } from '../../../../../lib/export'
import { assembleInvoiceBackup, loadInvoiceBackup, InvoiceBackupNotFoundError, type BackupType } from '../../../../../lib/invoice-backup'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const runtime = 'nodejs'

/** Resolve a billing request's generated invoice + its backup type. */
async function requestInvoice(orgId: string, requestId: string, allowedSubsidiaryIds: ReadonlySet<string> | null) {
  const r = (await db.execute<{ invoice_document_id: string | null; backup_type: string }>(sql`
    select br.invoice_document_id, br.backup_type from billing_requests br
      join projects p on p.id = br.project_id and p.org_id = br.org_id
     where br.id = ${requestId} and br.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       and (br.invoice_document_id is null or exists (
         select 1 from documents d where d.id = br.invoice_document_id and d.org_id = br.org_id
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       ))
  `))
  return r.rows[0] ?? null
}

/** POST — assemble + persist the backup package for the request's invoice. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const req = await requestInvoice(gate.user.orgId, id, gate.allowedSubsidiaryIds)
  if (!req) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!req.invoice_document_id) return NextResponse.json({ error: 'This request has no invoice to back up yet' }, { status: 422 })
  try {
    const result = await assembleInvoiceBackup(gate.user.orgId, gate.user.id, req.invoice_document_id, req.backup_type as BackupType, gate.allowedSubsidiaryIds)
    return NextResponse.json({ fileId: result.fileId, pageCount: result.pageCount })
  } catch (e) {
    if (e instanceof InvoiceBackupNotFoundError) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/** GET — stream the stored backup PDF (assembling on the fly if missing). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const req = await requestInvoice(gate.user.orgId, id, gate.allowedSubsidiaryIds)
  if (!req) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!req.invoice_document_id) return NextResponse.json({ error: 'No invoice to back up' }, { status: 404 })
  try {
    let backup = await loadInvoiceBackup(gate.user.orgId, req.invoice_document_id, gate.allowedSubsidiaryIds)
    if (!backup) {
      await assembleInvoiceBackup(gate.user.orgId, gate.user.id, req.invoice_document_id, req.backup_type as BackupType, gate.allowedSubsidiaryIds)
      backup = await loadInvoiceBackup(gate.user.orgId, req.invoice_document_id, gate.allowedSubsidiaryIds)
    }
    if (!backup) return NextResponse.json({ error: 'Backup could not be assembled' }, { status: 500 })
    return pdfResponse(backup.bytes, safeName(backup.filename))
  } catch (e) {
    if (e instanceof InvoiceBackupNotFoundError) return NextResponse.json({ error: 'not found' }, { status: 404 })
    throw e
  }
}
