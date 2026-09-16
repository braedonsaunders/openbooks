import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import { encryptSecret, sftpServerAuditSnapshot, type SftpServerAuditRow } from '@openbooks/engine/src/sftp/manager.ts'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import { pgErrorCode } from '../../../../../lib/setup/coerce'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Toggle active or rotate the password: { action: 'toggle' | 'rotate' }.
 * Every mutation commits together with its secret-free audit evidence — a
 * failed audit insert rolls the credential/state change back untouched.
 */

const deleteBody = z.looseObject({
  reason: z.string().trim().min(1, 'a deletion reason must be a non-empty string').max(500).optional(),
})

/** Optional destructive-action reason; requests without a JSON body contribute none. */
async function deletionReason(req: Request): Promise<{ response?: NextResponse; reason: string | null }> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return { response: undefined, reason: null }
  const parsed = await parseJsonBody(req, deleteBody)
  if (!parsed.ok) return { response: parsed.response, reason: null }
  return { response: undefined, reason: parsed.data.reason ?? null }
}

async function currentRow(tx: SqlExecutor, id: string, orgId: string) {
  const r = (await tx.execute<SftpServerAuditRow & { id: string }>(sql`
    select id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, is_active, created_by, updated_by
      from sftp_servers where id = ${id} and org_id = ${orgId} for update
  `))
  return r.rows[0] ?? null
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; isActive?: boolean }
  if (body.action !== 'rotate' && body.action !== 'toggle') {
    return NextResponse.json({ error: "action must be 'toggle' or 'rotate'" }, { status: 400 })
  }
  let notFound = false
  if (body.action === 'rotate') {
    const password = randomBytes(18).toString('base64url')
    const username = await db.transaction(async (tx) => {
      const before = await currentRow(tx, id, user.orgId)
      if (!before) { notFound = true; return null }
      const after = (await tx.execute<SftpServerAuditRow & { id: string; username: string }>(sql`
        update sftp_servers set password_encrypted = ${encryptSecret(password)}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}
        returning id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, is_active, created_by, updated_by
      `)).rows[0]!
      await auditSetupChange({
        orgId: user.orgId,
        table: 'sftp_servers',
        rowId: id,
        action: 'update',
        changes: { before: sftpServerAuditSnapshot(before), after: sftpServerAuditSnapshot(after), credentialRotated: true },
        actorId: user.id,
      }, tx)
      return after.username
    })
    if (notFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ username, password })
  }
  const nextActive = body.isActive !== false
  await db.transaction(async (tx) => {
    const before = await currentRow(tx, id, user.orgId)
    if (!before) { notFound = true; return }
    const after = (await tx.execute<SftpServerAuditRow & { id: string }>(sql`
      update sftp_servers set is_active = ${nextActive}, updated_at = now(), updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId}
      returning id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, is_active, created_by, updated_by
    `)).rows[0]!
    await auditSetupChange({
      orgId: user.orgId,
      table: 'sftp_servers',
      rowId: id,
      action: 'update',
      changes: { before: sftpServerAuditSnapshot(before), after: sftpServerAuditSnapshot(after) },
      actorId: user.id,
    }, tx)
  })
  if (notFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { response: invalidBody, reason } = await deletionReason(req)
  if (invalidBody) return invalidBody
  let notFound = false
  let refused: NextResponse | null = null
  try {
    await db.transaction(async (tx) => {
      const before = await currentRow(tx, id, user.orgId)
      if (!before) { notFound = true; return }
      // A server that still delivers payment files or feeds statement
      // imports cannot vanish: bank profiles hold a RESTRICT foreign key
      // (a raw 500 without this check) and import schedules hold no key at
      // all (they would silently stop running and disappear from the
      // joined schedule list). Refuse with the dependents named, like the
      // flow and recurring-schedule deletes.
      const dependents = (await tx.execute<{ profiles: string; schedules: string }>(sql`
        select
          (select count(*)::text from payment_bank_profiles where org_id = ${user.orgId} and sftp_server_id = ${id}) as profiles,
          (select count(*)::text from sftp_import_schedules where org_id = ${user.orgId} and sftp_server_id = ${id}) as schedules
      `)).rows[0]!
      if (Number(dependents.profiles) > 0) {
        refused = NextResponse.json(
          { error: 'This SFTP server still delivers payment files for a bank profile — point the profile at another server first', code: 'bank_profile_in_use' },
          { status: 409 },
        )
        return
      }
      if (Number(dependents.schedules) > 0) {
        refused = NextResponse.json(
          { error: 'This SFTP server still feeds statement import schedules — delete or re-point the schedules first', code: 'import_schedules_in_use' },
          { status: 409 },
        )
        return
      }
      await tx.execute(sql`delete from sftp_servers where id = ${id} and org_id = ${user.orgId}`)
      await auditSetupChange({
        orgId: user.orgId,
        table: 'sftp_servers',
        rowId: id,
        action: 'delete',
        changes: reason ? { before: sftpServerAuditSnapshot(before), reason } : { before: sftpServerAuditSnapshot(before) },
        actorId: user.id,
      }, tx)
    })
  } catch (e) {
    // A reference the checks above cannot see (for example a row outside
    // this organization pointing at the server through the unscoped
    // profile key) still refuses the delete at the storage layer — surface
    // it as the same typed 409 instead of a raw 500.
    if (pgErrorCode(e) === '23503') {
      return NextResponse.json(
        { error: 'This SFTP server is still referenced and cannot be deleted', code: 'in-use' },
        { status: 409 },
      )
    }
    throw e
  }
  if (refused) return refused
  if (notFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
