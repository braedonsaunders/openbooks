import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { encryptSecret } from '@openbooks/engine/src/sftp/manager.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Toggle active or rotate the password: { action: 'toggle' | 'rotate' }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { action?: string; isActive?: boolean }
  if (body.action === 'rotate') {
    const password = randomBytes(18).toString('base64url')
    const r = (await db.execute<{ username: string }>(sql`
      update sftp_servers set password_encrypted = ${encryptSecret(password)}, updated_at = now(), updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId} returning username
    `))
    if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ username: r.rows[0].username, password })
  }
  await db.execute(sql`
    update sftp_servers set is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await db.execute(sql`delete from sftp_servers where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
