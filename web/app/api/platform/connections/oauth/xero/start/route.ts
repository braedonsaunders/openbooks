import { NextResponse } from 'next/server'
import { authorizeUrl, type XeroApp } from '@openbooks/engine/src/xero.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Begin the Xero consent flow for one connection. The Xero app creds live on
 * that connection (entered in the UI, sealed); {orgId, connectionId} rides
 * through Xero in an encrypted `state` (doubling as the CSRF nonce).
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const connectionId = new URL(req.url).searchParams.get('connectionId')
  if (!connectionId) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 })

  const conn = await getConnection(gate.user.orgId, connectionId)
  if (!conn || conn.source !== 'xero') return NextResponse.json({ error: 'not found' }, { status: 404 })
  const secret = unsealJson<{ clientId?: string }>(conn.secrets)
  if (!secret?.clientId) {
    return NextResponse.json({ error: 'connection has no Client ID — save the app credentials first' }, { status: 400 })
  }
  const app: XeroApp = {
    clientId: secret.clientId,
    clientSecret: '',
    redirectUri: `${new URL(req.url).origin}/api/platform/connections/oauth/xero/callback`,
  }
  const state = sealJson({ orgId: gate.user.orgId, connectionId })
  return NextResponse.redirect(authorizeUrl(app, state))
}
