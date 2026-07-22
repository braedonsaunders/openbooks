import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  sealCredentials,
  syncBankFeedNow,
  testBankFeedConnection,
} from "@openbooks/engine/src/bank-feed-providers.ts";
import { requirePermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

async function owned(orgId: string, id: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from bank_feed_connections where id = ${id} and org_id = ${orgId}`,
  )) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("admin.setup.manage");
  const { id } = await params;
  if (!(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets = [];
  if ("name" in body) sets.push(sql`name = ${body.name as string}`);
  if ("externalAccountId" in body) sets.push(sql`external_account_id = ${(body.externalAccountId as string | null) ?? null}`);
  if ("syncCadence" in body) sets.push(sql`sync_cadence = ${body.syncCadence as string}`);
  if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
  // Only re-seal when a fresh credentials object is supplied (never on absence).
  if (body.credentials && typeof body.credentials === "object") {
    sets.push(sql`credentials = ${sealCredentials(body.credentials as Record<string, string>)}`);
    sets.push(sql`status = 'pending'`);
  }
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await db.execute(sql`
    update bank_feed_connections set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
     where id = ${id} and org_id = ${authz.user.orgId}
  `);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("admin.setup.manage");
  const { id } = await params;
  await db.execute(sql`delete from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}`);
  return NextResponse.json({ ok: true });
}

/** Actions: { action: "test" | "sync" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission("admin.setup.manage");
  const { id } = await params;
  if (!(await owned(authz.user.orgId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "test") {
    const result = await testBankFeedConnection(id);
    // Reflect the probe result on the row so the list shows connection health.
    await db.execute(sql`
      update bank_feed_connections set status = ${result.ok ? "connected" : "error"},
             last_error = ${result.ok ? null : result.detail ?? "test failed"}, updated_at = now()
       where id = ${id} and org_id = ${authz.user.orgId}
    `);
    return NextResponse.json(result);
  }
  if (body.action === "sync") {
    const outcome = await syncBankFeedNow(id);
    return NextResponse.json(outcome, { status: outcome.error ? 422 : 200 });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
