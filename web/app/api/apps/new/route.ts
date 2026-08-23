import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { createAppScaffold, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

/** POST — create a ready-to-open starter app from just a name. No JSON, no upload. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { name?: string }
  if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  try {
    const { key } = await createAppScaffold(gate.user.orgId, gate.user.id, body.name)
    return NextResponse.json({ ok: true, key })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
