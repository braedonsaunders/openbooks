import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { assertSavedReportPeriod } from "./report-filters";

export interface SavedReportShortcutInput {
  name: string;
  path: string;
  params?: Record<string, string>;
}

export interface SavedReportShortcut {
  id: string;
  name: string;
  path: string;
  params: Record<string, string>;
}

/** The Reports hub and command discovery share the same capped shortcut list. */
export async function listSavedReportShortcuts(orgId: string): Promise<SavedReportShortcut[]> {
  return db.execute<SavedReportShortcut>(
    sql`select id, name, path, params from saved_reports where org_id = ${orgId} order by created_at desc limit 12`,
    "objects",
  );
}

export async function createSavedReportShortcut(
  authz: Authz,
  input: SavedReportShortcutInput,
): Promise<{ id: string }> {
  assertSavedReportPeriod(input.params ?? {});
  const created = await db.execute<{ id: string }>(
    sql`
      insert into saved_reports (org_id, name, path, params, created_by_user_id)
      values (${authz.user.orgId}, ${input.name}, ${input.path}, ${JSON.stringify(input.params ?? {})}, ${authz.user.id})
      returning id
    `,
    "objects",
  );
  if (!created[0]) throw new Error("Saved report shortcut was not created.");
  return { id: created[0].id };
}

export async function deleteSavedReportShortcut(authz: Authz, id: string): Promise<boolean> {
  const deleted = await db.execute<{ id: string }>(
    sql`
      delete from saved_reports
       where id = ${id}
         and org_id = ${authz.user.orgId}
         and (${authz.permissions.has("*")} or created_by_user_id = ${authz.user.id})
      returning id
    `,
    "objects",
  );
  return deleted.length > 0;
}
