import { sql } from "drizzle-orm";
import { type db } from "@openbooks/engine/src/platform/db.ts";

/** `db.transaction`'s handle — `SqlExecutor` is the pool `execute` and is not assignable from `tx`. */
export type ListViewDefaultExecutor = Pick<
  Parameters<Parameters<typeof db.transaction>[0]>[0],
  "execute"
>;

/**
 * Exclusive default for one list-view scope.
 *
 * One org default per (org, recordType). One personal default per
 * (org, owner, recordType). Concurrent POST/PATCH promotions used to
 * unset zero siblings and both persist is_default=true; the advisory
 * lock serializes the unset+write, and the post-write count refuses a
 * leftover pair so the save cannot report ok for overlapping defaults.
 */

export function listViewDefaultLockKey(args: {
  orgId: string;
  recordType: string;
  scope: "org" | "user";
  ownerId: string | null;
}): string {
  if (args.scope === "org") return `list-view-default:${args.orgId}:org:${args.recordType}`;
  if (!args.ownerId) throw new Error("user-scope default lock requires ownerId");
  return `list-view-default:${args.orgId}:user:${args.ownerId}:${args.recordType}`;
}

export class AmbiguousListViewDefaultError extends Error {
  constructor() {
    super(
      "More than one default view is stored for this scope. Clear the extra default and save again.",
    );
    this.name = "AmbiguousListViewDefaultError";
  }
}

type ListViewDefaultScope = {
  orgId: string;
  recordType: string;
  scope: "org" | "user";
  ownerId: string | null;
  exceptId?: string;
};

export async function lockListViewDefaultScope(
  tx: ListViewDefaultExecutor,
  args: ListViewDefaultScope,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${listViewDefaultLockKey(args)}, 0))`,
  );
}

export async function clearSiblingListViewDefaults(
  tx: ListViewDefaultExecutor,
  args: ListViewDefaultScope,
): Promise<void> {
  const except = args.exceptId ? sql`and id <> ${args.exceptId}` : sql``;
  if (args.scope === "org") {
    await tx.execute(sql`
      update list_views set is_default = false, updated_at = now()
       where org_id = ${args.orgId} and record_type = ${args.recordType}
         and scope = 'org' and is_default ${except}`);
    return;
  }
  await tx.execute(sql`
    update list_views set is_default = false, updated_at = now()
     where org_id = ${args.orgId} and record_type = ${args.recordType}
       and scope = 'user' and owner_id = ${args.ownerId} and is_default ${except}`);
}

export async function claimListViewDefaultSlot(
  tx: ListViewDefaultExecutor,
  args: ListViewDefaultScope,
): Promise<void> {
  await lockListViewDefaultScope(tx, args);
  await clearSiblingListViewDefaults(tx, args);
}

export async function assertSingleListViewDefault(
  tx: ListViewDefaultExecutor,
  args: {
    orgId: string;
    recordType: string;
    scope: "org" | "user";
    ownerId: string | null;
  },
): Promise<void> {
  const counted = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
      from list_views
     where org_id = ${args.orgId}
       and record_type = ${args.recordType}
       and scope = ${args.scope}
       and is_default
       and (scope = 'org' or owner_id = ${args.ownerId})`);
  if ((counted.rows[0]?.n ?? 0) > 1) throw new AmbiguousListViewDefaultError();
}
