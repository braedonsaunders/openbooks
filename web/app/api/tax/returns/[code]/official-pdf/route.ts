import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { createFile, deleteFile, ensureAttachmentsRoot } from '../../../../../../lib/file-cabinet'

export const runtime = 'nodejs'

const MAX_BYTES = 25 * 1024 * 1024

/** Upload the tenant's official government PDF and attach it to the form. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  const orgId = gate.user.orgId

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!isPdf) return NextResponse.json({ error: 'the official form must be a PDF' }, { status: 415 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })

  const exists = (await db.execute<{ id: string; official_pdf_file_id: string | null }>(sql`
    select id, official_pdf_file_id from tax_return_forms where org_id = ${orgId} and code = ${code} limit 1`))
  if (exists.rows.length === 0) return NextResponse.json({ error: 'tax return form not found' }, { status: 404 })
  const existing = exists.rows[0]!

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return NextResponse.json({ error: 'file content is not a PDF' }, { status: 415 })
  }

  const rootId = await ensureAttachmentsRoot(orgId)
  const meta = await createFile({
    orgId,
    folderId: rootId,
    filename: `${code}-official.pdf`,
    contentType: 'application/pdf',
    bytes,
    createdBy: gate.user.id,
  })
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update tax_return_forms set official_pdf_file_id = ${meta.id}, updated_at = now(), updated_by = ${gate.user.id}
         where org_id = ${orgId} and code = ${code}`)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'tax_return_forms', ${existing.id}, 'update',
                ${JSON.stringify({ officialPdf: existing.official_pdf_file_id ? 'replaced' : 'uploaded' })}::jsonb,
                ${gate.user.id})`)
    })
  } catch (error) {
    await deleteFile(orgId, meta.id)
    throw error
  }
  if (existing.official_pdf_file_id) await deleteFile(orgId, existing.official_pdf_file_id)
  return NextResponse.json({ ok: true, fileId: meta.id })
}

/** Detach the official PDF (the facsimile remains available). */
export async function DELETE(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  const old = (await db.execute<{ id: string; official_pdf_file_id: string | null }>(sql`
    select id, official_pdf_file_id from tax_return_forms
     where org_id = ${gate.user.orgId} and code = ${code} limit 1`))
  if (!old.rows[0]) return NextResponse.json({ error: 'tax return form not found' }, { status: 404 })
  const removed = old.rows[0]
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update tax_return_forms set official_pdf_file_id = null, updated_at = now(), updated_by = ${gate.user.id}
       where org_id = ${gate.user.orgId} and code = ${code}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'tax_return_forms', ${removed.id}, 'update',
              ${JSON.stringify({ officialPdf: 'removed' })}::jsonb, ${gate.user.id})`)
  })
  if (removed.official_pdf_file_id) await deleteFile(gate.user.orgId, removed.official_pdf_file_id)
  return NextResponse.json({ ok: true })
}
