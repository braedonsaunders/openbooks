import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

export const runtime = "nodejs";

/**
 * Users + roles in the org, for the sharing principal picker. Gated by
 * documents.read (a Manager may not be an org admin, so this avoids the
 * admin-only user/role APIs) and returns only id + display name.
 */
export const GET = defineRoute({
  permission: "documents.read",
  feature: {
    none: "This documents surface is governed by its permission and has no separate organization feature switch.",
  },
  handler: async ({ authz: gate }) => {
    const orgId = gate.user.orgId;

    const [users, roles] = await Promise.all([
      db.execute(sql`
      select id, coalesce(name, email) as name from users
       where org_id = ${orgId} and is_active order by coalesce(name, email)
    `, "objects"),
      db.execute(sql`
      select id, name from app_roles where org_id = ${orgId} order by name
    `, "objects"),
    ]);
    return NextResponse.json({
      users: users as { id: string; name: string }[],
      roles: roles as { id: string; name: string }[],
    });
  },
});
