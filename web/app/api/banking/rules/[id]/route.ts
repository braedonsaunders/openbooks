import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const missing = await db.transaction(async (tx) => {
    // Snapshot the rule first: deletion removes the record of what used to
    // auto-categorize bank lines.
    const existing = (await tx.execute<Record<string, unknown>>(sql`
      select * from bank_match_rules where id = ${id} and org_id = ${user.orgId}
    `))
    if (!existing.rows[0]) return true
    await tx.execute(sql`delete from bank_match_rules where id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${user.orgId}, 'bank_match_rules', ${id}, 'delete',
         ${JSON.stringify({ before: existing.rows[0] })}::jsonb, ${user.id})
    `)
    return false
  })
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
