import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { generatePaymentFileArtifact, recordPaymentFileDownload } from '@openbooks/engine/src/payment-operations.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { guardPaymentRunPermission, paymentErrorResponse } from '../../../lib'

export const runtime = 'nodejs'

/**
 * Download the latest approved immutable file artifact. Generation is a
 * separate POST so profiles that require file approval cannot leak bytes.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate

  try {
    const result = (await db.execute(sql`
      select pf.id, pf.filename, pf.content_type, fb.bytes
        from payment_files pf join file_blobs fb on fb.version_id = pf.file_version_id
       where pf.payment_run_id = ${id} and pf.org_id = ${gate.user.orgId}
         and pf.status in ('approved', 'delivered')
       order by pf.sequence_number desc limit 1
    `)) as unknown as { rows: { id: string; filename: string; content_type: string; bytes: Buffer }[] }
    const file = result.rows[0]
    if (!file) return NextResponse.json({ error: 'no approved payment file is available' }, { status: 409 })
    await recordPaymentFileDownload(file.id, gate.user.orgId, gate.user.id)
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.content_type,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

/** Generate and persist a new file artifact for an approved run. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  try {
    const file = await generatePaymentFileArtifact(id, gate.user.orgId, gate.user.id)
    const state = (await db.execute(sql`select status from payment_files where id = ${file.id}`)) as unknown as { rows: { status: string }[] }
    return NextResponse.json({ id: file.id, filename: file.filename, status: state.rows[0]?.status })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
