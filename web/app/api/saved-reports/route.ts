import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../lib/authz";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("reports.create");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const { name, path, params } = (parsedBody.data) as { name?: string; path?: string; params?: Record<string, string> };
  if (!name || !path || !path.startsWith("/reports")) {
    return NextResponse.json({ error: "name and a /reports path required" }, { status: 400 });
  }
  await db.execute(sql`
    insert into saved_reports (org_id, name, path, params, created_by_user_id)
    values (${user.orgId}, ${name}, ${path}, ${JSON.stringify(params ?? {})}, ${user.id})`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const gate = await guardPermission("reports.create");
  if (gate instanceof NextResponse) return gate;
  const { user, permissions } = gate;
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const { id } = (parsedBody2.data) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const deleted = await db.execute<{ id: string }>(sql`
    delete from saved_reports
     where id = ${id}
       and org_id = ${user.orgId}
       and (${permissions.has("*")} or created_by_user_id = ${user.id})
     returning id`);
  if (!deleted.rows[0]) {
    return NextResponse.json({ error: "You can only delete your own saved reports." }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
