import { NextResponse } from 'next/server'
import { guardPermission } from '../../../lib/authz'
import { createView, loadViews } from '../../../lib/views'

export const runtime = 'nodejs'

/** List the views visible to the caller (own private + shared). */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const rows = await loadViews(user.orgId, user.id, permissions)
  return NextResponse.json({ views: rows })
}

/** Instant-into-draft: create a private draft owned by the caller. */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as { name?: string }
  const created = await createView({ orgId: user.orgId, userId: user.id, name: body.name })
  return NextResponse.json({ id: created.id, slug: created.slug }, { status: 201 })
}
