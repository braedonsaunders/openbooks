import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

const TRIGGERS = ['before_submit', 'before_post', 'after_post', 'before_void', 'scheduled']

function validate(body: Record<string, unknown>): string | null {
  if (!body.name || String(body.name).length > 200) return 'name required'
  if (!TRIGGERS.includes(String(body.triggerPoint))) return 'invalid trigger point'
  const src = String(body.source ?? '')
  if (!src || src.length > 100_000) return 'source required (max 100k chars)'
  if (!/function\s+main\s*\(/.test(src)) return 'script must define function main(ctx)'
  return null
}

export async function POST(req: Request) {
  const gate = await guardPermission('scripts.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const body = (await req.json()) as Record<string, unknown>
  const err = validate(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  const r = (await db.execute(sql`
    insert into user_scripts (org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
    values (${user.orgId}, ${body.name}, ${body.triggerPoint}, ${body.documentKind ?? null}, ${body.source},
            ${Math.min(Number(body.timeoutMs) || 2000, 10_000)}, ${Number(body.sortOrder) || 100}, ${body.isActive !== false})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}

export async function PATCH(req: Request) {
  const gate = await guardPermission('scripts.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const body = (await req.json()) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const err = validate(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  await db.execute(sql`
    update user_scripts set
      name = ${body.name}, trigger_point = ${body.triggerPoint}, document_kind = ${body.documentKind ?? null},
      source = ${body.source}, timeout_ms = ${Math.min(Number(body.timeoutMs) || 2000, 10_000)},
      sort_order = ${Number(body.sortOrder) || 100}, is_active = ${body.isActive !== false}, updated_at = now()
    where id = ${body.id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
