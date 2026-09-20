import { NextResponse } from 'next/server'
import { authorizeUrl, type DynamicsApp } from '@openbooks/engine/src/connectors/dynamics.ts'
import { unsealJson } from '@openbooks/engine/src/platform/secrets.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../../lib/authz'
import {
  attachConnectionOauthCookie,
  connectionOauthRedirectUri,
  mintConnectionOauthState,
} from '../../_flow'

export const runtime = 'nodejs'

/**
 * Begin the Dynamics 365 Business Central consent flow for one connection. The
 * Entra app creds live on the connection (sealed); the org's directory (tenant)
 * id + BC environment ride on its config. A one-time nonce rides in the sealed
 * `state` and in an HttpOnly cookie.
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
    redirectUri: connectionOauthRedirectUri('dynamics'),
    aadTenantId: cfg.aadTenantId,
  }
  const { state, nonce } = mintConnectionOauthState(gate.user.orgId, connectionId)
  const response = NextResponse.redirect(authorizeUrl(app, state))
  attachConnectionOauthCookie(response, nonce)
  return response
}
