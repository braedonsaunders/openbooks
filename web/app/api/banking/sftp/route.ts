import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { encryptSecret } from '@openbooks/engine/src/sftp/manager.ts'
import { appStorageKind, appBucket } from '@openbooks/engine/src/sftp/backend.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

/** List the org's SFTP servers (never returns secrets). */
export async function GET() {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select id, name, username, backend, bucket, root_prefix, is_active, last_connected_at, created_at
      from sftp_servers where org_id = ${gate.user.orgId} order by created_at desc
  `))
  return NextResponse.json({ servers: r.rows })
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'sftp'

/** Create an SFTP server; returns the generated password ONCE (never stored in clear). */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as { name?: string; rootPrefix?: string; authorizedKeys?: string }
  if (!body.name || String(body.name).trim() === '') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const username = `${slug(body.name)}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(18).toString('base64url')
  // Storage is the app's own object store (or local) — never a per-tenant env/setting.
  const backend = appStorageKind()
  const bucket = backend === 's3' ? appBucket() : null
  const rootPrefix = (body.rootPrefix?.trim() || `sftp/${user.orgId}/${username}`).replace(/^\/+|\/+$/g, '')
  const authorizedKeys = body.authorizedKeys?.trim() || null
  const r = (await db.execute<{ id: string }>(sql`
    insert into sftp_servers (org_id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, created_by)
    values (${user.orgId}, ${String(body.name).trim()}, ${username}, ${encryptSecret(password)}, ${authorizedKeys},
            ${backend}, ${bucket}, ${rootPrefix}, ${user.id})
    returning id
  `))
  return NextResponse.json({ id: r.rows[0]!.id, username, password, rootPrefix, backend })
}
