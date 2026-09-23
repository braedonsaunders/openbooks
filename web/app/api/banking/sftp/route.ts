import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { encryptSecret, sftpServerAuditSnapshot, type SftpServerAuditRow } from '@openbooks/engine/src/sftp/manager.ts'
import { validateAuthorizedKeys } from '@openbooks/engine/src/sftp/authorized-keys.ts'
import { appStorageKind, appBucket, assertTenantRootPrefix } from '@openbooks/engine/src/sftp/backend.ts'
import { findRootOverlap, rootOverlapRefusal } from '@openbooks/engine/src/sftp/roots.ts'
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
  // Storage selection fails closed: partial S3 configuration, or local storage
  // without an absolute shared OPENBOOKS_DATA_DIR, refuses by name here —
  // never a saved backend=local row whose uploads land where the importer
  // never looks.
  let backend: string
  let bucket: string | null
  try {
    backend = appStorageKind()
    bucket = backend === 's3' ? appBucket() : null
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 })
  }
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
  // Key material is validated BEFORE any insert: every non-comment line must
  // parse as a public key or the save is refused naming the bad lines, and a
  // supplied but empty key set is refused instead of silently degrading to a
  // password-only login. What is stored is the normalized form.
  let authorizedKeys: string | null = null
  if (body.authorizedKeys !== undefined && body.authorizedKeys !== null) {
    let lines: string[]
    try {
      lines = validateAuthorizedKeys(String(body.authorizedKeys))
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 })
    }
    if (lines.length === 0) {
      return NextResponse.json(
        { error: 'authorizedKeys was supplied but contains no public keys — add one key per line or omit the field for a password-only login' },
        { status: 400 },
      )
    }
    authorizedKeys = lines.join('\n')
  }
  type Created = SftpServerAuditRow & { id: string }
  let created: Created | null = null
  let username = ''
  let rootPrefix = ''
  let overlapRefusal: string | null = null
  for (let attempt = 0; attempt < USERNAME_MINT_ATTEMPTS && !created && !overlapRefusal; attempt++) {
    // A longer suffix after repeated losses keeps the mint converging.
    username = `${base}-${randomBytes(attempt < USERNAME_MINT_ATTEMPTS - 3 ? 3 : 8).toString('hex')}`
    rootPrefix = requestedPrefix
      ? assertTenantRootPrefix(requestedPrefix, user.orgId)
      : assertTenantRootPrefix(`sftp/${user.orgId}/${username}`, user.orgId)
    created = await db.transaction(async (tx) => {
      // Overlap gate: refuse a root that is equal to, inside, or containing
      // an ACTIVE sibling's root — two bank logins must never share a
      // folder. The per-org advisory lock serializes concurrent creates
      // (row locks alone cover nothing when the org has no servers yet, so
      // two simultaneous first creates would both pass and both insert);
      // the sibling-row lock then holds the serialization against writers
      // that do not take this gate. Inactive servers do not block: they
      // serve no login, and reactivating into an overlap refuses on toggle.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'sftp-roots:' + user.orgId}, 0))`)
      const siblings = (await tx.execute<{ id: string; name: string; root_prefix: string; is_active: boolean }>(sql`
        select id, name, root_prefix, is_active from sftp_servers where org_id = ${user.orgId} for update
      `))
      const hit = findRootOverlap(
        rootPrefix,
        siblings.rows.filter((r) => r.is_active).map((r) => ({ id: r.id, name: r.name, rootPrefix: r.root_prefix })),
      )
      if (hit) {
        overlapRefusal = rootOverlapRefusal(rootPrefix, hit)
        return null
      }
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
  if (overlapRefusal) {
    return NextResponse.json({ error: overlapRefusal, code: 'sftp_root_overlap' }, { status: 409 })
  }
  if (!created) {
    return NextResponse.json({ error: 'could not allocate a unique username' }, { status: 503 })
  }
  return NextResponse.json({ id: String(created.id), username, password, rootPrefix, backend })
}
