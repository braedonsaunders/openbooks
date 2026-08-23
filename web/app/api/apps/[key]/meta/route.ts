import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { updateAppMeta, AppError, type AppMetaUpdate } from '@/lib/apps/store'

export const runtime = 'nodejs'

/**
 * PATCH — form-driven app settings: name, description, icon, nav visibility,
 * capability grants, and the endpoint map. This is how the manifest changes —
 * users never touch JSON.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as AppMetaUpdate | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  try {
    await updateAppMeta(gate.user.orgId, gate.user.id, key, body)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
