import { NextResponse } from 'next/server'
import { authorizeUrl, type DynamicsApp } from '@openbooks/engine/src/dynamics.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Begin the Dynamics 365 Business Central consent flow for one connection. The
 * Entra app creds live on the connection (sealed); the org's directory (tenant)
 * id + BC environment ride on its config. {orgId, connectionId} round-trips
 * through Entra in an encrypted `state`.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const connectionId = new URL(req.url).searchParams.get('connectionId')
  if (!connectionId) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 })

  const conn = await getConnection(gate.user.orgId, connectionId)
  if (!conn || conn.source !== 'dynamics') return NextResponse.json({ error: 'not found' }, { status: 404 })
  const secret = unsealJson<{ clientId?: string }>(conn.secrets)
  const cfg = conn.config as { aadTenantId?: string }
  if (!secret?.clientId) {
    return NextResponse.json({ error: 'connection has no Client ID — save the app credentials first' }, { status: 400 })
  }
  if (!cfg.aadTenantId) {
    return NextResponse.json({ error: 'connection has no directory (tenant) ID — save it first' }, { status: 400 })
  }
  const app: DynamicsApp = {
    clientId: secret.clientId,
    clientSecret: '',
    redirectUri: `${new URL(req.url).origin}/api/platform/connections/oauth/dynamics/callback`,
    aadTenantId: cfg.aadTenantId,
  }
  const state = sealJson({ orgId: gate.user.orgId, connectionId })
  return NextResponse.redirect(authorizeUrl(app, state))
}
