import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import {
  AppError,
  deleteApp,
  getAppByKey,
  setAppStatus,
} from '@/lib/apps/store'

export const runtime = 'nodejs'

type ObservedAppStatus = 'installed' | 'disabled'

/**
 * setAppStatus / deleteApp return without writing when the scoped row is
 * missing or already in the requested state. A later GET is the proof a
 * mutation happened; this raises that computed refusal instead of {ok:true}.
 */
function refuseAppWrite(input: {
  action: 'status' | 'uninstall'
  key: string
  before: { status: ObservedAppStatus } | null
  requestedStatus?: ObservedAppStatus
  after?: { status: ObservedAppStatus } | null
}): AppError | null {
  const { action, key, before, requestedStatus, after } = input
  if (!before) {
    return new AppError(
      action === 'uninstall'
        ? `App "${key}" was not found in this organization. Confirm the key is installed here before uninstalling.`
        : `App "${key}" was not found in this organization. Install it or GET /api/apps/${key} to confirm the key before changing status.`,
      404,
    )
  }
  if (action === 'status') {
    if (requestedStatus !== 'installed' && requestedStatus !== 'disabled') {
      return new AppError('status must be "installed" or "disabled"', 400)
    }
    if (before.status === requestedStatus) {
      const other = requestedStatus === 'installed' ? 'disabled' : 'installed'
      return new AppError(
        `App "${key}" is already ${requestedStatus}. PATCH status to "${other}" if you need a status change.`,
        409,
      )
    }
    if (after !== undefined && (!after || after.status !== requestedStatus)) {
      return new AppError(
        `App "${key}" status was not changed to ${requestedStatus}. Confirm the app is still visible in this organization and retry.`,
        409,
      )
    }
    return null
  }
  if (after) {
    return new AppError(
      `App "${key}" was not uninstalled. Confirm the app is still visible in this organization and retry.`,
      409,
    )
  }
  return null
}

/** GET — App details (any user who may use apps). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.use', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const app = await getAppByKey(gate.user.orgId, key)
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ app })
}

/** PATCH — enable/disable an App. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as { status?: string }
  if (body.status !== 'installed' && body.status !== 'disabled') {
    return NextResponse.json(
      { error: 'status must be "installed" or "disabled"' },
      { status: 400 },
    )
  }
  try {
    const app = await getAppByKey(gate.user.orgId, key)
    const beforeRefusal = refuseAppWrite({
      action: 'status',
      key,
      before: app,
      requestedStatus: body.status,
    })
    if (beforeRefusal) throw beforeRefusal
    await setAppStatus(gate.user.orgId, gate.user.id, key, body.status)
    const after = await getAppByKey(gate.user.orgId, key)
    const afterRefusal = refuseAppWrite({
      action: 'status',
      key,
      before: app,
      requestedStatus: body.status,
      after,
    })
    if (afterRefusal) throw afterRefusal
  } catch (error) {
    if (error instanceof AppError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
  return NextResponse.json({ ok: true })
}

/** DELETE — uninstall an App (with an append-only evidence snapshot). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  try {
    const app = await getAppByKey(gate.user.orgId, key)
    const beforeRefusal = refuseAppWrite({
      action: 'uninstall',
      key,
      before: app,
    })
    if (beforeRefusal) throw beforeRefusal
    await deleteApp(gate.user.orgId, gate.user.id, key)
    const after = await getAppByKey(gate.user.orgId, key)
    const afterRefusal = refuseAppWrite({
      action: 'uninstall',
      key,
      before: app,
      after,
    })
    if (afterRefusal) throw afterRefusal
  } catch (error) {
    if (error instanceof AppError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
  return NextResponse.json({ ok: true })
}
