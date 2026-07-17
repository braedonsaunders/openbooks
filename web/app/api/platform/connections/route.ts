import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { sealJson } from '@openbooks/engine/src/secrets.ts'
import { listConnections, sourceType, SOURCE_TYPES } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** Strip the sealed credential blob before anything leaves the server. */
function toClient(c: Awaited<ReturnType<typeof listConnections>>[number]) {
  return {
    id: c.id,
    source: c.source,
    displayName: c.displayName,
    authKind: c.authKind,
    status: c.status,
    config: c.config,
    mirrorEnabled: c.mirrorEnabled,
    mirrorSchedule: c.mirrorSchedule,
    cursor: c.cursor,
    lastRunAt: c.lastRunAt,
    lastError: c.lastError,
    hasSecrets: Boolean(c.secrets),
  }
}

/** List this tenant's connections + the catalogue of source types you can add. */
export async function GET() {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const rows = await listConnections(orgId)
  const runs = (await db.execute(sql`
    select id, connection_id as "connectionId", source, kind, status,
           started_at as "startedAt", finished_at as "finishedAt",
           synced_through as "syncedThrough", stats, error_message as "errorMessage", triggered_by as "triggeredBy"
      from sync_runs where org_id = ${orgId} order by started_at desc limit 20`)) as unknown as {
    rows: Record<string, unknown>[]
  }
  // Configured currencies power any `optionsSource: 'currencies'` config field.
  const currencies = (await db.execute(sql`
    select code, name from currencies order by code`)) as unknown as {
    rows: { code: string; name: string }[]
  }
  return NextResponse.json({
    connections: rows.map(toClient),
    runs: runs.rows,
    currencies: currencies.rows,
    sourceTypes: SOURCE_TYPES.map((s) => ({
      source: s.source,
      displayName: s.displayName,
      authKind: s.authKind,
      blurb: s.blurb,
      configFields: s.configFields,
      secretFields: s.secretFields.map((f) => ({ ...f })),
      oauthSetup: s.oauthSetup ?? null,
    })),
  })
}

/** Create a connection. Secrets are sealed at rest and never echoed back. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const actorId = gate.user.id

  const body = (await req.json().catch(() => ({}))) as {
    source?: string
    displayName?: string
    config?: Record<string, unknown>
    secrets?: Record<string, string>
  }
  const manifest = sourceType(String(body.source ?? ''))
  if (!manifest) return NextResponse.json({ error: 'unknown source type' }, { status: 400 })

  const displayName = String(body.displayName ?? '').trim() || manifest.displayName
  const config = body.config ?? {}

  // Validate required non-secret config fields.
  for (const f of manifest.configFields) {
    if (f.required && !String((config as Record<string, unknown>)[f.key] ?? '').trim()) {
      return NextResponse.json({ error: `${f.label} is required` }, { status: 400 })
    }
  }

  // Seal any provided secret fields (all-or-nothing per field).
  const provided: Record<string, string> = {}
  for (const f of manifest.secretFields) {
    const v = body.secrets?.[f.key]
    if (v !== undefined && v !== null && String(v) !== '') provided[f.key] = String(v)
  }
  const hasAllSecrets = manifest.secretFields.every((f) => !f.required || provided[f.key])
  const sealed = Object.keys(provided).length > 0 ? sealJson(provided) : null
  // OAuth connections still need the consent flow before they can run, even
  // once their app credentials are saved — so they start "unconfigured".
  const status = manifest.authKind === 'oauth2' ? 'unconfigured' : sealed && hasAllSecrets ? 'active' : 'unconfigured'

  try {
    const [row] = await db
      .insert(schema.connections)
      .values({
        orgId,
        source: manifest.source,
        displayName,
        authKind: manifest.authKind,
        status,
        config,
        secrets: sealed,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning({ id: schema.connections.id })
    return NextResponse.json({ id: row.id })
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? 'create failed'
    // Unique (org, displayName) collision → friendly message.
    if (/connections_org_name/.test(msg)) {
      return NextResponse.json({ error: 'a connection with that name already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
