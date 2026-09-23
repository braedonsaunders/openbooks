import { NextResponse } from 'next/server'
import { authorizeUrl, type QboApp } from '@openbooks/engine/src/connectors/qbo.ts'
import { unsealJson } from '@openbooks/engine/src/platform/secrets.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission, guardUnrestrictedScope } from '../../../../../../../lib/authz'
import { storageIdentityError } from '../../../_storage-identity'
import {
  attachConnectionOauthCookie,
  connectionOauthRedirectUri,
  mintConnectionOauthState,
} from '../../_flow'

export const runtime = 'nodejs'

/**
 * Begin the QuickBooks consent flow for one connection. The QBO app creds live
 * on that connection (entered in the UI, sealed). A one-time nonce rides in
 * the sealed `state` and in an HttpOnly cookie — the org/connection pair
 * alone is not a CSRF nonce.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const connectionId = new URL(req.url).searchParams.get('connectionId')
  if (!connectionId) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 })

  const conn = await getConnection(gate.user.orgId, connectionId).catch((e) => {
    if (storageIdentityError(e)) return null
    throw e
  })
  if (!conn || conn.source !== 'qbo') return NextResponse.json({ error: 'not found' }, { status: 404 })
  const secret = unsealJson<{ clientId?: string }>(conn.secrets)
  if (!secret?.clientId) {
    return NextResponse.json({ error: 'connection has no Client ID — save the app credentials first' }, { status: 400 })
  }
  const app: QboApp = {
    clientId: secret.clientId,
    clientSecret: '',
    redirectUri: connectionOauthRedirectUri('qbo'),
    environment: (conn.config as { environment?: string }).environment === 'production' ? 'production' : 'sandbox',
  }
  const { state, nonce } = mintConnectionOauthState(gate.user.orgId, connectionId)
  const response = NextResponse.redirect(authorizeUrl(app, state))
  attachConnectionOauthCookie(response, nonce)
  return response
}
