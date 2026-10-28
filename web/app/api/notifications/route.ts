import { notFound } from "@/lib/api/responses";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { getAuthz } from "../../../lib/authz";
import { isUuid } from "../../../lib/list-params";
import { markNotificationsReadForRoute } from "../../../lib/notification-mutations";
const PATCHBodySchema1 = z
  .object({
    ids: z.array(uuidString()).min(1).optional(),
    all: z.boolean().optional(),
  })
  .refine((body) => body.all === true || (body.ids !== undefined && body.ids.length > 0), {
    message: "ids or all is required",
  });

export const runtime = "nodejs";

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
  public: "session",
  handler: async (_) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id: userId, orgId } = authz.user;
    const [items, unread] = await Promise.all([
      db.execute<Record<string, unknown>>(
        sql`
          select id, kind, title, body, href, read_at as "readAt", created_at as "createdAt"
            from notifications
           where org_id = ${orgId} and user_id = ${userId}
           order by created_at desc
           limit 30`,
        "objects",
      ),
      db.execute<{ n: number }>(
        sql`
          select count(*)::int as n
            from notifications
           where org_id = ${orgId} and user_id = ${userId} and read_at is null`,
        "objects",
      ),
    ]);
    return NextResponse.json({ items, unread: unread[0]?.n ?? 0 });
  },
});

export const PATCH = defineRoute({
  public: "session",
  body: PATCHBodySchema1,
  handler: async ({ request: _req, body: routeBody }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id: userId, orgId } = authz.user;

    const body = routeBody as { ids?: string[]; all?: boolean };
    if (body.all === true) {
      await markNotificationsReadForRoute({ orgId, userId, all: true });
      return NextResponse.json({ ok: true });
    }
    const requested = Array.isArray(body.ids) ? body.ids.filter((id) => isUuid(id)) : [];
    const ids = [...new Set(requested)];
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids or all required" }, { status: 400 });
    }
    const { own } = await markNotificationsReadForRoute({ orgId, userId, ids });
    if (own < ids.length) {
      return notFound("record");
    }
    return NextResponse.json({ ok: true });
  },
});
