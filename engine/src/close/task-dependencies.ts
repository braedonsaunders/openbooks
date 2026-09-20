import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
export async function resolveTaskDependenciesTx(
  tx: SqlExecutor,
  orgId: string,
  runId: string,
): Promise<void> {
  await tx.execute(sql`
    update close_run_tasks t
       set status = case
         when t.status in ('complete','submitted','in_progress','changes_requested','waived') then t.status
         when exists (
           select 1
             from close_blueprint_dependencies d
             join close_run_tasks dep on dep.run_id = t.run_id and dep.blueprint_step_id = d.depends_on_step_id and dep.org_id = t.org_id
            where d.step_id = t.blueprint_step_id and d.org_id = t.org_id and dep.status not in ('complete','waived')
         ) then 'blocked'
         else 'ready'
       end,
       updated_at = now()
     where t.org_id = ${orgId} and t.run_id = ${runId}`);
}
