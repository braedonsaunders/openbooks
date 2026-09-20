import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/src/platform/db.ts";

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

export async function claimListViewDefaultSlot(
  tx: SqlExecutor,
  args: {
    orgId: string;
    recordType: string;
    scope: "org" | "user";
    ownerId: string | null;
    exceptId?: string;
  },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${listViewDefaultLockKey(args)}, 0))`,
  );
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

export async function assertSingleListViewDefault(
  tx: SqlExecutor,
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
