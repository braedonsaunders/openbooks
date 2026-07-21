import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const LANES = ['direct_cost', 'bill', 'transfer', 'planning_cost', 'planning_bill'] as const
const METHODS = ['fixed', 'at_cost', 'markup_on_cost', 'margin_on_cost'] as const

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const item = (await db.execute(sql`select kind from items where id = ${id} and org_id = ${gate.user.orgId}`)) as any
  if (!item.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [versions, rules] = await Promise.all([
    db.execute(sql`
      select v.id, b.name as book_name, b.currency, v.effective_from
        from item_rate_versions v join item_rate_books b on b.id = v.rate_book_id
       where v.org_id = ${gate.user.orgId} and v.status = 'draft' and b.is_active
       order by b.is_default desc, b.name, v.effective_from desc`) as any,
    db.execute(sql`
      select l.id, l.code, l.name, l.lane, l.method, l.amount, l.percent, l.currency,
             l.priority, l.is_active, v.status, v.effective_from, b.name as book_name
        from labor_rate_lines l
        join item_rate_versions v on v.id = l.version_id
        join item_rate_books b on b.id = v.rate_book_id
       where l.org_id = ${gate.user.orgId} and l.item_id = ${id}
       order by v.effective_from desc, l.priority desc, l.code`) as any,
  ])
  return NextResponse.json({ kind: item.rows[0].kind, versions: versions.rows, rules: rules.rows })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  if (!isUuid(id) || !isUuid(String(body.versionId ?? ''))) return NextResponse.json({ error: 'Invalid item or draft version' }, { status: 422 })
  const code = String(body.code ?? '').trim().toUpperCase()
  const name = String(body.name ?? '').trim()
  const lane = String(body.lane ?? '')
  const method = String(body.method ?? '')
  const currency = String(body.currency ?? '').trim().toUpperCase()
  if (!code || !name || !LANES.includes(lane as typeof LANES[number])) return NextResponse.json({ error: 'Code, name, and lane are required' }, { status: 422 })
  if (!METHODS.includes(method as typeof METHODS[number])) return NextResponse.json({ error: 'Invalid method' }, { status: 422 })
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'Currency must be a 3-letter code' }, { status: 422 })
  const amount = method === 'fixed' ? String(body.amount ?? '') : null
  const percent = method === 'markup_on_cost' || method === 'margin_on_cost' ? String(body.percent ?? '') : null
  try {
    if (amount !== null && cmp(amount, '0') < 0) throw new Error()
    if (percent !== null && (cmp(percent, '0') < 0 || (method === 'margin_on_cost' && cmp(percent, '100') >= 0))) throw new Error()
  } catch { return NextResponse.json({ error: 'Rate value is invalid' }, { status: 422 }) }
  if (lane === 'direct_cost' && method !== 'fixed') return NextResponse.json({ error: 'Direct cost must use a fixed rate' }, { status: 422 })

  try {
    const inserted = await db.transaction(async (tx) => {
      const scope = (await tx.execute(sql`
        select 1 from items i cross join item_rate_versions v
         where i.id = ${id} and i.org_id = ${gate.user.orgId}
           and v.id = ${String(body.versionId)} and v.org_id = ${gate.user.orgId} and v.status = 'draft'`)) as any
      if (!scope.rows[0]) throw new Error('Item or editable draft version was not found')
      const result = (await tx.execute(sql`
        insert into labor_rate_lines
          (org_id, version_id, item_id, code, name, lane, method, amount, percent, currency, unit_code, base_hours, priority, created_by, updated_by)
        values (${gate.user.orgId}, ${String(body.versionId)}, ${id}, ${code}, ${name}, ${lane}, ${method},
                ${amount}, ${percent}, ${currency}, 'hour', 1, ${Number(body.priority ?? 100)}, ${gate.user.id}, ${gate.user.id})
        returning id`)) as any
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'labor_rate_lines', ${result.rows[0].id}, 'insert',
                ${JSON.stringify({ itemId: id, versionId: body.versionId, code, lane, method, amount, percent })}::jsonb, ${gate.user.id})`)
      return result.rows[0]
    })
    return NextResponse.json(inserted)
  } catch (error) {
    const message = (error as Error).message
    return NextResponse.json({ error: /unique|duplicate/i.test(message) ? 'That code already exists in this version' : message }, { status: 422 })
  }
}
