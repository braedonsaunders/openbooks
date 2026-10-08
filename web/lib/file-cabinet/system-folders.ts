import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
export { ensureAttachmentsRoot, ensureRecordFolder } from '@openbooks/engine/src/platform/record-folders.ts'

/** System intake folder for AP capture source packets. */
export async function ensureApCaptureRoot(orgId: string, createdBy: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ap-capture:${orgId}`}))`)
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and system_kind = 'ap_capture'
    `))
    if (existing.rows[0]) return existing.rows[0]!.id
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, is_private, owner_id,
                           created_by, updated_by, created_at, updated_at)
      values (${orgId}, 'AP Capture', true, 'ap_capture', false, null,
              ${createdBy}, ${createdBy}, now(), now())
      returning id
    `))
    return inserted.rows[0]!.id
  })
}
