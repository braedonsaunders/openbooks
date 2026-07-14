import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "../../../lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { name, path, params } = (await req.json()) as { name?: string; path?: string; params?: Record<string, string> };
  if (!name || !path || !path.startsWith("/reports")) {
    return NextResponse.json({ error: "name and a /reports path required" }, { status: 400 });
  }
  await db.execute(sql`
    insert into saved_reports (org_id, name, path, params, created_by_user_id)
    values (${user.orgId}, ${name}, ${path}, ${JSON.stringify(params ?? {})}, ${user.id})`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db.execute(sql`delete from saved_reports where id = ${id} and org_id = ${user.orgId}`);
  return NextResponse.json({ ok: true });
}
