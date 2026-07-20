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
  if (!conn) return NextResponse.json({ errorCode: 'CONNECTION_NOT_FOUND' }, { status: 404 })
  if (conn.status === 'unconfigured') {
    return NextResponse.json({ errorCode: 'CONNECTION_UNCONFIGURED' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: 'full_migration' | 'mirror' | 'attachments' }
  if (!body.mode || !['full_migration', 'mirror', 'attachments'].includes(body.mode)) {
    return NextResponse.json({ errorCode: 'INVALID_MODE' }, { status: 400 })
  }
  if (body.mode === 'attachments' && conn.source !== 'netsuite') {
    return NextResponse.json({ errorCode: 'ATTACHMENTS_UNSUPPORTED' }, { status: 400 })
  }
  const mode = body.mode

  const job = await enqueueMigration(
    { orgId, connectionId: id, mode, triggeredBy: 'ui' },
    { jobId: `migration|${id}|${mode}` },
  )
  return NextResponse.json({ jobId: job.id, mode })
}
