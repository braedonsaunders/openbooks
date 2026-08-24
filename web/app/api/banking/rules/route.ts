import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { validateCriteria, validateOutcome } from '../../../../lib/banking-rules-validate'

export const runtime = 'nodejs'

function build(body: Record<string, unknown>): { error: string } | { criteria: unknown; outcome: unknown } {
  const c = validateCriteria(body.criteria)
  if (!c.ok) return { error: c.error }
  const o = validateOutcome(body.outcome)
  if (!o.ok) return { error: o.error }
  return { criteria: c.value, outcome: o.value }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  // Match rules decide how imported bank lines are categorized and posted, so
  // every write lands in the audit trail inside the same transaction.
  const created = await db.transaction(async (tx) => {
    const row = (await tx.execute<Record<string, unknown>>(sql`
      insert into bank_match_rules (org_id, name, criteria, outcome, priority, is_active, created_by)
      values (${user.orgId}, ${String(body.name).trim()}, ${JSON.stringify(built.criteria)}::jsonb,
              ${JSON.stringify(built.outcome)}::jsonb, ${Number(body.priority) || 100}, ${body.isActive !== false}, ${user.id})
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${user.orgId}, 'bank_match_rules', ${(row.rows[0] as any).id as string}, 'insert',
         ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${user.id})
    `)
    return row.rows[0]!
  })
  return NextResponse.json({ id: ((created)).id as string })
}

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const missing = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from bank_match_rules where id = ${body.id} and org_id = ${user.orgId}
    `))
    if (!before.rows[0]) return true
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update bank_match_rules set
        name = ${String(body.name).trim()}, criteria = ${JSON.stringify(built.criteria)}::jsonb,
        outcome = ${JSON.stringify(built.outcome)}::jsonb, priority = ${Number(body.priority) || 100},
        is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
      where id = ${body.id} and org_id = ${user.orgId}
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${user.orgId}, 'bank_match_rules', ${String(body.id)}, 'update',
         ${JSON.stringify({ before: before.rows[0], after: updated.rows[0] })}::jsonb, ${user.id})
    `)
    return false
  })
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
