import { NextResponse } from 'next/server'
import { buildSource, getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Test a connection's credentials without mutating anything: build the adapter
 * and run its cheap `ping()` (falling back to a trial-balance fetch). Returns a
 * friendly ok/error the wizard shows before the tenant commits to a migration.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params

  const conn = await getConnection(gate.user.orgId, id)
  if (!conn) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const source = buildSource(conn)
    if (source.ping) {
      const r = await source.ping()
      return NextResponse.json({ ok: r.ok, detail: r.detail })
    }
    const tb = await source.trialBalance()
    return NextResponse.json({ ok: true, detail: `${tb.length} accounts in trial balance` })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 200 })
  }
}
