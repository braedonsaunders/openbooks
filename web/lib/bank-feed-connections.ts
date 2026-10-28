import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import {
  resolveFeedSyncOverlapDays,
  sealCredentials,
  testBankFeedConnection,
} from "@openbooks/engine/banking/bank-feed-providers";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/organization/scope";

export class BankFeedConnectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "BankFeedConnectionError";
  }
}

export function withoutCredentials(row: Record<string, unknown>): Record<string, unknown> {
  const { credentials, ...rest } = row;
  return { ...rest, hasCredentials: credentials != null };
}

export async function lockScopedBankFeedConnection(
  tx: SqlExecutor,
  authz: Authz,
  id: string,
  lockConnection = true,
): Promise<Record<string, unknown> | null> {
  const reference = (
    await tx.execute<{ account_id: string }>(
      sql`select account_id from bank_feed_connections where id=${id} and org_id=${authz.user.orgId}`,
      "objects",
    )
  )[0];
  if (!reference) return null;
  try {
    await lockScopeRow(
      tx,
      authz.user.orgId,
      "account",
      reference.account_id,
      authz.allowedSubsidiaryIds,
      "share",
    );
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return null;
    throw error;
  }
  return (
    (
      await tx.execute<Record<string, unknown>>(
        sql`select * from bank_feed_connections where id=${id} and org_id=${authz.user.orgId} and account_id=${reference.account_id} ${lockConnection ? sql`for update` : sql``}`,
        "objects",
      )
    )[0] ?? null
  );
}

export async function auditFeedChange(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  authz: Authz,
  id: string,
  action: string,
  changes: Record<string, unknown>,
  requestId: string | null,
) {
  await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${authz.user.orgId}, 'bank_feed_connections', ${id}, ${action}, ${JSON.stringify(changes)}::jsonb, ${authz.user.id}, ${requestId})`);
}

export type BankFeedPatch = {
  name?: string;
  externalAccountId?: string | null;
  syncCadence?: "manual" | "hourly" | "daily";
  syncOverlapDays?: number | null;
  isActive?: boolean;
  credentials?: Record<string, string> | null;
};

export async function updateBankFeedConnection(
  authz: Authz,
  id: string,
  body: BankFeedPatch,
  requestId: string | null,
): Promise<void> {
  if (body.name !== undefined && !body.name.trim())
    throw new BankFeedConnectionError("name is required");
  if (body.syncOverlapDays !== undefined && body.syncOverlapDays !== null) {
    try {
      resolveFeedSyncOverlapDays(body.syncOverlapDays);
    } catch {
      throw new BankFeedConnectionError(
        "syncOverlapDays must be a whole number of days from 0 to 90",
      );
    }
  }
  const sets: ReturnType<typeof sql>[] = [];
  if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
  if (body.externalAccountId !== undefined)
    sets.push(sql`external_account_id = ${body.externalAccountId ?? null}`);
  if (body.syncCadence !== undefined) sets.push(sql`sync_cadence = ${body.syncCadence}`);
  if (body.syncOverlapDays !== undefined)
    sets.push(sql`sync_overlap_days = ${body.syncOverlapDays ?? null}`);
  if (body.isActive !== undefined) sets.push(sql`is_active = ${body.isActive}`);
  const rotating = Boolean(body.credentials && typeof body.credentials === "object");
  if (rotating) {
    sets.push(sql`credentials = ${sealCredentials(authz.user.orgId, body.credentials!)}`);
    sets.push(sql`status = 'pending'`);
  }
  if (!sets.length) throw new BankFeedConnectionError("nothing to update");
  await db.transaction(async (tx) => {
    const before = await lockScopedBankFeedConnection(tx, authz, id);
    if (!before) throw new BankFeedConnectionError("record not found", 404);
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`
      update bank_feed_connections set ${sql.join(sets, sql`, `)}, updated_at=now(), updated_by=${authz.user.id}
       where id=${id} and org_id=${authz.user.orgId} returning *
    `,
        "objects",
      )
    )[0];
    if (!after) throw new Error("bank_feed_connection_changed");
    await auditFeedChange(
      tx,
      authz,
      id,
      "update",
      {
        before: withoutCredentials(before),
        after: withoutCredentials(after),
        ...(rotating ? { credentialsRotated: true } : {}),
      },
      requestId,
    );
  });
}

export async function deleteBankFeedConnection(
  authz: Authz,
  id: string,
  requestId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockScopedBankFeedConnection(tx, authz, id);
    if (!before) throw new BankFeedConnectionError("record not found", 404);
    const removed = (
      await tx.execute<{ id: string }>(
        sql`delete from bank_feed_connections where id=${id} and org_id=${authz.user.orgId} returning id`,
        "objects",
      )
    )[0];
    if (!removed) throw new BankFeedConnectionError("record not found", 404);
    await auditFeedChange(
      tx,
      authz,
      id,
      "delete",
      { before: withoutCredentials(before) },
      requestId,
    );
  });
}

export async function testBankFeedConnectionForActor(
  authz: Authz,
  id: string,
  requestId: string | null,
): Promise<{ ok: boolean; detail?: string }> {
  return db.transaction(async (tx) => {
    const existing = await lockScopedBankFeedConnection(tx, authz, id, false);
    if (!existing) throw new BankFeedConnectionError("record not found", 404);
    const credentialRevision = existing.credentials as string | null;
    const result = await testBankFeedConnection(
      id,
      { orgId: authz.user.orgId },
      credentialRevision,
    );
    const nextStatus = result.ok ? "connected" : "error";
    const nextError = result.ok ? null : (result.detail ?? "test failed");
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update bank_feed_connections set status=${nextStatus}, last_error=${nextError}, updated_at=now()
       where id=${id} and org_id=${authz.user.orgId} and credentials is not distinct from ${credentialRevision}
       returning id
    `,
        "objects",
      )
    )[0];
    if (!updated) {
      const current = (
        await tx.execute<{ id: string }>(
          sql`select id from bank_feed_connections where id=${id} and org_id=${authz.user.orgId}`,
          "objects",
        )
      )[0];
      throw new BankFeedConnectionError(current ? "stale probe" : "deleted while testing", 409);
    }
    await auditFeedChange(
      tx,
      authz,
      id,
      "update",
      {
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
      },
      requestId,
    );
    return result;
  });
}

