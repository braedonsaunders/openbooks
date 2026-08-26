import { NextResponse } from 'next/server'
import { isDeepStrictEqual } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { QboClient, exchangeCode, type QboApp } from '@openbooks/engine/src/qbo.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { connectionAuditChanges } from '@openbooks/schema/src/connections.ts'
import { guardPermission } from '../../../../../../../lib/authz'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * QuickBooks OAuth callback: decrypt `state` for {orgId, connectionId}, use
 * THAT connection's own app credentials to exchange the code, merge the tokens
 * + realmId back onto the same row. Nothing secret ever appears in a URL.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const back = (status: string) => NextResponse.redirect(new URL(`/sync?oauth=${status}`, req.url))

  if (url.searchParams.get('error')) return back('denied')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const realmId = url.searchParams.get('realmId')
  if (!code || !state || !realmId) return back('invalid')

  const st = unsealJson<{ orgId: string; connectionId: string }>(state)
  if (!st?.orgId || !st?.connectionId) return back('badstate')
  if (st.orgId !== gate.user.orgId) return back('badstate')
  const conn = await getConnection(st.orgId, st.connectionId)
  if (!conn || conn.source !== 'qbo') return back('notfound')
  const secret = unsealJson<{ clientId?: string; clientSecret?: string }>(conn.secrets)
  if (!secret?.clientId || !secret?.clientSecret) return back('nocreds')

  const environment = (conn.config as { environment?: string }).environment === 'production' ? 'production' : 'sandbox'
  const app: QboApp = {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri: `${url.origin}/api/platform/connections/oauth/qbo/callback`,
    environment,
  }
  try {
    const tokens = await exchangeCode(app, code)
    let displayName = conn.displayName
    try {
      const client = new QboClient(app, realmId, tokens)
      const info = await client.queryAll<{ CompanyName?: string }>('CompanyInfo')
      if (info[0]?.CompanyName) displayName = `${info[0].CompanyName} (${realmId})`
    } catch { /* best-effort label */ }

    const mergedSecrets = sealJson({ clientId: secret.clientId, clientSecret: secret.clientSecret, ...tokens })
    const connected = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.id, conn.id), eq(schema.connections.orgId, st.orgId)))
        .for('update')
      // Do not overwrite app credentials that an administrator rotated while
      // the remote consent flow was in progress.
      if (
        !current ||
        current.source !== 'qbo' ||
        current.secrets !== conn.secrets ||
        current.displayName !== conn.displayName ||
        current.status !== conn.status ||
        !isDeepStrictEqual(current.config, conn.config)
      ) return false
      const [updated] = await tx
        .update(schema.connections)
        .set({
          secrets: mergedSecrets,
          config: { ...(current.config as Record<string, unknown>), realmId, environment },
          displayName,
          status: 'active',
          lastError: null,
          updatedAt: new Date(),
          updatedBy: gate.user.id,
        })
        .where(and(eq(schema.connections.id, conn.id), eq(schema.connections.orgId, st.orgId)))
        .returning()
      if (!updated) throw new Error('connection update returned no row')
      await tx.insert(schema.auditLog).values({
        orgId: st.orgId,
        tableName: 'connections',
        rowId: conn.id,
        action: 'update',
        changes: connectionAuditChanges({
          event: 'oauth_connected',
          before: current,
          after: updated,
          credentialsChanged: true,
        }),
        actorId: gate.user.id,
      })
      return true
    })
    if (!connected) return back('error')
    return back('connected')
  } catch {
    return back('error')
  }
}
