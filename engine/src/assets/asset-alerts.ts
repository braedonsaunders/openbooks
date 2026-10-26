import { sql } from "drizzle-orm";
import { db, withBypassContext, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";

/**
 * Notifications for fixed-asset alerts (maintenance due and overdue,
 * insurance renewals). They land in the shared notifications table, so they
 * surface in Notifications and the Inbox with no extra plumbing. Recipients
 * are active users who hold the duty permission and can see the asset's
 * legal entity; an identical unread notice is never written twice.
 */
export async function notifyAssetOperators(
  tx: SqlExecutor,
  args: {
    orgId: string;
    subsidiaryId: string;
    permission: string;
    kind: string;
    title: string;
    body: string;
    href: string;
  },
): Promise<number> {
  const users = await tx.execute<{ id: string }>(
    sql`
    select id::text as id from users where org_id = ${args.orgId} and is_active order by id`,
    "objects",
  );
  let written = 0;
  for (const user of users) {
    if (!(await actorHasPermission(tx, args.orgId, user.id, args.permission))) continue;
    const allowed = await actorAllowedSubsidiaryIds(tx, args.orgId, user.id);
    if (allowed && !allowed.has(args.subsidiaryId)) continue;
    const unread = (
      await tx.execute(
        sql`
      select 1 from notifications
       where org_id = ${args.orgId} and user_id = ${user.id}::uuid and kind = ${args.kind}
         and title = ${args.title} and read_at is null
       limit 1`,
        "objects",
      )
    )[0];
    if (unread) continue;
    const inserted = (
      await tx.execute<{ id: string }>(
        sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${args.orgId}, ${user.id}::uuid, ${args.kind}, ${args.title}, ${args.body}, ${args.href})
      returning id`,
        "objects",
      )
    )[0];
    if (!inserted)
      throw new Error("the asset alert notification was not stored; no row was written");
    written += 1;
  }
  return written;
}

/** Organizations with a fixed-asset depth feature switched on (and Fixed Assets not switched off). */
export async function orgsWithAssetFeature(
  feature: "assetMaintenance" | "assetInsurance" | "assetProposals",
): Promise<string[]> {
  // bypass: scheduler-tick — list the organizations whose asset alert feature is on.
  return withBypassContext(async () =>
    (
      await db.execute<{ id: string }>(
        sql`
    select id::text as id from orgs
     where case (settings->'features'->>${feature}) when 'true' then true else false end
       and case (settings->'features'->>'fixedAssets') when 'false' then false else true end
     order by id`,
        "objects",
      )
    ).map((row) => row.id),
  );
}
