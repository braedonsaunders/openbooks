import { NextResponse } from 'next/server'
import { can } from '@/lib/authz'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { runBridgeMethod } from '@/lib/apps/store'

export const runtime = 'nodejs'

/**
 * POST — relay a single bridge call from a sandboxed App frontend. The AppFrame
 * forwards { method, payload } here; this route re-authenticates the real user,
 * enforces apps.use, and (for records) enforces app-granted ∩ user permissions
 * before running anything. The sandbox never reaches the DB except through the
 * org-scoped adapters wired in runBridgeMethod.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.use', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const body = (await req.json().catch(() => ({}))) as { method?: string; payload?: unknown }
  if (typeof body.method !== 'string') {
    return NextResponse.json({ error: 'method required' }, { status: 400 })
  }

  const res = await runBridgeMethod({
    orgId: gate.user.orgId,
    user: gate.user,
    key,
    method: body.method,
    payload: body.payload ?? {},
    userCan: (perm) => can(gate, perm),
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  })

  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status })
  return NextResponse.json({ ok: true, result: res.result })
}