export async function persistBankFeedConnection(
  authz: Authz,
  input: {
    name: string;
    provider: "manual" | "sftp" | "plaid" | "gocardless" | "truelayer";
    accountId: string;
    externalAccountId: string | null;
    syncCadence: "manual" | "hourly" | "daily";
    syncOverlapDays: number | null;
    credentials: Record<string, string> | null;
  },
  requestId: string | null,
): Promise<string> {
  const isApi =
    input.provider === "plaid" || input.provider === "gocardless" || input.provider === "truelayer";
  const sealed =
    isApi && input.credentials ? sealCredentials(authz.user.orgId, input.credentials) : null;
  const status = isApi ? "pending" : "connected";
  const cadence = isApi ? input.syncCadence : "manual";
  return db.transaction(async (tx) => {
    const created = await tx.execute<Record<string, unknown> & { id: string }>(
      sql`
      insert into bank_feed_connections (org_id, name, provider, account_id, external_account_id,
                                         sync_cadence, sync_overlap_days, credentials, status, created_by, updated_by)
      values (${authz.user.orgId}, ${input.name}, ${input.provider}, ${input.accountId},
              ${isApi ? input.externalAccountId : null}, ${cadence}, ${input.syncOverlapDays}, ${sealed}, ${status},
              ${authz.user.id}, ${authz.user.id})
      returning *
    `,
      "objects",
    );
    const row = created[0];
    if (!row) throw new Error("bank feed connection was not recorded");
    const { credentials: _credentials, ...safe } = row;
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${authz.user.orgId}, 'bank_feed_connections', ${row.id}, 'insert',
              ${JSON.stringify({ after: { ...safe, hasCredentials: row.credentials != null } })}::jsonb,
              ${authz.user.id}, ${requestId})
    `);
    return row.id;
  });
}
