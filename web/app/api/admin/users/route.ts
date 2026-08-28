import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import {
  db,
  type SqlExecutor,
  withOrgTransaction,
} from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Admin user management: assign/unassign roles, toggle active.
 * Gated by admin.users.manage; every mutation is org-scoped and audited.
 */

async function audit(
  exec: SqlExecutor,
  args: {
    orgId: string;
    tableName: string;
    rowId: string;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
    actorId: string;
  },
) {
  await exec.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.tableName}, ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

export async function POST(req: Request) {
  const gate = await guardPermission("admin.users.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    action?: "assign" | "unassign" | "set-active";
    userId?: string;
    roleId?: string;
    isActive?: boolean;
  };
  if (!body.userId || !isUuid(body.userId)) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const userId = body.userId;

  const target = await db.execute(sql`
    select id from users where id = ${body.userId} and org_id = ${actor.orgId}`);
  if (!target.rows[0])
    return NextResponse.json({ error: "user not found" }, { status: 404 });

  switch (body.action) {
    case "assign": {
      if (!body.roleId || !isUuid(body.roleId)) {
        return NextResponse.json({ error: "roleId required" }, { status: 400 });
      }
      const role = await db.execute(sql`
        select id, key from app_roles where id = ${body.roleId} and org_id = ${actor.orgId}`);
      if (!role.rows[0])
        return NextResponse.json({ error: "role not found" }, { status: 404 });
      return withOrgTransaction(actor.orgId, async () => {
        const inserted = (await db.execute(sql`
          insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
          values (${actor.orgId}, ${body.userId}, ${body.roleId}, ${actor.id}, ${actor.id})
          on conflict (org_id, user_id, role_id) do nothing
          returning id`)) as any;
        if (inserted.rows[0]) {
          await audit(db, {
            orgId: actor.orgId,
            tableName: "role_assignments",
            rowId: inserted.rows[0].id,
            action: "insert",
            changes: {
              userId: [null, body.userId],
              roleId: [null, body.roleId],
            },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      });
    }
    case "unassign": {
      if (!body.roleId || !isUuid(body.roleId)) {
        return NextResponse.json({ error: "roleId required" }, { status: 400 });
      }
      return withOrgTransaction(actor.orgId, async () => {
        await db.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`openbooks:user-roles:${actor.orgId}:${body.userId}`}, 0))
        `);
        const assignments = await db.execute<{
          id: string;
          role_id: string;
        }>(sql`
          select id, role_id from role_assignments
           where org_id = ${actor.orgId} and user_id = ${body.userId}
           order by id
        `);
        if (!assignments.rows.some((row) => row.role_id === body.roleId)) {
          return NextResponse.json({ ok: true });
        }
        if (assignments.rows.length === 1) {
          return NextResponse.json(
            { error: "an active user must retain at least one role" },
            { status: 409 },
          );
        }
        const deleted = await db.execute<{ id: string }>(sql`
          delete from role_assignments
           where org_id = ${actor.orgId} and user_id = ${body.userId} and role_id = ${body.roleId}
          returning id
        `);
        if (deleted.rows[0]) {
          await audit(db, {
            orgId: actor.orgId,
            tableName: "role_assignments",
            rowId: deleted.rows[0].id,
            action: "delete",
            changes: {
              userId: [body.userId, null],
              roleId: [body.roleId, null],
            },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      });
    }
    case "set-active": {
      if (typeof body.isActive !== "boolean") {
        return NextResponse.json(
          { error: "isActive required" },
          { status: 400 },
        );
      }
      if (body.userId === actor.id && !body.isActive) {
        return NextResponse.json(
          { error: "you cannot deactivate your own account" },
          { status: 400 },
        );
      }
      return withOrgTransaction(actor.orgId, async () => {
        if (body.isActive) {
          const assignment = await db.execute<{ "?column?": number }>(sql`
            select 1
              from role_assignments
             where org_id = ${actor.orgId} and user_id = ${body.userId}
             limit 1
          `);
          if (!assignment.rows[0]) {
            return NextResponse.json(
              { error: "assign at least one role before activating this user" },
              { status: 409 },
            );
          }
        }
        const updated = await db.execute(sql`
          with changed_identity as (
            update users set is_active = ${body.isActive}, updated_at = now(), updated_by = ${actor.id}
             where id = ${body.userId} and org_id = ${actor.orgId} and is_active <> ${body.isActive}
            returning id
          ), revoked_sessions as (
            update auth_sessions
               set revoked_at = now(), revocation_reason = 'account_deactivated'
             where ${!body.isActive}
               and user_id in (select id from changed_identity)
               and revoked_at is null
            returning id
          )
          select id from changed_identity
        `);
        if (updated.rows[0]) {
          // Session revocation is in the same SQL statement as deactivation, so
          // a later reactivation cannot revive pre-disable browser sessions.
          await audit(db, {
            orgId: actor.orgId,
            tableName: "users",
            rowId: userId,
            action: "update",
            changes: { isActive: [!body.isActive, body.isActive] },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
