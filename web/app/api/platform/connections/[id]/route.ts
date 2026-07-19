import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sealJson, unsealJson } from '@openbooks/engine/src/secrets.ts'
import { getConnection, sourceType, validateSourceConfig, validateSourceSecret } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Update a connection: rename, edit config, rotate/add secrets, toggle mirror,
 * pause/resume. Secrets are merged (only provided fields change) then re-sealed;
 * they are never returned.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const { id } = await params

  const existing = await getConnection(orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const manifest = sourceType(existing.source)

  const body = (await req.json().catch(() => ({}))) as {
    displayName?: string
    config?: Record<string, unknown>
    secrets?: Record<string, string>
    mirrorEnabled?: boolean
    mirrorSchedule?: string
    status?: 'active' | 'paused'
  }

  const sets: ReturnType<typeof sql>[] = []
  if (typeof body.displayName === 'string' && body.displayName.trim()) {
    sets.push(sql`display_name = ${body.displayName.trim()}`)
  }
  if (body.config && typeof body.config === 'object') {
    const merged = { ...existing.config, ...body.config }
    if (manifest) {
      const configError = validateSourceConfig(manifest, merged)
      if (configError) return NextResponse.json({ error: configError }, { status: 400 })
    }
    sets.push(sql`config = ${JSON.stringify(merged)}::jsonb`)
  }
  if (body.secrets && manifest) {
    const current = unsealJson<Record<string, string>>(existing.secrets) ?? {}
    for (const f of manifest.secretFields) {
      const v = body.secrets[f.key]
      if (v !== undefined && v !== null && String(v) !== '') {
        const secretError = validateSourceSecret(existing.source, f.key, String(v))
        if (secretError) return NextResponse.json({ error: secretError }, { status: 400 })
        current[f.key] = String(v)
      }
    }
    sets.push(sql`secrets = ${sealJson(current)}`)
    // Providing credentials clears the "unconfigured" state.
    if (existing.status === 'unconfigured') sets.push(sql`status = 'active'`)
  }
  if (typeof body.mirrorEnabled === 'boolean') sets.push(sql`mirror_enabled = ${body.mirrorEnabled}`)
  if (typeof body.mirrorSchedule === 'string') sets.push(sql`mirror_schedule = ${body.mirrorSchedule}`)
  if (body.status === 'active' || body.status === 'paused') sets.push(sql`status = ${body.status}`)

  if (sets.length === 0) return NextResponse.json({ ok: true })
  sets.push(sql`updated_at = now()`, sql`updated_by = ${gate.user.id}`)
  await db.execute(sql`update connections set ${sql.join(sets, sql`, `)} where org_id = ${orgId} and id = ${id}`)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  await db.execute(sql`delete from connections where org_id = ${gate.user.orgId} and id = ${id}`)
  return NextResponse.json({ ok: true })
}
