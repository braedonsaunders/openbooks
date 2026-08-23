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
  const body = (await req.json()) as Record<string, unknown>
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const r = (await db.execute<{ id: string }>(sql`
    insert into bank_match_rules (org_id, name, criteria, outcome, priority, is_active, created_by)
    values (${user.orgId}, ${String(body.name).trim()}, ${JSON.stringify(built.criteria)}::jsonb,
            ${JSON.stringify(built.outcome)}::jsonb, ${Number(body.priority) || 100}, ${body.isActive !== false}, ${user.id})
    returning id
  `))
  return NextResponse.json({ id: r.rows[0]!.id })
}

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json()) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!body.name || String(body.name).trim() === '' || String(body.name).length > 200) {
    return NextResponse.json({ error: 'name required (max 200 chars)' }, { status: 400 })
  }
  const built = build(body)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  await db.execute(sql`
    update bank_match_rules set
      name = ${String(body.name).trim()}, criteria = ${JSON.stringify(built.criteria)}::jsonb,
      outcome = ${JSON.stringify(built.outcome)}::jsonb, priority = ${Number(body.priority) || 100},
      is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
    where id = ${body.id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
