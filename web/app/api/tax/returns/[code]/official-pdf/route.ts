import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { createFile, ensureAttachmentsRoot } from '../../../../../../lib/file-cabinet'

export const runtime = 'nodejs'

const MAX_BYTES = 25 * 1024 * 1024

/** Upload the tenant's official government PDF and attach it to the form. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.users.manage')
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

  const exists = (await db.execute(sql`
    select 1 from tax_return_forms where org_id = ${orgId} and code = ${code} limit 1`)) as unknown as { rows: unknown[] }
  if (exists.rows.length === 0) return NextResponse.json({ error: 'tax return form not found' }, { status: 404 })

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })

  const rootId = await ensureAttachmentsRoot(orgId)
  const meta = await createFile({
    orgId,
    folderId: rootId,
    filename: `${code}-official.pdf`,
    contentType: 'application/pdf',
    bytes,
    createdBy: gate.user.id,
  })
  await db.execute(sql`
    update tax_return_forms set official_pdf_file_id = ${meta.id}, updated_at = now(), updated_by = ${gate.user.id}
     where org_id = ${orgId} and code = ${code}`)
  return NextResponse.json({ ok: true, fileId: meta.id })
}

/** Detach the official PDF (the facsimile remains available). */
export async function DELETE(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('admin.users.manage')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  await db.execute(sql`
    update tax_return_forms set official_pdf_file_id = null, updated_at = now(), updated_by = ${gate.user.id}
     where org_id = ${gate.user.orgId} and code = ${code}`)
  return NextResponse.json({ ok: true })
}
