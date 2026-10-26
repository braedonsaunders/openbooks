import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db } from "../platform/db.ts";
import { assertProductionEnvForScheduledScript } from "./scheduled-env.ts";
import { computeScheduledScriptNextRunAt } from "./scripting.ts";

export interface UserScriptWriteInput {
  name: string;
  triggerPoint: string;
  source: string;
  documentKind?: string | null;
  endpointSlug?: string | null;
  cron?: string | null;
  isActive?: boolean;
  timeoutMs?: number;
  sortOrder?: number;
}

export async function createUserScript(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  input: UserScriptWriteInput;
  nextRunAt: Date | null;
}): Promise<{ kind: "feature_disabled" } | { kind: "created"; row: Record<string, unknown> }> {
  const { orgId, actorId, requestId, input, nextRunAt } = args;
  return db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "scripts"))) return { kind: "feature_disabled" };
    const created = await tx.execute<Record<string, unknown>>(
      sql`
      insert into user_scripts (org_id, name, trigger_point, document_kind, endpoint_slug, source, cron, next_run_at, timeout_ms, sort_order, is_active,
                                run_as_user_id, created_by, updated_by)
      values (${orgId}, ${input.name}, ${input.triggerPoint}, ${input.documentKind ?? null}, ${input.endpointSlug ?? null}, ${input.source},
              ${input.cron ?? null}, ${nextRunAt}, ${input.timeoutMs ?? 2000}, ${input.sortOrder ?? 100}, ${input.isActive !== false},
              ${actorId}, ${actorId}, ${actorId})
      returning *
    `,
      "objects",
    );
    if (!created[0]) throw new Error("script insert returned no row");
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${orgId}, 'user_scripts', ${String(created[0].id)}, 'insert',
         ${JSON.stringify({ after: created[0] })}::jsonb,
         ${actorId}, ${requestId})
    `);
    return { kind: "created", row: created[0] };
  });
}

export async function updateUserScript(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  id: string;
  input: UserScriptWriteInput;
}): Promise<{ kind: "feature_disabled" | "missing" | "updated" }> {
  const { orgId, actorId, requestId, id, input } = args;
  return db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "scripts"))) return { kind: "feature_disabled" };
    const before = await tx.execute<Record<string, unknown>>(
      sql`
      select * from user_scripts where id = ${id} and org_id = ${orgId} for update
    `,
      "objects",
    );
    if (!before[0]) return { kind: "missing" };
    const cron = input.cron ?? null;
    const schedulingChanged =
      before[0].trigger_point !== input.triggerPoint ||
      before[0].cron !== cron ||
      before[0].is_active !== (input.isActive !== false);
    if (schedulingChanged && cron && input.isActive !== false) {
      await assertProductionEnvForScheduledScript(orgId);
    }
    const nextRunAt = schedulingChanged
      ? cron && input.isActive !== false
        ? computeScheduledScriptNextRunAt(cron)
        : null
      : sql`next_run_at`;
    const updated = await tx.execute<Record<string, unknown>>(
      sql`
      update user_scripts set
        name = ${input.name}, trigger_point = ${input.triggerPoint}, document_kind = ${input.documentKind ?? null},
        endpoint_slug = ${input.endpointSlug ?? null},
        source = ${input.source}, cron = ${cron}, next_run_at = ${nextRunAt},
        timeout_ms = ${input.timeoutMs ?? 2000},
        sort_order = ${input.sortOrder ?? 100}, is_active = ${input.isActive !== false},
        run_as_user_id = ${actorId}, updated_by = ${actorId}, updated_at = now()
      where id = ${id} and org_id = ${orgId}
      returning *
    `,
      "objects",
    );
    if (!updated[0]) throw new Error("script update matched no row after its lock");
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${orgId}, 'user_scripts', ${String(updated[0].id)}, 'update',
         ${JSON.stringify({ before: before[0], after: updated[0] })}::jsonb,
         ${actorId}, ${requestId})
    `);
    return { kind: "updated" };
  });
}

export async function deleteUserScript(args: {
  orgId: string;
  actorId: string;
  requestId: string | null;
  id: string;
}): Promise<{ kind: "feature_disabled" | "missing" | "history" | "deleted" }> {
  const { orgId, actorId, requestId, id } = args;
  return db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "scripts"))) return { kind: "feature_disabled" };
    const existing = await tx.execute<Record<string, unknown>>(
      sql`
      select * from user_scripts where id = ${id} and org_id = ${orgId} for update
    `,
      "objects",
    );
    if (!existing[0]) return { kind: "missing" };
    const history = await tx.execute(
      sql`
      select id from script_runs where script_id = ${id} and org_id = ${orgId} limit 1
    `,
      "objects",
    );
    if (history.length) return { kind: "history" };
    await tx.execute(sql`delete from user_scripts where id = ${id} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${orgId}, 'user_scripts', ${id}, 'delete',
         ${JSON.stringify({ before: existing[0] })}::jsonb, ${actorId}, ${requestId})
    `);
    return { kind: "deleted" };
  });
}

export interface ScheduledScriptForRun {
  trigger_point: string;
  cron: string | null;
  is_active: boolean;
  cursor: string | null;
}

export async function findUserScriptForRun(
  orgId: string,
  id: string,
): Promise<ScheduledScriptForRun | null> {
  const existing = await db.execute<ScheduledScriptForRun>(
    sql`
    select trigger_point, cron, is_active, next_run_at::text as cursor from user_scripts where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return existing[0] ?? null;
}

export async function advanceScheduledScriptCursor(args: {
  orgId: string;
  id: string;
  cron: string | null;
  cursor: string | null;
  nextRunAt: Date;
}): Promise<void> {
  await db.execute(sql`update user_scripts set next_run_at = ${args.nextRunAt}
    where id = ${args.id} and org_id = ${args.orgId} and trigger_point = 'scheduled' and is_active
      and cron is not distinct from ${args.cron}
      and next_run_at is not distinct from ${args.cursor}::timestamptz`);
}
