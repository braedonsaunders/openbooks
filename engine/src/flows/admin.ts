import { sql } from "drizzle-orm";
import { documentRevisionSql } from "../records/revision.ts";
import { db } from "../platform/db.ts";

export interface AdminFlowRunSummary {
  flowId: string;
  status: string;
  startedAt: Date;
  kind: string;
  id: string;
}

export async function listAdminFlows(orgId: string): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    sql`
    select f.id, f.name, f.description, f.subject_kind, f.enabled, ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
           jsonb_array_length(f.graph->'nodes') as node_count,
           (select count(*) from flow_runs r where r.flow_id = f.id and r.org_id = f.org_id) as run_count,
           lr.status as last_run_status, lr.started_at as last_run_at
      from flows f
      left join lateral (
        select status, started_at from flow_runs r
         where r.flow_id = f.id and r.org_id = f.org_id order by r.started_at desc limit 1
      ) lr on true
     where f.org_id = ${orgId}
     order by f.name
  `,
    "objects",
  );
}

export async function listAdminFlowsForRestrictedScope(orgId: string): Promise<{
  flows: Record<string, unknown>[];
  runs: { rows: AdminFlowRunSummary[] };
}> {
  const [flows, runs] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`
      select f.id, f.name, f.description, f.subject_kind, f.enabled,
             ${documentRevisionSql(sql`f.updated_at`)} as updated_at,
             jsonb_array_length(f.graph->'nodes') as node_count
        from flows f
       where f.org_id = ${orgId}
       order by f.name
    `,
      "objects",
    ),
    db.execute<AdminFlowRunSummary>(sql`
      select flow_id as "flowId", status, started_at as "startedAt",
             subject_kind as kind, subject_id as id
        from flow_runs
       where org_id = ${orgId}
    `),
  ]);
  return { flows, runs };
}

export async function createAdminFlow(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  name: string;
  subjectKind: string;
  enabled: boolean;
  graph: unknown;
}): Promise<string> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`
      insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
      values (${args.orgId}, ${args.name}, ${args.subjectKind}, ${args.enabled},
              ${JSON.stringify(args.graph)}::jsonb, ${args.actorId}, ${args.actorId})
      returning *
    `,
      "objects",
    );
    const created = r[0]!;
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${args.orgId}, 'flows', ${created.id}, 'insert',
         ${JSON.stringify({ after: created })}::jsonb,
         ${args.actorId}, ${args.requestId})
    `);
    return created.id;
  });
}
