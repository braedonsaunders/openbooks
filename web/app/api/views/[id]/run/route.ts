import { NextResponse } from 'next/server'
import { can, guardPermission } from '../../../../../lib/authz'
import { loadView, runView, viewEntityPermission } from '../../../../../lib/views'

export const runtime = 'nodejs'

/** Run a view fresh and return its ReportRunResult (browse live). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  const view = await loadView(user.orgId, id, user.id, permissions)
  if (!view) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const needed = viewEntityPermission(view.query)
  if (needed && !can(gate, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
  }

  try {
    const result = await runView(user.orgId, view.query)
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'View failed' },
      { status: 422 },
    )
  }
}
