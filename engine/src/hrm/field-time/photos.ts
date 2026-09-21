/**
 * HR-20 clock photo folder: one org system folder for field-time
 * captures, with grants to HR and the worker.
 *
 * The worker uploading gets editor (the upload route requires
 * Editor+); roles that approve time get viewer. Grants are idempotent
 * upserts keyed on (org, resource, principal), so every clock page
 * load converges — never duplicates, never drops.
 */

import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";

const HR_ROLE_KEYS = ["admin", "controller", "accountant", "approver"];

export async function ensureClockPhotoFolder(orgId: string, userId: string): Promise<string> {
  const root = (await db.execute<{ id: string }>(sql`
    select id::text as id from folders
     where org_id = ${orgId} and system_kind = 'attachments' limit 1`)).rows[0];
  if (!root) {
    throw new Error("the File Cabinet attachments root is missing — open the File Cabinet once before clocking with photos");
  }
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${"field-clock-photos:" + orgId}))`);
  const existing = (await db.execute<{ id: string }>(sql`
    select id::text as id from folders
     where org_id = ${orgId} and parent_folder_id = ${root.id}
       and name = 'Field time photos' and is_system`)).rows[0];
  const folderId = existing?.id ?? (await db.execute<{ id: string }>(sql`
    insert into folders (org_id, parent_folder_id, name, is_system, created_by, updated_by)
    values (${orgId}, ${root.id}, 'Field time photos', true, ${userId}, ${userId})
    returning id::text as id`)).rows[0]?.id;
  if (!folderId) throw new Error("the field-time photo folder was not stored — retry opening the clock page");
  // Grants have no unique key, so each is an explicit existence check:
  // a present grant means a previous page load already converged.
  async function grantOnce(principalType: string, principalId: string, access: string): Promise<void> {
    const seen = (await db.execute<{ id: string }>(sql`
      select id from resource_grants
       where org_id = ${orgId} and resource_type = 'folder' and resource_id = ${folderId}
         and principal_type = ${principalType} and principal_id = ${principalId}`)).rows[0];
    if (seen) return;
    await db.execute(sql`
      insert into resource_grants
        (org_id, resource_type, resource_id, principal_type, principal_id, access, created_by, updated_by)
      values (${orgId}, 'folder', ${folderId}, ${principalType}, ${principalId}, ${access}, ${userId}, ${userId})`);
  }
  // The worker behind the login uploads: editor.
  await grantOnce("user", userId, "editor");
  // HR roles that approve time read the captures: viewer. One parameter
  // per key: bare JS arrays must never be interpolated into ANY().
  const keys = HR_ROLE_KEYS.map((key) => sql`${key}`);
  const roles = (await db.execute<{ id: string }>(sql`
    select id::text as id from app_roles where org_id = ${orgId} and key in (${sql.join(keys, sql`, `)})`)).rows;
  for (const role of roles) {
    await grantOnce("role", role.id, "viewer");
  }
  return folderId;
}
