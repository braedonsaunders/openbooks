import { sql } from "drizzle-orm";

import { db } from "../../platform/db.ts";

/**
 * Refusal codes for task/project pairing. One rule, shared by clock
 * events (clock.ts) and crew batch posting (crew.ts): a task always
 * costs against exactly one project, so a task must be known and sit on
 * the project it is recorded against. Callers refuse with these codes
 * and their own surface's remedy.
 */
export type TaskPairingCode = "task_unknown" | "task_without_project" | "task_wrong_project";

/**
 * The pairing predicate both writers share: null when the task may be
 * recorded against the project, otherwise the code the caller refuses
 * with. A null project never pairs — a task without a project is a
 * dangling cost attribution, not an unscoped one.
 */
export async function taskPairingCode(
  orgId: string,
  projectId: string | null,
  taskId: string,
): Promise<TaskPairingCode | null> {
  const row = (await db.execute<{ project_id: string }>(sql`
    select project_id::text as project_id from project_tasks
     where org_id = ${orgId} and id = ${taskId} limit 1`)).rows[0];
  if (!row) return "task_unknown";
  if (projectId === null) return "task_without_project";
  if (row.project_id !== projectId) return "task_wrong_project";
  return null;
}
