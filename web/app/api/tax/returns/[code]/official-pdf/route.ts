import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission, guardUnrestrictedScope } from '../../../../../../lib/authz'
import { createFile, deleteFile, ensureAttachmentsRoot } from '../../../../../../lib/file-cabinet'

export const runtime = 'nodejs'

const MAX_BYTES = 25 * 1024 * 1024

/** Upload the tenant's official government PDF and attach it to the form. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  // The official government PDF is org-wide statutory material.
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
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
  // The form row is locked and the linkage verified inside the transaction:
  // an UPDATE that matches zero rows (the form vanished after the existence
  // select, or RLS matched nothing) must never audit a linkage that does
  // not exist, nor answer {ok} with an orphan file.
  let linkedFileId: string | null = null
  try {
    const linked = await db.transaction(async (tx) => {
      const locked = (await tx.execute<{ id: string; official_pdf_file_id: string | null }>(sql`
        select id, official_pdf_file_id from tax_return_forms
         where org_id = ${orgId} and code = ${code} for update`))
      if (locked.rows.length === 0) return null
      const current = locked.rows[0]!
      const updated = await tx.execute(sql`
        update tax_return_forms set official_pdf_file_id = ${meta.id}, updated_at = now(), updated_by = ${gate.user.id}
         where org_id = ${orgId} and code = ${code}`)
      if ((updated.rowCount ?? 0) === 0) return null
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'tax_return_forms', ${current.id}, 'update',
                ${JSON.stringify({ officialPdf: current.official_pdf_file_id ? 'replaced' : 'uploaded' })}::jsonb,
                ${gate.user.id})`)
      return current.official_pdf_file_id
    })
    if (linked === null) {
      await deleteFile(orgId, meta.id)
      return NextResponse.json({ error: 'tax return form not found' }, { status: 404 })
    }
    linkedFileId = linked
  } catch (error) {
    await deleteFile(orgId, meta.id)
    throw error
  }
  if (linkedFileId) await deleteFile(orgId, linkedFileId)
  return NextResponse.json({ ok: true, fileId: meta.id })
}

/** Detach the official PDF (the facsimile remains available). */
export async function DELETE(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const { code } = await params
  const old = (await db.execute<{ id: string; official_pdf_file_id: string | null }>(sql`
    select id, official_pdf_file_id from tax_return_forms
     where org_id = ${gate.user.orgId} and code = ${code} limit 1`))
  if (!old.rows[0]) return NextResponse.json({ error: 'tax return form not found' }, { status: 404 })
  // Lock the row and verify the unlink, same as the attach: a zero-row
  // UPDATE (or detaching when nothing is attached) audits nothing and
  // answers a named 404 instead of ok for a no-op.
  const detached = await db.transaction(async (tx) => {
    const locked = (await tx.execute<{ id: string; official_pdf_file_id: string | null }>(sql`
      select id, official_pdf_file_id from tax_return_forms
       where org_id = ${gate.user.orgId} and code = ${code} for update`))
    if (locked.rows.length === 0 || !locked.rows[0]!.official_pdf_file_id) return null
    const current = locked.rows[0]!
    const updated = await tx.execute(sql`
      update tax_return_forms set official_pdf_file_id = null, updated_at = now(), updated_by = ${gate.user.id}
       where org_id = ${gate.user.orgId} and code = ${code}`)
    if ((updated.rowCount ?? 0) === 0) return null
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'tax_return_forms', ${current.id}, 'update',
              ${JSON.stringify({ officialPdf: 'removed' })}::jsonb, ${gate.user.id})`)
    return current.official_pdf_file_id
  })
  if (detached === null) {
    return NextResponse.json(
      { error: 'no official PDF is attached to this return form' },
      { status: 404 },
    )
  }
  await deleteFile(gate.user.orgId, detached)
  return NextResponse.json({ ok: true })
}
