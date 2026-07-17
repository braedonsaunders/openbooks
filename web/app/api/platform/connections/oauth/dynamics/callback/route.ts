import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { exchangeCode, listCompanies, type DynamicsApp } from '@openbooks/engine/src/dynamics.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Dynamics BC OAuth callback: decrypt `state` for {orgId, connectionId},
 * exchange the code with THAT connection's Entra app creds, resolve the first
 * company in the BC environment, and merge tokens + companyId back onto the row.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const back = (status: string) => NextResponse.redirect(new URL(`/sync?oauth=${status}`, req.url))

  if (url.searchParams.get('error')) return back('denied')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('invalid')

  const st = unsealJson<{ orgId: string; connectionId: string }>(state)
  if (!st?.orgId || !st?.connectionId) return back('badstate')
  const conn = await getConnection(st.orgId, st.connectionId)
  if (!conn || conn.source !== 'dynamics') return back('notfound')
  const secret = unsealJson<{ clientId?: string; clientSecret?: string }>(conn.secrets)
  const cfg = conn.config as { aadTenantId?: string; environment?: string }
  if (!secret?.clientId || !secret?.clientSecret) return back('nocreds')
  if (!cfg.aadTenantId || !cfg.environment) return back('nocreds')

  const app: DynamicsApp = {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri: `${url.origin}/api/platform/connections/oauth/dynamics/callback`,
    aadTenantId: cfg.aadTenantId,
  }
  try {
    const tokens = await exchangeCode(app, code)
    const companies = await listCompanies(tokens.accessToken, cfg.aadTenantId, cfg.environment)
    const company = companies[0]
    if (!company) return back('nocompany')

    const mergedSecrets = sealJson({ clientId: secret.clientId, clientSecret: secret.clientSecret, ...tokens })
    const mergedConfig = JSON.stringify({ ...conn.config, companyId: company.id, companyName: company.displayName ?? company.name })
    const displayName = `${company.displayName ?? company.name} (Business Central)`
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
