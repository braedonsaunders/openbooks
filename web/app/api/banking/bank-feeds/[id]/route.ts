import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
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
import { isUuid } from "../../../../../lib/list-params";
import type { Authz } from "../../../../../lib/authz";
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ action: z.enum(['test', 'sync']) });

const PATCHBodySchema1 = z.object({
  credentials: z.record(z.string(), z.string()).nullable().optional(), externalAccountId: z.string().nullable().optional(),
  isActive: z.boolean().optional(), name: z.string().trim().min(1).optional(),
  syncCadence: z.enum(['manual', 'hourly', 'daily']).optional(), syncOverlapDays: z.number().int().min(0).max(90).nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });



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
  lockConnection = true,
): Promise<Record<string, unknown> | NextResponse> {
  const reference = (await tx.execute<{ account_id: string }>(sql`
    select account_id from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
  `)).rows[0];
  if (!reference) return notFound("record");
  try {
    await lockScopeRow(tx, authz.user.orgId, "account", reference.account_id, authz.allowedSubsidiaryIds, "share");
  } catch (error) {
    if (!(error instanceof ScopeNotFoundError)) throw error;
    return notFound("record");
  }
  const connection = (await tx.execute<Record<string, unknown>>(sql`
    select * from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId} and account_id = ${reference.account_id}
     ${lockConnection ? sql`for update` : sql``}
  `)).rows[0];
  return connection ?? notFound("record");
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

export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'bankFeeds',
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
        return notFound("record");
      }

    const body = (routeBody) as Record<string, unknown>;
    if ("name" in body && (typeof body.name !== "string" || !body.name.trim())) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
    if ("syncCadence" in body && !CADENCES.includes(body.syncCadence as (typeof CADENCES)[number])) {
        return NextResponse.json({ error: "invalid syncCadence" }, { status: 400 });
      }
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
    const rotating = Boolean(body.credentials && typeof body.credentials === "object");
    if (rotating) {
        sets.push(sql`credentials = ${sealCredentials(authz.user.orgId, body.credentials as Record<string, string>)}`);
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
  },
});

export const DELETE = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'bankFeeds',
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
        return notFound("record");
      }
    const missing = await db.transaction(async (tx) => {
        const before = await lockScopedConnection(tx, authz, id);
        if (before instanceof NextResponse) return before;
        const deleted = (await tx.execute<{ id: string }>(sql`
          delete from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
           returning id
        `));
        if (!deleted.rows[0]) return notFound("record");
        await audit(tx, authz.user.orgId, id, "delete", {
          before: withoutCredentials(before),
        }, authz.user.id, req.headers.get("X-Request-Id"));
        return null;
      });
    if (missing) return missing;
    return NextResponse.json({ ok: true });
  },
});

/** Actions: { action: "test" | "sync" }. */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'bankFeeds',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) {
        return notFound("record");
      }

    const body = (routeBody) as { action?: string };
    if (body.action === "test") {
        const resultOrDenied = await db.transaction(async (tx) => {
          // Snapshot under scope, holding the account lock across the probe so a
          // rehome cannot leak connection health — but not the connection row: a
          // concurrent rotation or deletion must win, and the compare-and-swap
          // below turns the loser into a named 409 instead of deadlocking it.
          const existing = await lockScopedConnection(tx, authz, id, false);
          if (existing instanceof NextResponse) return existing;
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
            const current = (await tx.execute<{ id: string }>(sql`
              select id from bank_feed_connections where id = ${id} and org_id = ${authz.user.orgId}
            `)).rows[0];
            return NextResponse.json(
              { error: current ? "stale probe" : "deleted while testing" },
              { status: 409 },
            );
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
  },
});
