import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export type AppManagementPage =
  | { kind: "not_found" }
  | { kind: "invalid_page" }
  | { kind: "invalid_section" }
  | {
      kind: "ok";
      rows: Record<string, unknown>[];
      page: number;
      activeVersionId: string | null;
    };

/** Read one page of organization-owned app management evidence. */
export async function readAppManagementPage(
  db: SqlExecutor,
  input: { orgId: string; key: string; section: string; pageQuery: string | null },
): Promise<AppManagementPage> {
  const app = (
    await db.execute<{ id: string; activeVersionId: string | null }>(
      sql`
      select a.id, a.active_version_id as "activeVersionId"
        from apps a
       where a.org_id = ${input.orgId} and a.key = ${input.key}
       limit 1`,
      "objects",
    )
  )[0];
  if (!app) return { kind: "not_found" };

  const page = Number(input.pageQuery ?? "1");
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
    return { kind: "invalid_page" };
  }
  const offset = (page - 1) * 25;

  const result =
    input.section === "versions"
      ? await db.execute<Record<string, unknown>>(sql`
          select id, version, status, created_at as at, created_by as actor_id
            from app_versions where org_id=${input.orgId} and app_id=${app.id}
            order by created_at desc,id desc limit 26 offset ${offset}`)
      : input.section === "runs"
        ? await db.execute<Record<string, unknown>>(sql`
            select id,version_id,endpoint,status,units,logs,error_message,duration_ms,actor_id,at
              from app_runs where org_id=${input.orgId} and app_id=${app.id}
              order by at desc,id desc limit 26 offset ${offset}`)
        : input.section === "audit"
          ? await db.execute<Record<string, unknown>>(sql`
              select id,action,changes,actor_id,at from audit_log where org_id=${input.orgId} and ((table_name='apps' and row_id=${app.id}) or (table_name='app_listings' and row_id in (select id from app_listings where publisher_org_id=${input.orgId} and key=${input.key})) or (table_name='extension_drafts' and row_id in (select id from extension_drafts where org_id=${input.orgId} and extension_key=${input.key})))
              order by at desc,id desc limit 26 offset ${offset}`)
          : input.section === "storage"
            ? await db.execute<Record<string, unknown>>(sql`
                select id,namespace,key,value,updated_at as at,updated_by as actor_id from app_storage
                where org_id=${input.orgId} and app_id=${app.id} order by namespace,key,id limit 26 offset ${offset}`)
            : null;

  if (!result) return { kind: "invalid_section" };
  return {
    kind: "ok",
    rows: result.rows,
    page,
    activeVersionId: app.activeVersionId,
  };
}
