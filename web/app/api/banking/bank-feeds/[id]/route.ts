import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  sealCredentials,
  syncBankFeedNow,
  testBankFeedConnection,
} from "@openbooks/engine/src/bank-feed-providers.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";

export const runtime = "nodejs";

/** Audit-safe projection: sealed credentials never enter the trail — presence only. */
function withoutCredentials(row: Record<string, unknown>): Record<string, unknown> {
  const { credentials, ...rest } = row;
  return { ...rest, hasCredentials: credentials != null };
}

async function loadRow(orgId: string, id: string): Promise<Record<string, unknown> | null> {
  const r = (await db.execute<Record<string, unknown>>(sql`
    select * from bank_feed_connections where id = ${id} and org_id = ${orgId}
  `));
  return r.rows[0] ?? null;
}

async function audit(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  rowId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string,
  requestId: string | null,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values
      (${orgId}, 'bank_feed_connections', ${rowId}, ${action},
       ${JSON.stringify(changes)}::jsonb, ${actorId}, ${requestId})
  `);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  const before = await loadRow(authz.user.orgId, id);
  if (!before) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: ReturnType<typeof sql>[] = [];
  if ("name" in body) sets.push(sql`name = ${body.name as string}`);
  if ("externalAccountId" in body) sets.push(sql`external_account_id = ${(body.externalAccountId as string | null) ?? null}`);
  if ("syncCadence" in body) sets.push(sql`sync_cadence = ${body.syncCadence as string}`);
  if ("isActive" in body) sets.push(sql`is_active = ${Boolean(body.isActive)}`);
  // Only re-seal when a fresh credentials object is supplied (never on absence).
  const rotating = Boolean(body.credentials && typeof body.credentials === "object");
  if (rotating) {
    sets.push(sql`credentials = ${sealCredentials(body.credentials as Record<string, string>)}`);
    sets.push(sql`status = 'pending'`);
  }
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await db.transaction(async (tx) => {
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update bank_feed_connections set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${authz.user.id}
       where id = ${id} and org_id = ${authz.user.orgId}
       returning *
    `));
    if (!updated.rows[0]) throw new Error("bank_feed_connection_changed");
    await audit(tx, authz.user.orgId, id, "update", {
      before: withoutCredentials(before),
      after: withoutCredentials(updated.rows[0]),
      ...(rotating ? { credentialsRotated: true } : {}),
    }, authz.user.id, req.headers.get("X-Request-Id"));
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
    `));
    const deleted = (await tx.execute<{ id: string }>(sql`
      delete from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
       returning id
    `));
    if (!before.rows[0] || !deleted.rows[0]) return;
    await audit(tx, authz.user.orgId, id, "delete", {
      before: withoutCredentials(before.rows[0]),
    }, authz.user.id, req.headers.get("X-Request-Id"));
  });
  return NextResponse.json({ ok: true });
}

/** Actions: { action: "test" | "sync" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  const existing = await loadRow(authz.user.orgId, id);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "test") {
    const result = await testBankFeedConnection(id, { orgId: authz.user.orgId });
    // Reflect the probe result on the row so the list shows connection health,
    // and record the flip in the append-only audit trail.
    const nextStatus = result.ok ? "connected" : "error";
    const nextError = result.ok ? null : result.detail ?? "test failed";
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update bank_feed_connections set status = ${nextStatus},
               last_error = ${nextError}, updated_at = now()
         where id = ${id} and org_id = ${authz.user.orgId}
      `);
      await audit(tx, authz.user.orgId, id, "update", {
        field: "status",
        before: {
          status: existing.status,
          lastError: existing.last_error ?? null,
          hasCredentials: existing.credentials != null,
        },
        after: {
          status: nextStatus,
          lastError: nextError,
          hasCredentials: existing.credentials != null,
        },
        source: "connection_test",
      }, authz.user.id, req.headers.get("X-Request-Id"));
    });
    return NextResponse.json(result);
  }
  if (body.action === "sync") {
    const outcome = await syncBankFeedNow(id, { orgId: authz.user.orgId });
    return NextResponse.json(outcome, { status: outcome.error ? 422 : 200 });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
