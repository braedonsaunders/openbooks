import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { encryptSecret, sftpServerAuditSnapshot, type SftpServerAuditRow } from '@openbooks/engine/src/sftp/manager.ts'
import { appStorageKind, appBucket, assertTenantRootPrefix } from '@openbooks/engine/src/sftp/backend.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { auditSetupChange } from '../../../../lib/setup/audit'

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

/** How many username attempts a create gets before giving up (never reached in practice). */
const USERNAME_MINT_ATTEMPTS = 8

/**
 * Create an SFTP server; returns the generated password ONCE (never stored in
 * clear). The username is the daemon's GLOBAL login identity (unique index
 * sftp_servers_username_global), so the insert claims its random suffix
 * atomically (`on conflict do nothing`) and re-mints on a lost race instead
 * of trusting 3 bytes of chance. The row and its secret-free audit evidence
 * commit as one unit — a failed audit insert leaves no login behind.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { name?: string; rootPrefix?: string; authorizedKeys?: string }
  if (!body.name || String(body.name).trim() === '') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const base = slug(String(body.name).trim())
  const password = randomBytes(18).toString('base64url')
  // Storage is the app's own object store (or local) — never a per-tenant env/setting.
  // The physical root is DERIVED from the tenant namespace (sftp/<orgId>/<server>),
  // never a tenant-selected location: a requested prefix must stay under the
  // org's namespace, and anything absolute, backslashed, percent-encoded or
  // cross-tenant is refused (the engine's canonical validator fails closed).
  const backend = appStorageKind()
  const bucket = backend === 's3' ? appBucket() : null
  const requestedPrefix = body.rootPrefix?.trim() || ''
  if (requestedPrefix) {
    // Refuse before any insert: a requested prefix is validated once, up front —
    // it never passes through slash-stripping or other laundering.
    try {
      const canonical = assertTenantRootPrefix(requestedPrefix, user.orgId)
      if (canonical.split('/').length < 3) {
        return NextResponse.json({ error: `sftp root prefix must name a folder under sftp/${user.orgId}/` }, { status: 400 })
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 })
    }
  }
  const authorizedKeys = body.authorizedKeys?.trim() || null
  type Created = SftpServerAuditRow & { id: string }
  let created: Created | null = null
  let username = ''
  let rootPrefix = ''
  for (let attempt = 0; attempt < USERNAME_MINT_ATTEMPTS && !created; attempt++) {
    // A longer suffix after repeated losses keeps the mint converging.
    username = `${base}-${randomBytes(attempt < USERNAME_MINT_ATTEMPTS - 3 ? 3 : 8).toString('hex')}`
    rootPrefix = requestedPrefix
      ? assertTenantRootPrefix(requestedPrefix, user.orgId)
      : assertTenantRootPrefix(`sftp/${user.orgId}/${username}`, user.orgId)
    created = await db.transaction(async (tx) => {
      const row = (await tx.execute<Created>(sql`
        insert into sftp_servers (org_id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, created_by, updated_by)
        values (${user.orgId}, ${String(body.name).trim()}, ${username}, ${encryptSecret(password)}, ${authorizedKeys},
                ${backend}, ${bucket}, ${rootPrefix}, ${user.id}, ${user.id})
        on conflict (username) do nothing
        returning id, name, username, password_encrypted, authorized_keys, backend, bucket, root_prefix, is_active, created_by, updated_by
      `))
      if (!row.rows[0]) return null // concurrent creator claimed the suffix — re-mint
      await auditSetupChange({
        orgId: user.orgId,
        table: 'sftp_servers',
        rowId: String(row.rows[0]!.id),
        action: 'insert',
        changes: { after: sftpServerAuditSnapshot(row.rows[0]!) },
        actorId: user.id,
      }, tx)
      return row.rows[0]!
    })
  }
  if (!created) {
    return NextResponse.json({ error: 'could not allocate a unique username' }, { status: 503 })
  }
  return NextResponse.json({ id: String(created.id), username, password, rootPrefix, backend })
}
