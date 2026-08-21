import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { guardReportEntity } from '../../../../../../lib/report-authz'
import { blobResponse } from '../../../../../../lib/blob-response'

export const runtime = 'nodejs'

/** Serve the immutable rendered artifact retained for a scheduled run. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const result = (await db.execute<{ filename: string; content_type: string; bytes: Buffer; content_hash: string; query: unknown }>(sql`
    select a.filename, a.content_type, a.bytes, a.content_hash, def.query
      from report_run_artifacts a
      join report_runs r on r.id=a.run_id and r.org_id=a.org_id
      join report_definitions def on def.id = r.definition_id and def.org_id = r.org_id
     where r.id=${id} and r.org_id=${gate.user.orgId}
  `))
  const row = result.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardReportEntity(gate, row.query)
  if (denied) return denied
  return blobResponse(req, {
    filename: row.filename,
    contentType: row.content_type,
    bytes: Buffer.from(row.bytes),
    versionId: row.content_hash,
  }, { immutable: true, fallbackName: 'scheduled-report.pdf' })
}
