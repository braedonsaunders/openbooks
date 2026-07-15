import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { loadSavedSearch, runSavedSearch } from '../../../../../lib/saved-searches'

export const runtime = 'nodejs'

/** Run a saved search fresh and return its ReportRunResult (browse live). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  const search = await loadSavedSearch(user.orgId, id, user.id, permissions)
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const result = await runSavedSearch(user.orgId, search.query)
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Saved search failed' },
      { status: 422 },
    )
  }
}
