import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  resolveFeedSyncOverlapDays,
  sealCredentials,
  syncBankFeedNow,
  testBankFeedConnection,
} from "@openbooks/engine/src/banking/bank-feed-providers.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { isUuid } from "../../../../../lib/list-params";
import type { Authz } from "../../../../../lib/authz";

export const runtime = "nodejs";

const CADENCES = ["manual", "hourly", "daily"] as const;

/** Audit-safe projection: sealed credentials never enter the trail — presence only. */
function withoutCredentials(row: Record<string, unknown>): Record<string, unknown> {
  const { credentials, ...rest } = row;
  return { ...rest, hasCredentials: credentials != null };
}

/** Account first, then connection: account rehomes and feed operations share a fence. */
async function lockScopedConnection(
  tx: SqlExecutor,
  authz: Authz,
  id: string,
): Promise<Record<string, unknown> | NextResponse> {
  const reference = (await tx.execute<{ account_id: string }>(sql`
    select account_id from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
  `)).rows[0];
  if (!reference) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await lockScopeRow(tx, authz.user.orgId, "account", reference.account_id, authz.allowedSubsidiaryIds, "share");
  } catch (error) {
    if (!(error instanceof ScopeNotFoundError)) throw error;
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const connection = (await tx.execute<Record<string, unknown>>(sql`
    select * from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId} and account_id = ${reference.account_id}
     for update
  `)).rows[0];
  return connection ?? NextResponse.json({ error: "not found" }, { status: 404 });
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
  // A malformed id names nothing: same answer as a missing connection, never
  // a PostgreSQL uuid cast error escaping as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  // PATCH enforces the same field contracts as POST: a non-empty name and a
  // cadence inside the stored CHECK constraint, so invalid input is a 400
  // instead of an empty name or an unhandled constraint-violation 500.
  if ("name" in body && (typeof body.name !== "string" || !body.name.trim())) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if ("syncCadence" in body && !CADENCES.includes(body.syncCadence as (typeof CADENCES)[number])) {
    return NextResponse.json({ error: "invalid syncCadence" }, { status: 400 });
  }
  // Null clears a custom overlap back to the default; anything else must be
  // whole days in range, or the row would carry a window syncs cannot honor.
  if ("syncOverlapDays" in body && body.syncOverlapDays !== null) {
    try {
      resolveFeedSyncOverlapDays(body.syncOverlapDays);
    } catch {
      return NextResponse.json({ error: "syncOverlapDays must be a whole number of days from 0 to 90" }, { status: 400 });
    }
  }
  const sets: ReturnType<typeof sql>[] = [];
  if ("name" in body) sets.push(sql`name = ${body.name as string}`);
  if ("externalAccountId" in body) sets.push(sql`external_account_id = ${(body.externalAccountId as string | null) ?? null}`);
  if ("syncCadence" in body) sets.push(sql`sync_cadence = ${body.syncCadence as string}`);
  if ("syncOverlapDays" in body) sets.push(sql`sync_overlap_days = ${(body.syncOverlapDays as number | null) ?? null}`);
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    sets.push(sql`is_active = ${body.isActive}`);
  }
  // Only re-seal when a fresh credentials object is supplied (never on absence).
  const rotating = Boolean(body.credentials && typeof body.credentials === "object");
  if (rotating) {
    sets.push(sql`credentials = ${sealCredentials(body.credentials as Record<string, string>)}`);
    sets.push(sql`status = 'pending'`);
  }
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const denied = await db.transaction(async (tx) => {
    const before = await lockScopedConnection(tx, authz, id);
    if (before instanceof NextResponse) return before;
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      /* updated_at is the scheduler's configuration revision: any route edit
       * invalidates a scan-time bank-feed snapshot before it can be claimed. */
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
    return null;
  });
  if (denied) return denied;
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const missing = await db.transaction(async (tx) => {
    const before = await lockScopedConnection(tx, authz, id);
    if (before instanceof NextResponse) return before;
    const deleted = (await tx.execute<{ id: string }>(sql`
      delete from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
       returning id
    `));
    if (!deleted.rows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
    await audit(tx, authz.user.orgId, id, "delete", {
      before: withoutCredentials(before),
    }, authz.user.id, req.headers.get("X-Request-Id"));
    return null;
  });
  if (missing) return missing;
  return NextResponse.json({ ok: true });
}

/** Actions: { action: "test" | "sync" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await guardFeaturePermission("admin.setup.manage", "bankFeeds");
  if (authz instanceof NextResponse) return authz;
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as { action?: string };
  if (body.action === "test") {
    const resultOrDenied = await db.transaction(async (tx) => {
      const existing = await lockScopedConnection(tx, authz, id);
      if (existing instanceof NextResponse) return existing;
      // Keep both scope locks from credential snapshot through probe and
      // status publication, so a rehome cannot leak connection health.
      const credentialRevision = existing.credentials as string | null;
      const result = await testBankFeedConnection(id, { orgId: authz.user.orgId }, credentialRevision);
      const nextStatus = result.ok ? "connected" : "error";
      const nextError = result.ok ? null : result.detail ?? "test failed";
      const updated = (await tx.execute<{ id: string }>(sql`
        update bank_feed_connections set status = ${nextStatus},
               last_error = ${nextError}, updated_at = now()
         where id = ${id} and org_id = ${authz.user.orgId}
           and credentials is not distinct from ${credentialRevision}
         returning id
      `)).rows[0];
      if (!updated) {
        return NextResponse.json({ error: "stale probe" }, { status: 409 });
      }
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
      return result;
    });
    return resultOrDenied instanceof NextResponse ? resultOrDenied : NextResponse.json(resultOrDenied);
  }
  if (body.action === "sync") {
    // Gate the connection's account exactly like PATCH, DELETE, and test:
    // without this, an out-of-scope id falls through to syncBankFeedNow,
    // which throws instead of answering the uniform 404.
    const scoped = await db.transaction(async (tx) => lockScopedConnection(tx, authz, id));
    if (scoped instanceof NextResponse) return scoped;
    // The interactive operator is the audit actor for everything this sync
    // imports; dropping user.id here would persist system provenance for a
    // human-triggered import.
    const outcome = await syncBankFeedNow(id, {
      orgId: authz.user.orgId,
      userId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json(outcome, { status: outcome.error ? 422 : 200 });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
