import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { exchangeCode, listConnections as xeroTenants, type XeroApp } from '@openbooks/engine/src/xero.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../../lib/authz'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Xero OAuth callback: decrypt `state` for {orgId, connectionId}, exchange the
 * code with THAT connection's app credentials, resolve the authorized tenant
 * via /connections, and merge tokens + tenantId back onto the same row.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const back = (status: string) => NextResponse.redirect(new URL(`/sync?oauth=${status}`, req.url))

  if (url.searchParams.get('error')) return back('denied')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('invalid')

  const st = unsealJson<{ orgId: string; connectionId: string }>(state)
  if (!st?.orgId || !st?.connectionId) return back('badstate')
  if (st.orgId !== gate.user.orgId) return back('badstate')
  const conn = await getConnection(st.orgId, st.connectionId)
  if (!conn || conn.source !== 'xero') return back('notfound')
  const secret = unsealJson<{ clientId?: string; clientSecret?: string }>(conn.secrets)
  if (!secret?.clientId || !secret?.clientSecret) return back('nocreds')

  const app: XeroApp = {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri: `${url.origin}/api/platform/connections/oauth/xero/callback`,
  }
  try {
    const tokens = await exchangeCode(app, code)
    const tenants = await xeroTenants(tokens.accessToken)
    const tenant = tenants[0]
    if (!tenant) return back('notenant')

    const mergedSecrets = sealJson({ clientId: secret.clientId, clientSecret: secret.clientSecret, ...tokens })
    const mergedConfig = JSON.stringify({ ...conn.config, tenantId: tenant.tenantId })
    const displayName = `${tenant.tenantName} (Xero)`
    await db.execute(sql`
      update connections
         set secrets = ${mergedSecrets}, config = ${mergedConfig}::jsonb,
             display_name = ${displayName}, status = 'active', last_error = null, updated_at = now()
       where id = ${conn.id} and org_id = ${st.orgId}`)
    return back('connected')
  } catch {
    return back('error')
  }
}
