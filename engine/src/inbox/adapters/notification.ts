/**
 * HR-15 notification adapter — unread notices as completable inbox items.
 *
 * Reads the notifications table (same self-scoped predicate as the
 * /notifications page and GET /api/notifications: org + user, unread).
 * The mark-read action runs the same conditional UPDATE as PATCH
 * /api/notifications — zero matched rows is a stale item (already read),
 * never success.
 *
 * Write rule for new alert sources (qualification expiry, automation
 * errors, feedback requests): WRITE a notifications row through
 * writeNotification below — the existing insert path (same columns as the
 * payments/close writers) — instead of inventing a new channel. The row
 * then surfaces in /notifications AND as an inbox item with zero extra
 * plumbing.
 */

import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../../platform/db.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";

export interface NotificationWrite {
  readonly orgId: string;
  readonly userId: string;
  readonly kind: string;
  readonly title: string;
  readonly body?: string | null;
  readonly href?: string | null;
  readonly actorId?: string | null;
}

/**
 * The one conditional mark-read UPDATE, shared by PATCH /api/notifications
 * and the inbox adapter below: org + user + unread + the named ids.
 *
 * Mark-read is idempotent, so the helper tells its cases apart: `flipped`
 * counts the rows this call marked, while `own` counts the caller's own
 * matching ids whether read or unread. Callers succeed when every
 * requested id is the caller's own (a replay over already-read rows flips
 * nothing and still succeeds) and refuse only when some id is foreign or
 * nonexistent — those match zero rows under the self-scoped predicate.
 */
export async function markNotificationsRead(
  exec: SqlExecutor,
  args: { orgId: string; userId: string; ids: readonly string[] },
): Promise<{ flipped: number; own: number }> {
  const flipped = await exec.execute<{ id: string }>(sql`
    update notifications set read_at = now(), updated_at = now()
     where org_id = ${args.orgId} and user_id = ${args.userId} and read_at is null
       and id in (select jsonb_array_elements_text(${JSON.stringify([...args.ids])}::jsonb)::uuid)
    returning id
  `);
  const own = (await exec.execute<{ n: number }>(sql`
    select count(*)::int as n from notifications
     where org_id = ${args.orgId} and user_id = ${args.userId}
       and id in (select jsonb_array_elements_text(${JSON.stringify([...args.ids])}::jsonb)::uuid)
  `)).rows[0];
  return { flipped: flipped.rows.length, own: own?.n ?? 0 };
}

/**
 * The existing notifications insert path, shared: every alert source
 * writes these columns, and every reader (page, API, inbox adapter)
 * scopes org + user + unread. One channel, many writers.
 */
export async function writeNotification(exec: SqlExecutor, write: NotificationWrite): Promise<string> {
  const id = (
    (await exec.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
      values (${write.orgId}, ${write.userId}, ${write.kind}, ${write.title},
              ${write.body ?? null}, ${write.href ?? null},
              ${write.actorId ?? null}, ${write.actorId ?? null})
      returning id
    `)).rows[0]
  )?.id;
  if (!id) throw new Error("the notice was not stored — no row was written; retry the action");
  return id;
}

type NoticeRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
};

export const notificationAdapter: InboxAdapter = {
  kind: "notification",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const rows = (await db.execute<NoticeRow>(sql`
      select id::text as id, kind, title, body, href, created_at::text as created_at
        from notifications
       where org_id = ${ctx.orgId} and user_id = ${ctx.actorId} and read_at is null
       order by created_at desc
       limit 30
    `)).rows;
    return rows.map((row) => ({
      id: inboxItemId("notification", row.id),
      kind: "notification",
      title: row.title,
      subtitle: row.body,
      dueAt: null,
      createdAt: new Date(row.created_at).toISOString(),
      priority: "normal" as const,
      subjectHref: row.href ?? "/notifications",
      actions: [{ key: "mark-read", label: "Mark read", style: "secondary" as const, needsReason: false }],
      source: { kind: "notification", id: row.id },
    }));
  },
  async act(ctx, sourceId, actionKey): Promise<void> {
    if (actionKey !== "mark-read") {
      throw new Error(`action ${JSON.stringify(actionKey)} is not available on this notice`);
    }
    const { flipped } = await markNotificationsRead(db, {
      orgId: ctx.orgId,
      userId: ctx.actorId,
      ids: [sourceId],
    });
    if (flipped !== 1) {
      throw new Error("the notice is already read — nothing marked; reload the inbox");
    }
  },
};
