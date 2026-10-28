import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import type { Authz } from "../authz";

export class AccountGroupPinError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AccountGroupPinError";
    this.status = status;
  }
}

async function withVisibleAccount<T>(
  authz: Authz,
  groupId: string,
  accountId: string,
  use: (tx: SqlExecutor, dimension: string) => Promise<T>,
): Promise<T> {
  const group = await db.execute<{ dimension: string }>(
    sql`
    select dimension from account_groups where id = ${groupId} and org_id = ${authz.user.orgId}
  `,
    "objects",
  );
  const dimension = group[0]?.dimension;
  if (!dimension) throw new AccountGroupPinError("record not found", 404);
  const pinLockKey = `account-group-pin:${authz.user.orgId}:${dimension}:${accountId}`;
  return db.transaction(async (tx) => {
    let account: { subsidiaryId: string | null };
    try {
      account = await lockScopeRow(
        tx,
        authz.user.orgId,
        "account",
        accountId,
        authz.allowedSubsidiaryIds,
        "share",
        { orgWideNull: true },
      );
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        throw new AccountGroupPinError("record not found", 404);
      throw error;
    }
    if (account.subsidiaryId === null && authz.allowedSubsidiaryIds !== null)
      throw new AccountGroupPinError("requires unrestricted subsidiary access", 403);
    if (
      account.subsidiaryId !== null &&
      authz.allowedSubsidiaryIds !== null &&
      !authz.allowedSubsidiaryIds.has(account.subsidiaryId)
    ) {
      throw new AccountGroupPinError("record not found", 404);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${pinLockKey}, 0))`);
    return use(tx, dimension);
  });
}

/** Pin one account to a group, moving an existing pin within the dimension. */
export async function pinAccountToGroup(
  authz: Authz,
  groupId: string,
  accountId: string,
): Promise<void> {
  await withVisibleAccount(authz, groupId, accountId, async (tx, dimension) => {
    await tx.execute(sql`
      delete from account_group_members m using account_groups g
       where m.group_id = g.id and g.org_id = ${authz.user.orgId}
         and m.org_id = ${authz.user.orgId}
         and g.dimension = ${dimension} and m.account_id = ${accountId}
    `);
    const inserted = await tx.execute<{ account_id: string }>(
      sql`
      insert into account_group_members (org_id, group_id, account_id, dimension, created_by)
      values (${authz.user.orgId}, ${groupId}, ${accountId}, ${dimension}, ${authz.user.id})
      on conflict (org_id, dimension, account_id) do update
        set group_id = excluded.group_id, updated_at = now(), updated_by = excluded.created_by
      returning account_id
    `,
      "objects",
    );
    if (inserted.length !== 1) throw new Error("Account group pin was not saved.");
  });
}

/** Remove an existing pin; an already-unpinned account is a safe no-op. */
export async function unpinAccountFromGroup(
  authz: Authz,
  groupId: string,
  accountId: string,
): Promise<boolean> {
  return withVisibleAccount(authz, groupId, accountId, async (tx) => {
    const deleted = await tx.execute<{ account_id: string }>(
      sql`
      delete from account_group_members
       where group_id = ${groupId} and org_id = ${authz.user.orgId} and account_id = ${accountId}
      returning account_id
    `,
      "objects",
    );
    return deleted.length === 1;
  });
}
