import "server-only";
import { sql } from "drizzle-orm";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import { db } from "@openbooks/engine/platform/db";
import { QUICK_APPROVAL_FLOW_DESCRIPTION } from "@openbooks/engine/flows/module";

/** The quick-approval setup state for one subject kind: its flow (if any) and the approver choices. */
export async function readQuickApprovalSetup(orgId: string, subjectKind: string) {
  const [flowRes, usersRes, rolesRes, subsidiariesRes] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`
      select id, name, enabled, graph, ${documentRevisionSql(sql`updated_at`)} as updated_at
        from flows
       where org_id = ${orgId} and subject_kind = ${subjectKind}
         and description = ${QUICK_APPROVAL_FLOW_DESCRIPTION}
       order by updated_at desc limit 1`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
      select id, name, email from users
       where org_id = ${orgId} and is_active
       order by name`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
      select key, name from app_roles
       where org_id = ${orgId}
       order by name`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
      select id, name from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination
       order by name`,
      "objects",
    ),
  ]);
  return {
    flow: flowRes[0] ?? null,
    users: usersRes,
    roles: rolesRes,
    subsidiaries: subsidiariesRes,
  };
}

/** Active user ids in the organization — the approvers a quick flow may name. */
export async function activeUserIds(orgId: string): Promise<Set<string>> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from users where org_id = ${orgId} and is_active`,
    "objects",
  );
  return new Set(rows.map((row) => String(row.id)));
}

/** Insert the enabled quick-approval flow and its audit row in one transaction. */
export async function insertQuickApprovalFlow(input: {
  orgId: string;
  actorId: string;
  name: string;
  subjectKind: string;
  graph: unknown;
  requestId: string | null;
}): Promise<string> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`
      insert into flows (org_id, name, description, subject_kind, enabled, graph, created_by, updated_by)
      values (${input.orgId}, ${input.name}, ${QUICK_APPROVAL_FLOW_DESCRIPTION}, ${input.subjectKind}, true,
              ${JSON.stringify(input.graph)}::jsonb, ${input.actorId}, ${input.actorId})
      returning *`,
      "objects",
    );
    const created = r[0]!;
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${input.orgId}, 'flows', ${created.id}, 'insert',
         ${JSON.stringify({ after: created })}::jsonb,
         ${input.actorId}, ${input.requestId})`);
    return created.id;
  });
}
