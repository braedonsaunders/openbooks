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

/** PATCH — enable/disable an App.
 *  {ok:true} only after setAppStatus returns this request's UPDATE row
 *  count and that count is greater than zero. */
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
    const written = await setAppStatus(gate.user.orgId, gate.user.id, key, body.status)
    if (!written || written.affectedRows < 1) {
      throw new AppError(
        `App "${key}" status was not changed to ${body.status}. Confirm the app is still visible in this organization and retry.`,
        409,
      )
    }
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

/** DELETE — uninstall an App (with an append-only evidence snapshot).
 *  {ok:true} only after deleteApp returns this request's UPDATE/DELETE
 *  row count and that count is greater than zero. A history-preserving
 *  uninstall that disables the row is that successful write. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  try {
    const written = await deleteApp(gate.user.orgId, gate.user.id, key)
    if (!written || written.affectedRows < 1) {
      throw new AppError(
        `App "${key}" was not uninstalled. Confirm the app is still visible in this organization and retry.`,
        409,
      )
    }
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
