import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { runScheduleNow } from "@openbooks/engine/src/recurring.ts";
import { requirePermission } from "../../../../lib/authz";

export const runtime = "nodejs";

async function owned(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from recurring_schedules where id = ${id} and org_id = ${orgId}`,
  )) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

/** Toggle active, edit cadence/dates, or rename a schedule. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  if (!(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets = [];
  if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
  if ("autoPost" in body) sets.push(sql`auto_post = ${Boolean(body.autoPost)}`);
  if ("nextRunOn" in body) sets.push(sql`next_run_on = ${body.nextRunOn as string}`);
  if ("endsOn" in body) sets.push(sql`ends_on = ${(body.endsOn as string | null) ?? null}`);
  if ("name" in body) sets.push(sql`name = ${(body.name as string | null) ?? null}`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await db.execute(sql`
    update recurring_schedules set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
     where id = ${id} and org_id = ${authz.user.orgId}
  `);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  await db.execute(
    sql`delete from recurring_schedules where id = ${id} and org_id = ${authz.user.orgId}`,
  );
  return NextResponse.json({ ok: true });
}

/** Run now — force-generate a document from the template immediately. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("documents.manage");
  const { id } = await params;
  if (!(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const gen = await runScheduleNow(id);
    return NextResponse.json(gen);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "generation failed" },
      { status: 422 },
    );
  }
}
