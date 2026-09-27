import { isDeepStrictEqual } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/platform/db.ts'
import { sealJson, SecretIntegrityError, unsealJson } from '@openbooks/engine/src/platform/secrets.ts'
import { exchangeCode, listCompanies, type DynamicsApp } from '@openbooks/engine/src/connectors/dynamics.ts'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { connectionAuditChanges } from '@openbooks/schema/src/connections.ts'
import { defineRoute } from '@/lib/api/route'
import { lockActorPermission } from '../../../../../../../lib/super-admin'
import { storageIdentityError } from '../../../_storage-identity'
import {
  acceptConnectionOauthState,
  connectionOauthActorStillAuthorized,
  connectionOauthBounce,
  connectionOauthCookieValue,
  connectionOauthRedirectUri,
  pinProviderChoice,
} from '../../_flow'

export const maxDuration = 60

/**
 * Dynamics BC OAuth callback: consume the one-time cookie nonce, decrypt
 * `state` for {orgId, connectionId}, exchange the code with THAT connection's
 * Entra app creds, pin the company (prior stored id, or the only company —
 * never the first row of a longer list), and merge tokens + companyId back
 * onto the row.
 */
export const GET = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: 'External accounting connections are controlled by setup permission and have no separate organization feature gate.' },
  scope: 'unrestricted',
  handler: async ({ request: req, authz: gate }) => {
  const url = new URL(req.url)

  if (url.searchParams.get('error')) return connectionOauthBounce('denied')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return connectionOauthBounce('invalid')

  const st = acceptConnectionOauthState(state, connectionOauthCookieValue(req))
  if (!st) return connectionOauthBounce('badstate')
  if (st.orgId !== gate.user.orgId) return connectionOauthBounce('badstate')
  const conn = await getConnection(st.orgId, st.connectionId).catch((e) => {
    if (storageIdentityError(e)) return null
    throw e
  })
  if (!conn || conn.source !== 'dynamics') return connectionOauthBounce('notfound')
  // A tampered credential bounces as missing credentials — re-enter them.
  let secret: { clientId?: string; clientSecret?: string } | null = null
  try {
    secret = conn.secrets == null ? null : unsealJson<{ clientId?: string; clientSecret?: string }>(conn.secrets, { orgId: st.orgId, purpose: "connection.secrets" })
  } catch (error) {
    if (!(error instanceof SecretIntegrityError)) throw error
  }
  const cfg = conn.config as { aadTenantId?: string; environment?: string; companyId?: string }
  if (!secret?.clientId || !secret?.clientSecret) return connectionOauthBounce('nocreds')
  if (!cfg.aadTenantId || !cfg.environment) return connectionOauthBounce('nocreds')

  const app: DynamicsApp = {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri: connectionOauthRedirectUri('dynamics'),
    aadTenantId: cfg.aadTenantId,
  }
  try {
    const tokens = await exchangeCode(app, code)
    const companies = await listCompanies(tokens.accessToken, cfg.aadTenantId, cfg.environment)
    const pinned = pinProviderChoice(companies, cfg.companyId, (company) => company.id, 'nocompany')
    if (!pinned.ok) return connectionOauthBounce(pinned.status)
    const company = pinned.item
    if (!(await connectionOauthActorStillAuthorized(st.orgId, gate.user.id))) return connectionOauthBounce('error')

    const mergedSecrets = sealJson({ clientId: secret.clientId, clientSecret: secret.clientSecret, ...tokens }, { orgId: st.orgId, purpose: "connection.secrets" })
    const displayName = `${company.displayName ?? company.name} (Business Central)`
    const connected = await db.transaction(async (tx) => {
      await lockActorPermission(tx, gate, 'admin.setup.manage', { requireUnrestrictedScope: true })
      const [current] = await tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.id, conn.id), eq(schema.connections.orgId, st.orgId)))
        .for('update')
      if (
        !current ||
        current.source !== 'dynamics' ||
        current.secrets !== conn.secrets ||
        current.displayName !== conn.displayName ||
        current.status !== conn.status ||
        !isDeepStrictEqual(current.config, conn.config)
      ) return false
      const [updated] = await tx
        .update(schema.connections)
        .set({
          secrets: mergedSecrets,
          config: {
            ...(current.config as Record<string, unknown>),
            companyId: company.id,
            companyName: company.displayName ?? company.name,
          },
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
    if (!connected) return connectionOauthBounce('error')
    return connectionOauthBounce('connected')
  } catch {
    return connectionOauthBounce('error')
  }
  },
})
