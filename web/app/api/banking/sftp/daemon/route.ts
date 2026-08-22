import { NextResponse } from 'next/server'
import { loadDaemonConfig, updateDaemonConfig, hostKeyFingerprint } from '@openbooks/engine/src/sftp/manager.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/** SFTP daemon config + connection details for the UI (no env — all DB-backed). */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const cfg = await loadDaemonConfig()
  const reqHost = new URL(req.url).hostname
  return NextResponse.json({
    enabled: cfg.enabled,
    port: cfg.port,
    host: cfg.advertisedHost || reqHost,
    advertisedHost: cfg.advertisedHost,
    fingerprint: hostKeyFingerprint(cfg.hostKey),
  })
}

/** Configure the daemon (enable/disable, port, advertised host); restarts it live. */
export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean; port?: number; advertisedHost?: string | null }
  if (body.port !== undefined && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) {
    return NextResponse.json({ error: 'port must be between 1 and 65535' }, { status: 400 })
  }
  const cfg = await updateDaemonConfig(
    {
      enabled: body.enabled,
      port: body.port,
      advertisedHost: body.advertisedHost !== undefined ? (body.advertisedHost?.trim() || null) : undefined,
    },
    gate.user.id,
  )
  return NextResponse.json({ ok: true, enabled: cfg.enabled, port: cfg.port, advertisedHost: cfg.advertisedHost })
}
