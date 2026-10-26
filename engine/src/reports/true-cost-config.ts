import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";

export async function loadTrueCostConfig(orgId: string): Promise<unknown> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<{ cfg: unknown }>(
        sql`
      select settings -> 'analytics' -> 'trueCost' as cfg
        from orgs where id = ${orgId}
    `,
        "objects",
      );
      return rows[0]?.cfg ?? null;
    },
    { readOnly: true },
  );
}

export async function saveTrueCostConfig(input: {
  orgId: string;
  actorId: string;
  expectedRevision: number;
  config: Record<string, unknown>;
}): Promise<boolean> {
  return withOrgTransaction(input.orgId, async () => {
    const updated = await db.execute<{ revision: string }>(
      sql`
      with before_cfg as (
        select settings -> 'analytics' -> 'trueCost' as cfg from orgs where id = ${input.orgId}
      ),
      updated as (
        update orgs
        set settings = jsonb_set(
          jsonb_set(settings, '{analytics}', coalesce(settings -> 'analytics', '{}'::jsonb), true),
          '{analytics,trueCost}', ${JSON.stringify(input.config)}::jsonb, true)
        where id = ${input.orgId}
          and coalesce(settings -> 'analytics' -> 'trueCost' ->> 'revision', '0') = ${String(input.expectedRevision)}
        returning settings -> 'analytics' -> 'trueCost' ->> 'revision' as revision
      ),
      audited as (
        insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
        select ${input.orgId}, 'orgs', ${input.orgId}, 'update', ${input.actorId},
          jsonb_build_object('before', (select cfg from before_cfg), 'after', ${JSON.stringify(input.config)}::jsonb,
            'reason', 'True Cost configuration saved')
        from updated
      )
      select revision from updated
    `,
      "objects",
    );
    return updated.length > 0;
  });
}
