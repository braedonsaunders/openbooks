import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadRunFile } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { paymentErrorResponse } from '../../../lib'

export const runtime = 'nodejs'

/**
 * CPA-005 EFT file download (fixed-width text). Generating the file flips a
 * draft run to 'exported' and stamps exported_at on first download — posting
 * the run is only allowed after this step.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const file = await loadRunFile(id, gate.user.orgId, new Date())
    await db.execute(sql`
      update payment_runs
         set status = case when status = 'draft' then 'exported' else status end,
             exported_at = coalesce(exported_at, now()),
             exported_file_ref = coalesce(exported_file_ref, ${file.filename}),
             updated_at = now(), updated_by = ${gate.user.id}
       where id = ${id} and org_id = ${gate.user.orgId}
    `)
    return new NextResponse(file.content, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
