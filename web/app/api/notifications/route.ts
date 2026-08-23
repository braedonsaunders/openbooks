import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getAuthz } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * My in-app notification inbox (the `notifications` table — written by flow
 * `notify` actions, gate assignment/reminder/escalation, and delegation).
 *
 *   GET   → latest 30 for the signed-in user + their unread count.
 *   PATCH → mark read: { ids: [...] } for specific rows, or { all: true }.
 *
 * Strictly self-scoped: every query filters on the session user + org, so
 * there is no permission gate — your inbox is yours.
 */
export async function GET() {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id: userId, orgId } = authz.user

  const [items, unread] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select id, kind, title, body, href, read_at as "readAt", created_at as "createdAt"
        from notifications
       where org_id = ${orgId} and user_id = ${userId}
       order by created_at desc
       limit 30`),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from notifications
       where org_id = ${orgId} and user_id = ${userId} and read_at is null`),
  ]))

  return NextResponse.json({ items: items.rows, unread: unread.rows[0]?.n ?? 0 })
}

export async function PATCH(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id: userId, orgId } = authz.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { ids?: string[]; all?: boolean }
  if (body.all === true) {
    await db.execute(sql`
      update notifications set read_at = now(), updated_at = now()
       where org_id = ${orgId} and user_id = ${userId} and read_at is null`)
    return NextResponse.json({ ok: true })
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => isUuid(id)) : []
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids or all required' }, { status: 400 })
  }
  await db.execute(sql`
    update notifications set read_at = now(), updated_at = now()
     where org_id = ${orgId} and user_id = ${userId} and read_at is null
       and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`)
  return NextResponse.json({ ok: true })
}
