import { NextResponse } from 'next/server'
import { enqueueMigration } from '@openbooks/jobs'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Enqueue a migration or mirror pass for this connection onto the worker.
 * Returns immediately with the job id; progress lands in the sync_runs table
 * the platform page renders. One job per (connection, mode) is de-duped so a
 * double click can't launch two backfills.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const { id } = await params

  const conn = await getConnection(orgId, id)
  if (!conn) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (conn.status === 'unconfigured') {
    return NextResponse.json({ error: 'connection has no credentials yet' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: 'full_migration' | 'mirror' }
  const mode = body.mode === 'full_migration' ? 'full_migration' : 'mirror'

  const job = await enqueueMigration(
    { orgId, connectionId: id, mode, triggeredBy: 'ui' },
    { jobId: `migration|${id}|${mode}` },
  )
  return NextResponse.json({ jobId: job.id, mode })
}
