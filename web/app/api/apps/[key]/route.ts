import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { deleteApp, getAppByKey, setAppStatus } from '@/lib/apps/store'

export const runtime = 'nodejs'

/** GET — App details (any user who may use apps). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.use', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const app = await getAppByKey(gate.user.orgId, key)
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ app })
}

/** PATCH — enable/disable an App. */
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const body = (await req.json().catch(() => ({}))) as { status?: string }
  if (body.status !== 'installed' && body.status !== 'disabled') {
    return NextResponse.json({ error: 'status must be "installed" or "disabled"' }, { status: 400 })
  }
  await setAppStatus(gate.user.orgId, key, body.status)
  return NextResponse.json({ ok: true })
}

/** DELETE — uninstall an App (cascades versions, files, storage, run log). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  await deleteApp(gate.user.orgId, key)
  return NextResponse.json({ ok: true })
}
