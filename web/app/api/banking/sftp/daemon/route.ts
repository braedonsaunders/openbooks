import { NextResponse } from 'next/server'
import { loadDaemonConfig, hostKeyFingerprint } from '@openbooks/engine/src/sftp/manager.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/**
 * Read-only connection details for the shared SFTP daemon (no env — all
 * DB-backed). The daemon is one global listener serving every tenant, so its
 * configuration is platform super-admin territory at /api/platform/sftp/daemon;
 * this tenant surface only reports how to reach it.
 */
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
