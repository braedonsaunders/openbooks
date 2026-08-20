import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Record the one-way prepared → filed transition and government reference. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { filingReference?: unknown }
  const filingReference = typeof body.filingReference === 'string' ? body.filingReference.trim() : ''
  if (filingReference.length > 200) return NextResponse.json({ error: 'reference is too long' }, { status: 422 })

  try {
    const updated = await db.transaction(async (tx) => {
      const before = (await tx.execute<{ status: 'prepared' | 'filed' }>(sql`
        select status from tax_filings
         where id = ${id} and org_id = ${gate.user.orgId} for update`))
      if (!before.rows[0]) return null
      if (before.rows[0].status !== 'prepared') throw new Error('already-filed')
      const result = (await tx.execute<{ id: string; filed_at: string }>(sql`
        update tax_filings
           set status = 'filed', filing_reference = ${filingReference || null}, filed_at = now(),
               updated_at = now(), updated_by = ${gate.user.id}
         where id = ${id} and org_id = ${gate.user.orgId}
        returning id, filed_at`))
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'tax_filings', ${id}, 'update',
                ${JSON.stringify({ before: { status: 'prepared' }, after: { status: 'filed', filingReference: filingReference || null } })}::jsonb,
                ${gate.user.id})`)
      return result.rows[0]
    })
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(updated)
  } catch (error) {
    if (error instanceof Error && error.message === 'already-filed') {
      return NextResponse.json({ error: 'filing is already filed' }, { status: 409 })
    }
    return NextResponse.json({ error: 'could not update filing' }, { status: 422 })
  }
}
