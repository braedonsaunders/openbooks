import { notFound } from '@/lib/api/responses';
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { markNotificationsRead } from '@openbooks/engine/src/inbox/adapters/notification.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getAuthz } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
const PATCHBodySchema1 = z.object({ "ids": z.array(z.string()).optional(), "all": z.boolean().optional() }).passthrough();


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
export const GET = defineRoute({
  public: 'session',
  handler: async (_) => {
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
  },
});

export const PATCH = defineRoute({
  public: 'session',
  body: PATCHBodySchema1,
  handler: async ({ request: req , body: routeBody }) => {
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { id: userId, orgId } = authz.user

    const body = (routeBody) as { ids?: string[]; all?: boolean }
    if (body.all === true) {
        await db.execute(sql`
          update notifications set read_at = now(), updated_at = now()
           where org_id = ${orgId} and user_id = ${userId} and read_at is null`)
        return NextResponse.json({ ok: true })
      }
    const requested = Array.isArray(body.ids) ? body.ids.filter((id) => isUuid(id)) : []
    const ids = [...new Set(requested)]
    if (ids.length === 0) {
        return NextResponse.json({ error: 'ids or all required' }, { status: 400 })
      }
    const { own } = await markNotificationsRead(db, { orgId, userId, ids })
    if (own < ids.length) {
        return notFound('record')
      }
    return NextResponse.json({ ok: true })
  },
});
